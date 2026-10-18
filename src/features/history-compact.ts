/**
 * Deterministic history compaction fallback.
 *
 * `history_compact` reads a persisted session through the sessionQuery service
 * and folds its events into a small Markdown report: the original goal, one
 * progress line per turn, the current state, and a deterministic checklist for
 * resuming. No model call is made, so the result is reproducible and can be
 * used when a model-written summary fails or exceeds its budget.
 *
 * The compaction budget is expressed in characters. When the full report is
 * too large, older progress lines are dropped first; the Goal and Current
 * state sections are only shortened with an explicit truncation marker as a
 * last resort.
 */

import type {
  PluginContext,
  SuperDshConfig,
  ToolDefinitionLike,
  ToolExecutionLike,
} from '../plugin-types.ts'
import { sessionIdOf } from '../session-id.ts'
import { warn } from '../shared.ts'

type HistoryCompactConfig = SuperDshConfig & {
  /** Register the history_compact fallback tool. Default: true. */
  historyCompact?: boolean
}

interface SessionQueryLike {
  readSession(sessionId: string): Promise<unknown>
}

interface CompactToolCall {
  /** Tool name exactly as recorded in the event. */
  name: string
  /** Lowercase last path segment, so `tool:write` and `write` compare equal. */
  normalizedName: string
  callId: string | undefined
  /** Parsed JSON arguments, when the raw arguments were a JSON object. */
  arguments: Record<string, unknown> | undefined
  /** Original argument value: object, JSON string, or unparseable text. */
  rawArguments: unknown
}

interface CompactToolError {
  tool: string
  message: string
}

interface CompactTurn {
  turn: number
  request: string | undefined
  assistant: string | undefined
  toolCounts: Map<string, number>
  files: string[]
  errors: CompactToolError[]
  /** Rendered turn/end reason when the turn did not complete. */
  endReason: string | undefined
}

interface UnfinishedTurn {
  turn: number
  issue: string
}

interface CompactAnalysis {
  goal: string
  turns: CompactTurn[]
  lastAssistant: string
  unresolvedErrors: CompactToolError[]
  files: string[]
  recentFiles: string[]
  unfinished: UnfinishedTurn[]
}

interface CurrentStateLimits {
  assistantChars: number
  errors: number
  errorChars: number
  files: number
  unfinished: number
}

export const DEFAULT_COMPACT_MAX_CHARS = 4000
export const MIN_COMPACT_MAX_CHARS = 500
export const MAX_COMPACT_MAX_CHARS = 20000

const FILE_TOOLS = new Set(['write', 'edit', 'fuzzy_edit', 'apply_patch'])
const RECENT_TURN_LIMIT = 5
const TRUNCATION_MARKER = ' … truncated'

export function applyHistoryCompact(
  ctx: PluginContext,
  config: HistoryCompactConfig = {},
): void {
  if (config.historyCompact === false) return

  ctx.systemPrompt.section({
    name: 'super-dsh:history-compact',
    order: 151,
    text: 'Use `history_compact` when history must be folded without a model call: it returns a deterministic '
      + 'Markdown summary (goal, per-turn progress, current state, next steps) with an explicit character budget. '
      + 'Requires the sessionQuery service.',
  })

  const historyCompactTool: ToolDefinitionLike = {
    name: 'history_compact',
    description: 'Compact a persisted session into deterministic Markdown: the original goal, one line of progress '
      + 'per turn, current state, and three next steps. Older turns are dropped before the goal or current state '
      + 'is truncated. Requires the sessionQuery service. No model call is made.',
    parameters: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Session to compact. Omit to use the current agent session.',
        },
        max_chars: {
          type: 'integer',
          description: `Character budget for the summary (${MIN_COMPACT_MAX_CHARS}..${MAX_COMPACT_MAX_CHARS}). Default: ${DEFAULT_COMPACT_MAX_CHARS}.`,
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          stats: {
            type: 'object',
            properties: {
              events: { type: 'integer' },
              turns: { type: 'integer' },
              original_chars: { type: 'integer' },
              compact_chars: { type: 'integer' },
              ratio: { type: 'number' },
            },
            required: ['events', 'turns', 'original_chars', 'compact_chars', 'ratio'],
            additionalProperties: false,
          },
        },
        required: ['summary', 'stats'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const stats = value.stats as { original_chars?: number; compact_chars?: number; ratio?: number }
        return [{
          type: 'text',
          text: `${String(value.summary)}\n\n---\nCompacted ${String(stats.compact_chars ?? '?')}/${String(stats.original_chars ?? '?')} chars `
            + `(ratio ${String(stats.ratio ?? '?')}).`,
        }]
      },
    },
    async execute(rawArgs: Record<string, unknown>, exec: ToolExecutionLike) {
      // Check the service before the id so the failure names the real cause.
      const service = sessionQueryOf(ctx)
      const requested = typeof rawArgs.session_id === 'string' ? rawArgs.session_id.trim() : ''
      const sessionId = requested.length > 0 ? requested : sessionIdOf(exec.agent)
      if (sessionId === undefined || sessionId.length === 0) {
        throw new Error('history_compact: no session id is available; pass session_id or call the tool from an agent session')
      }

      let snapshot: unknown
      try {
        snapshot = await service.readSession(sessionId)
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(`history_compact: could not read session "${sessionId}": ${detail}`)
      }

      const events = eventsOf(snapshot)
      if (events === undefined) {
        throw new Error(`history_compact: sessionQuery.readSession returned no event list for session "${sessionId}"`)
      }

      const analysis = analyzeEvents(events)
      const summary = renderCompact(analysis, rawArgs.max_chars)
      const originalChars = serializedChars(events)
      return {
        summary,
        stats: {
          events: events.length,
          turns: analysis.turns.length,
          original_chars: originalChars,
          compact_chars: summary.length,
          ratio: originalChars === 0 ? 0 : round3(summary.length / originalChars),
        },
      }
    },
  }

  try {
    ctx.tools.register(historyCompactTool)
  } catch (error: unknown) {
    warn(ctx.logger, 'could not register history_compact', error)
  }
}

/**
 * Pure compaction entry point: events in, deterministic Markdown out.
 * The budget is clamped to [500, 20000] characters, default 4000.
 */
export function compactEvents(
  events: readonly unknown[],
  maxChars: number = DEFAULT_COMPACT_MAX_CHARS,
): string {
  return renderCompact(analyzeEvents(events), maxChars)
}

function sessionQueryOf(ctx: PluginContext): SessionQueryLike {
  const service = ctx.get?.('sessionQuery')
  const record = asRecord(service)
  if (record === undefined || typeof record.readSession !== 'function') {
    throw new Error('history_compact requires the sessionQuery service, but it is not available in this harness')
  }
  return service as SessionQueryLike
}

function eventsOf(snapshot: unknown): unknown[] | undefined {
  if (Array.isArray(snapshot)) return snapshot as unknown[]
  const record = asRecord(snapshot)
  if (record !== undefined && Array.isArray(record.events)) return record.events as unknown[]
  return undefined
}

function analyzeEvents(events: readonly unknown[]): CompactAnalysis {
  const turns = new Map<number, CompactTurn>()
  const callInfo = new Map<string, { turn: number; name: string }>()
  const results: Array<{
    tool: string | undefined
    normalizedTool: string | undefined
    isError: boolean
    message: string
  }> = []
  const unfinished: UnfinishedTurn[] = []
  const fileLastTouch = new Map<string, number>()
  const files: string[] = []
  let goal = ''
  let lastAssistant = ''
  let currentTurn: number | undefined
  let lastTurn = 0
  let touchSeq = 0

  const groupOf = (turn: number): CompactTurn => {
    let existing = turns.get(turn)
    if (existing === undefined) {
      existing = {
        turn,
        request: undefined,
        assistant: undefined,
        toolCounts: new Map<string, number>(),
        files: [],
        errors: [],
        endReason: undefined,
      }
      turns.set(turn, existing)
    }
    return existing
  }

  const noteTurn = (turn: number): void => {
    lastTurn = Math.max(lastTurn, turn)
    currentTurn = turn
  }

  for (const raw of events) {
    const event = asRecord(raw)
    if (event === undefined || typeof event.type !== 'string') continue
    const data = asRecord(event.data)
    const explicitTurn = turnNumberOf(event, data)

    if (event.type === 'turn/start') {
      const turn = explicitTurn ?? lastTurn + 1
      noteTurn(turn)
      groupOf(turn)
      continue
    }

    if (event.type === 'user/message') {
      const text = messageText(data).trim()
      if (text.length === 0 || isInjectedContext(text)) continue
      const turn = explicitTurn ?? currentTurn ?? lastTurn + 1
      noteTurn(turn)
      const turnGroup = groupOf(turn)
      if (goal.length === 0) goal = text
      if (turnGroup.request === undefined) turnGroup.request = text
      continue
    }

    if (event.type === 'assistant/message') {
      const text = messageText(data)
      if (text.length === 0) continue
      const turn = explicitTurn ?? currentTurn ?? (lastTurn > 0 ? lastTurn : 1)
      noteTurn(turn)
      groupOf(turn).assistant = text
      lastAssistant = text
      continue
    }

    if (event.type === 'tool/call') {
      const call = toolCallOf(data)
      if (call === undefined) continue
      const turn = explicitTurn ?? currentTurn ?? (lastTurn > 0 ? lastTurn : 1)
      noteTurn(turn)
      const turnGroup = groupOf(turn)
      turnGroup.toolCounts.set(call.name, (turnGroup.toolCounts.get(call.name) ?? 0) + 1)
      if (FILE_TOOLS.has(call.normalizedName)) {
        for (const path of filePathsOf(call)) {
          if (!fileLastTouch.has(path)) files.push(path)
          fileLastTouch.set(path, ++touchSeq)
          if (!turnGroup.files.includes(path)) turnGroup.files.push(path)
        }
      }
      if (call.callId !== undefined) callInfo.set(call.callId, { turn, name: call.name })
      continue
    }

    if (event.type === 'tool/result') {
      const isError = isErrorResult(event, data)
      const message = asRecord(data?.message)
      const callId = firstString(
        data?.callId,
        message?.toolCallId,
        message?.callId,
        data?.toolCallId,
        asRecord(message?.source)?.callId,
      )
      const info = callId === undefined ? undefined : callInfo.get(callId)
      const directTool = firstString(data?.name, data?.toolName, message?.name)
      const tool = directTool ?? info?.name
      const errorMessage = isError ? toolErrorText(event, data) : ''
      results.push({
        tool,
        normalizedTool: tool === undefined ? undefined : normalizeToolName(tool),
        isError,
        message: errorMessage,
      })
      if (isError) {
        const turn = explicitTurn ?? info?.turn ?? currentTurn ?? (lastTurn > 0 ? lastTurn : 1)
        noteTurn(turn)
        groupOf(turn).errors.push({
          tool: tool ?? 'unknown tool',
          message: errorMessage.length > 0 ? errorMessage : 'tool reported an error',
        })
      }
      continue
    }

    if (event.type === 'turn/end') {
      const turn = explicitTurn ?? currentTurn ?? (lastTurn > 0 ? lastTurn : 1)
      lastTurn = Math.max(lastTurn, turn)
      const turnGroup = groupOf(turn)
      const reason = turnEndReasonOf(data)
      if (reason !== undefined) {
        const issue = `Turn ${turn} ended with \`${reason.kind}\`${reason.detail === undefined ? '' : `: ${clip(reason.detail, 300)}`}`
        turnGroup.endReason = issue
        unfinished.push({ turn, issue })
      }
      currentTurn = undefined
    }
  }

  const unresolvedErrors: CompactToolError[] = []
  results.forEach((result, index) => {
    if (!result.isError) return
    const resolved = results.some((later, laterIndex) =>
      laterIndex > index
      && !later.isError
      && later.normalizedTool !== undefined
      && later.normalizedTool === result.normalizedTool)
    if (resolved) return
    unresolvedErrors.push({
      tool: result.tool ?? 'unknown tool',
      message: result.message.length > 0 ? result.message : 'tool reported an error',
    })
  })

  const recentFiles = [...files]
    .sort((left, right) => (fileLastTouch.get(left) ?? 0) - (fileLastTouch.get(right) ?? 0) || compareText(left, right))
    .slice(-10)

  return {
    goal: goal.trim(),
    turns: [...turns.values()].sort((left, right) => left.turn - right.turn),
    lastAssistant: lastAssistant.trim(),
    unresolvedErrors,
    files,
    recentFiles,
    unfinished,
  }
}

function renderCompact(analysis: CompactAnalysis, rawMaxChars: unknown): string {
  const maxChars = clampMaxChars(rawMaxChars)
  const goal = clip(analysis.goal, 500)
  const progressLines = analysis.turns.map(progressLine)
  const stateLines = renderCurrentState(analysis, {
    assistantChars: 800,
    errors: 5,
    errorChars: 300,
    files: 10,
    unfinished: 5,
  })
  const steps = buildNextSteps(analysis)

  const full = renderDocument(goal, progressLines, stateLines, steps)
  if (full.length <= maxChars) return full

  // First reduction: keep the goal, the most recent five turns, current state,
  // and next steps. The omission marker is dropped again when it alone does
  // not fit, so the five most recent turns survive as long as possible.
  let lines = progressLines.slice(-RECENT_TURN_LIMIT)
  for (;;) {
    const omitted = progressLines.length - lines.length
    const marker = omitted > 0 ? [`- … ${omitted} older turn(s) omitted for budget`] : []
    const withMarker = renderDocument(goal, marker.length > 0 ? [...lines, ...marker] : lines, stateLines, steps)
    if (withMarker.length <= maxChars) return withMarker
    if (marker.length > 0) {
      const withoutMarker = renderDocument(goal, lines, stateLines, steps)
      if (withoutMarker.length <= maxChars) return withoutMarker
    }
    if (lines.length === 0) break
    lines = lines.slice(1)
  }

  const omittedProgress = renderDocument(
    goal,
    ['_Progress omitted for budget._'],
    stateLines,
    steps,
  )
  if (omittedProgress.length <= maxChars) return omittedProgress

  // Last resort before a hard clip: shorten the goal and current state but
  // keep both readable, with an explicit truncation marker.
  const clippedGoal = clipMarked(goal, 240)
  const clippedState = renderCurrentState(analysis, {
    assistantChars: 300,
    errors: 2,
    errorChars: 160,
    files: 5,
    unfinished: 2,
  })
  const clipped = renderDocument(
    clippedGoal,
    ['_Progress omitted for budget._'],
    clippedState,
    steps,
  )
  if (clipped.length <= maxChars) return clipped

  const minimalState = [
    `**Last assistant message:** ${analysis.lastAssistant.length > 0
      ? clipMarked(analysis.lastAssistant, 110)
      : '_No assistant message recorded._'}`,
  ]
  const minimal = renderDocument(
    clipMarked(goal, 90),
    ['_Progress omitted for budget._'],
    minimalState,
    buildMinimalNextSteps(analysis),
  )
  if (minimal.length <= maxChars) return minimal

  // Practically unreachable for maxChars >= 500; still preserve the hard
  // budget instead of returning an oversized summary.
  return `${minimal.slice(0, Math.max(0, maxChars - ' … truncated'.length))}… truncated`
}

function renderDocument(
  goal: string,
  progressLines: readonly string[],
  stateLines: readonly string[],
  steps: readonly string[],
): string {
  return [
    '## Goal',
    '',
    goal.length > 0 ? goal : '_No user request recorded._',
    '',
    '## Progress',
    '',
    ...(progressLines.length > 0 ? progressLines : ['_No turn progress recorded._']),
    '',
    '## Current state',
    '',
    ...stateLines,
    '',
    '## Next steps',
    '',
    ...steps.map(step => `- ${step}`),
    '',
  ].join('\n')
}

function progressLine(turn: CompactTurn): string {
  const tools = [...turn.toolCounts.entries()]
    .sort((left, right) => right[1] - left[1] || compareText(left[0], right[0]))
    .map(([name, count]) => `${name}×${count}`)
    .join(', ') || '(none)'
  const files = turn.files.map(path => `\`${clip(path, 120)}\``).join(', ') || '(none)'
  const errors = turn.errors
    .slice(0, 3)
    .map(error => `${error.tool}: ${clip(oneLine(error.message), 160)}`)
    .join('; ') || '(none)'
  const request = turn.request === undefined ? '(none)' : `"${clip(oneLine(turn.request), 200)}"`
  const assistant = turn.assistant === undefined ? '(none)' : `"${clip(oneLine(turn.assistant), 300)}"`
  return `- Turn ${turn.turn}: user: ${request} | assistant: ${assistant} | tools: ${tools} | files: ${files} | errors: ${errors}`
}

function renderCurrentState(analysis: CompactAnalysis, limits: CurrentStateLimits): string[] {
  const lines: string[] = []
  lines.push(`**Last assistant message:** ${analysis.lastAssistant.length > 0
    ? clip(analysis.lastAssistant, limits.assistantChars)
    : '_No assistant message recorded._'}`)

  lines.push('', '**Unresolved errors:**')
  if (analysis.unresolvedErrors.length === 0) {
    lines.push('- None.')
  } else {
    for (const error of analysis.unresolvedErrors.slice(0, limits.errors)) {
      lines.push(`- \`${error.tool}\`: ${clip(oneLine(error.message), limits.errorChars)}`)
    }
  }

  lines.push('', '**Recent files:**')
  if (analysis.recentFiles.length === 0) {
    lines.push('- None.')
  } else {
    for (const path of analysis.recentFiles.slice(-limits.files)) {
      lines.push(`- \`${clip(path, 200)}\``)
    }
  }

  lines.push('', '**Unfinished turns:**')
  if (analysis.unfinished.length === 0) {
    lines.push('- None.')
  } else {
    for (const unfinished of analysis.unfinished.slice(-limits.unfinished)) {
      lines.push(`- ${clip(unfinished.issue, 300)}`)
    }
  }

  return lines
}

function buildNextSteps(analysis: CompactAnalysis): string[] {
  const latestUnfinished = analysis.unfinished[analysis.unfinished.length - 1]
  const firstError = analysis.unresolvedErrors[0]
  const latestFile = analysis.recentFiles[analysis.recentFiles.length - 1]
  const steps: string[] = []

  if (latestUnfinished !== undefined) {
    steps.push(`Resume or close the unfinished turn (${clip(oneLine(latestUnfinished.issue), 160)}).`)
  } else if (firstError !== undefined) {
    steps.push(`Fix the outstanding \`${firstError.tool}\` error: ${clip(oneLine(firstError.message), 120)}`)
  } else {
    steps.push('Confirm the goal above is still accurate before starting new work.')
  }

  if (firstError !== undefined && !steps[0]?.includes(firstError.tool)) {
    steps.push(`Re-run the failing \`${firstError.tool}\` call and change approach if it fails again.`)
  } else if (latestFile !== undefined) {
    steps.push(`Re-read \`${latestFile}\` before editing it again.`)
  } else {
    steps.push('Review the progress above and choose the next concrete action.')
  }

  if (analysis.files.length > 0) {
    const fileCount = `${analysis.files.length} changed ${analysis.files.length === 1 ? 'file' : 'files'}`
    steps.push(`Run the project's tests, lint, or typecheck to verify the ${fileCount}.`)
  } else {
    steps.push("Run the project's verification command (tests, lint, or typecheck) before finishing.")
  }

  return steps
}

function buildMinimalNextSteps(analysis: CompactAnalysis): string[] {
  return [
    analysis.unfinished.length > 0
      ? 'Resume the unfinished turn before continuing.'
      : analysis.unresolvedErrors.length > 0
        ? 'Fix the outstanding tool error and retry.'
        : 'Confirm the goal above is still accurate.',
    analysis.files.length > 0
      ? 'Re-read the latest changed file before editing.'
      : 'Review the progress and pick the next action.',
    'Run tests/lint/typecheck before finishing.',
  ]
}

function clampMaxChars(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_COMPACT_MAX_CHARS
  return Math.min(MAX_COMPACT_MAX_CHARS, Math.max(MIN_COMPACT_MAX_CHARS, Math.floor(value)))
}

function clipMarked(text: string, max: number): string {
  if (text.length <= max) return text
  const budget = Math.max(0, max - TRUNCATION_MARKER.length)
  return `${text.slice(0, budget)}${TRUNCATION_MARKER}`
}

function serializedChars(value: unknown): number {
  try {
    const text = JSON.stringify(value)
    return typeof text === 'string' ? text.length : 0
  } catch {
    return 0
  }
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

function turnNumberOf(
  event: Record<string, unknown>,
  data: Record<string, unknown> | undefined,
): number | undefined {
  for (const value of [data?.turn, event.turn]) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value)
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim())
  }
  return undefined
}

function toolCallOf(data: Record<string, unknown> | undefined): CompactToolCall | undefined {
  if (data === undefined) return undefined
  const message = asRecord(data.message)
  const name = firstString(message?.name, data.name, data.toolName, message?.toolName)
  if (name === undefined) return undefined

  const rawArguments = message?.arguments ?? data.arguments ?? message?.input ?? data.input ?? data.args
  let args: Record<string, unknown> | undefined
  if (typeof rawArguments === 'string') {
    try {
      args = asRecord(JSON.parse(rawArguments))
    } catch {
      args = undefined
    }
  } else {
    args = asRecord(rawArguments)
  }

  return {
    name,
    normalizedName: normalizeToolName(name),
    callId: firstString(data.callId, message?.toolCallId, message?.callId, data.toolCallId),
    arguments: args,
    rawArguments,
  }
}

function normalizeToolName(name: string): string {
  const lowered = name.toLowerCase()
  const separator = lowered.lastIndexOf(':')
  return separator === -1 ? lowered : lowered.slice(separator + 1)
}

function filePathsOf(call: CompactToolCall): string[] {
  const paths: string[] = []
  for (const key of ['file_path', 'filePath', 'path', 'target_file', 'targetFile']) {
    const value = call.arguments?.[key]
    if (typeof value === 'string' && value.trim().length > 0) paths.push(value.trim())
  }

  const edits = call.arguments?.edits
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      const record = asRecord(edit)
      for (const key of ['file_path', 'filePath', 'path']) {
        const value = record?.[key]
        if (typeof value === 'string' && value.trim().length > 0) paths.push(value.trim())
      }
    }
  }

  if (call.normalizedName === 'apply_patch') {
    const patchTexts: string[] = []
    if (typeof call.rawArguments === 'string') patchTexts.push(call.rawArguments)
    for (const key of ['input', 'patch', 'diff', 'content', 'text']) {
      const value = call.arguments?.[key]
      if (typeof value === 'string') patchTexts.push(value)
    }
    for (const text of patchTexts) {
      for (const pattern of [
        /^\*\*\* (?:Add|Update|Delete) File:\s*(.+?)\s*$/gm,
        /^\*\*\* Move to:\s*(.+?)\s*$/gm,
      ]) {
        for (const match of text.matchAll(pattern)) {
          if (match[1] !== undefined && match[1].length > 0) paths.push(match[1].trim())
        }
      }
    }
  }

  return paths
}

function isInjectedContext(text: string): boolean {
  return text.startsWith('Current runtime context')
    || text.includes('<system-reminder>')
    || text.includes('<available_skills>')
    || text.startsWith('A skill is a reusable set of task-specific instructions')
}

function isErrorResult(
  event: Record<string, unknown>,
  data: Record<string, unknown> | undefined,
): boolean {
  if (event.isError === true) return true
  if (data === undefined) return false
  if (data.isError === true) return true
  if (asRecord(data.message)?.isError === true) return true
  return data.error !== undefined && data.error !== null
}

function toolErrorText(
  event: Record<string, unknown>,
  data: Record<string, unknown> | undefined,
): string {
  const message = asRecord(data?.message)
  const structured = errorText(data?.error) || errorText(event.error)
  const content = contentText(message?.content) || contentText(data?.content) || contentText(data?.message)
  return structured.length > 0 ? structured : content
}

function errorText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  const record = asRecord(value)
  if (record === undefined) return ''
  for (const key of ['reason', 'message', 'detail', 'error']) {
    const text = record[key]
    if (typeof text === 'string' && text.trim().length > 0) return text.trim()
  }
  const code = firstString(record.code, record.name)
  return code ?? ''
}

function turnEndReasonOf(
  data: Record<string, unknown> | undefined,
): { kind: string; detail: string | undefined } | undefined {
  if (data === undefined) return undefined
  const reason = data.reason
  const reasonRecord = asRecord(reason)
  const kind = typeof reason === 'string'
    ? reason
    : firstString(reasonRecord?.kind, reasonRecord?.type)
  if (kind === undefined || kind === 'completed') return undefined
  const detail = firstString(asRecord(reasonRecord?.error)?.message, reasonRecord?.message, reasonRecord?.detail)
  return { kind, detail }
}

function messageText(data: Record<string, unknown> | undefined): string {
  if (data === undefined) return ''
  const message = asRecord(data.message)
  for (const content of [message?.content, data.content, data.message, data.text]) {
    const text = contentText(content)
    if (text.length > 0) return text
  }
  return ''
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    const record = asRecord(block)
    if (record?.type !== 'text' || typeof record.text !== 'string') continue
    if (record.text.trim().length > 0) parts.push(record.text)
  }
  return parts.join('\n').trim()
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

function oneLine(text: string): string {
  return text.replace(/\r?\n/g, ' ').trim()
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
