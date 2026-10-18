/**
 * Deterministic session reflection.
 *
 * `reflect` reads a persisted session through the sessionQuery service and
 * produces a reproducible Markdown review plus rule-based suggestions. It
 * counts tool usage, groups repeated identical calls (same tool, same
 * canonical arguments), aggregates tool errors, lists touched files, reports
 * unfinished turns, and checks whether a verification command was observed.
 *
 * No model call is made: every sentence in the report is derived from the
 * recorded events.
 */

import type {
  PluginContext,
  SuperDshConfig,
  ToolDefinitionLike,
  ToolExecutionLike,
} from '../plugin-types.ts'
import { sessionIdOf } from '../session-id.ts'
import { canonicalJson, sha256, warn } from '../shared.ts'

type ReflectionConfig = SuperDshConfig & {
  /** Register the reflect tool. Default: true. */
  reflection?: boolean
}

interface SessionQueryLike {
  readSession(sessionId: string): Promise<unknown>
}

interface ReflectionToolCall {
  name: string
  normalizedName: string
  callId: string | undefined
  arguments: Record<string, unknown> | undefined
  rawArguments: unknown
}

interface ReflectionToolError {
  tool: string
  normalizedTool: string
  message: string
}

interface RepeatedCall {
  tool: string
  count: number
  canonicalArguments: string
}

interface AggregatedError {
  tool: string
  message: string
  count: number
}

interface UnfinishedTurn {
  turn: number
  kind: string
  detail: string | undefined
}

interface VerificationInfo {
  observed: boolean
  commands: string[]
}

interface ReflectionAnalysis {
  toolCounts: Array<[string, number]>
  repeated: RepeatedCall[]
  errorGroups: AggregatedError[]
  totalErrors: number
  files: string[]
  unfinished: UnfinishedTurn[]
  verification: VerificationInfo
}

const FILE_TOOLS = new Set(['write', 'edit', 'fuzzy_edit', 'apply_patch'])
const COMMAND_TOOLS = new Set(['bash', 'shell', 'pwsh', 'powershell', 'cmd', 'run_command'])
const VERIFICATION_TOKENS = ['test', 'lint', 'typecheck', 'build', 'check']
const MAX_REPEATED_DISPLAY = 10
const MAX_ERRORS_DISPLAY = 5
const MAX_COMMANDS_DISPLAY = 5

export function applyReflection(ctx: PluginContext, config: ReflectionConfig = {}): void {
  if (config.reflection === false) return

  ctx.systemPrompt.section({
    name: 'super-dsh:reflection',
    order: 152,
    text: 'Use `reflect` after a session or before retrying: it returns a deterministic Markdown review of tool '
      + 'usage, repeated identical calls, aggregated errors, touched files, unfinished turns, and verification '
      + 'coverage. Requires the sessionQuery service. No model call is made.',
  })

  const reflectTool: ToolDefinitionLike = {
    name: 'reflect',
    description: 'Review a persisted session deterministically: tool-call counts, repeated identical calls, '
      + 'aggregated tool errors, touched files, unfinished turns, whether verification was observed, and '
      + 'rule-based suggestions. Requires the sessionQuery service. No model call is made.',
    parameters: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Session to review. Omit to use the current agent session.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          markdown: { type: 'string' },
          suggestions: {
            type: 'array',
            items: { type: 'string' },
          },
          stats: {
            type: 'object',
            properties: {
              events: { type: 'integer' },
              toolCalls: { type: 'integer' },
              toolErrors: { type: 'integer' },
              repeatedCalls: { type: 'integer' },
              files: { type: 'integer' },
              unfinishedTurns: { type: 'integer' },
            },
            required: ['events', 'toolCalls', 'toolErrors', 'repeatedCalls', 'files', 'unfinishedTurns'],
            additionalProperties: false,
          },
        },
        required: ['markdown', 'suggestions', 'stats'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: String(value.markdown) }],
    },
    async execute(rawArgs: Record<string, unknown>, exec: ToolExecutionLike) {
      // Check the service before the id so the failure names the real cause.
      const service = sessionQueryOf(ctx)
      const requested = typeof rawArgs.session_id === 'string' ? rawArgs.session_id.trim() : ''
      const sessionId = requested.length > 0 ? requested : sessionIdOf(exec.agent)
      if (sessionId === undefined || sessionId.length === 0) {
        throw new Error('reflect: no session id is available; pass session_id or call the tool from an agent session')
      }

      let snapshot: unknown
      try {
        snapshot = await service.readSession(sessionId)
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(`reflect: could not read session "${sessionId}": ${detail}`)
      }

      const events = eventsOf(snapshot)
      if (events === undefined) {
        throw new Error(`reflect: sessionQuery.readSession returned no event list for session "${sessionId}"`)
      }

      const analysis = analyzeEvents(events)
      return {
        markdown: renderMarkdown(events.length, analysis),
        suggestions: buildSuggestions(analysis),
        stats: {
          events: events.length,
          toolCalls: countToolCalls(analysis),
          toolErrors: analysis.totalErrors,
          repeatedCalls: analysis.repeated.length,
          files: analysis.files.length,
          unfinishedTurns: analysis.unfinished.length,
        },
      }
    },
  }

  try {
    ctx.tools.register(reflectTool)
  } catch (error: unknown) {
    warn(ctx.logger, 'could not register reflect', error)
  }
}

function sessionQueryOf(ctx: PluginContext): SessionQueryLike {
  const service = ctx.get?.('sessionQuery')
  const record = asRecord(service)
  if (record === undefined || typeof record.readSession !== 'function') {
    throw new Error('reflect requires the sessionQuery service, but it is not available in this harness')
  }
  return service as SessionQueryLike
}

function eventsOf(snapshot: unknown): unknown[] | undefined {
  if (Array.isArray(snapshot)) return snapshot as unknown[]
  const record = asRecord(snapshot)
  if (record !== undefined && Array.isArray(record.events)) return record.events as unknown[]
  return undefined
}

function analyzeEvents(events: readonly unknown[]): ReflectionAnalysis {
  const calls: ReflectionToolCall[] = []
  const rawErrors: ReflectionToolError[] = []
  const callNames = new Map<string, string>()
  const files: string[] = []
  const seenFiles = new Set<string>()
  const unfinished: UnfinishedTurn[] = []
  const commands: string[] = []
  let verifyToolCalled = false

  for (const raw of events) {
    const event = asRecord(raw)
    if (event === undefined || typeof event.type !== 'string') continue
    const data = asRecord(event.data)

    if (event.type === 'tool/call') {
      const call = toolCallOf(data)
      if (call === undefined) continue
      calls.push(call)
      if (call.callId !== undefined) callNames.set(call.callId, call.name)

      if (FILE_TOOLS.has(call.normalizedName)) {
        for (const path of filePathsOf(call)) {
          if (seenFiles.has(path)) continue
          seenFiles.add(path)
          files.push(path)
        }
      }

      if (COMMAND_TOOLS.has(call.normalizedName)) {
        const command = commandOf(call)
        if (command !== undefined && isVerificationCommand(command)) {
          const normalized = oneLine(command)
          if (!commands.includes(normalized)) commands.push(normalized)
        }
      }
      if (call.normalizedName === 'verify') verifyToolCalled = true
      continue
    }

    if (event.type === 'tool/result') {
      if (!isErrorResult(event, data)) continue
      const message = asRecord(data?.message)
      const callId = firstString(
        data?.callId,
        message?.toolCallId,
        message?.callId,
        data?.toolCallId,
        asRecord(message?.source)?.callId,
      )
      const directTool = firstString(data?.name, data?.toolName, message?.name)
      const tool = directTool ?? (callId === undefined ? undefined : callNames.get(callId)) ?? 'unknown tool'
      const text = toolErrorText(event, data)
      rawErrors.push({
        tool,
        normalizedTool: normalizeToolName(tool),
        message: text.length > 0 ? oneLine(text) : 'tool reported an error',
      })
      continue
    }

    if (event.type === 'turn/end') {
      const reason = turnEndReasonOf(data)
      if (reason === undefined) continue
      unfinished.push({
        turn: turnNumberOf(event, data) ?? 1,
        kind: reason.kind,
        detail: reason.detail,
      })
    }
  }

  const toolCountMap = new Map<string, number>()
  for (const call of calls) {
    toolCountMap.set(call.name, (toolCountMap.get(call.name) ?? 0) + 1)
  }
  const toolCounts = [...toolCountMap.entries()]
    .sort((left, right) => right[1] - left[1] || compareText(left[0], right[0]))

  const signatureMap = new Map<string, RepeatedCall>()
  for (const call of calls) {
    const canonical = canonicalArguments(call)
    const signature = `${call.normalizedName}\u0000${sha256(canonical)}`
    const existing = signatureMap.get(signature)
    if (existing === undefined) {
      signatureMap.set(signature, {
        tool: call.name,
        count: 1,
        canonicalArguments: canonical,
      })
    } else {
      existing.count += 1
    }
  }
  const repeated = [...signatureMap.values()]
    .filter(call => call.count >= 2)
    .sort((left, right) =>
      right.count - left.count
      || compareText(left.tool, right.tool)
      || compareText(left.canonicalArguments, right.canonicalArguments))

  const errorMap = new Map<string, AggregatedError>()
  for (const error of rawErrors) {
    const message = oneLine(error.message)
    const key = `${error.normalizedTool}\u0000${message}`
    const existing = errorMap.get(key)
    if (existing === undefined) {
      errorMap.set(key, { tool: error.tool, message, count: 1 })
    } else {
      existing.count += 1
    }
  }
  const errorGroups = [...errorMap.values()]
    .sort((left, right) =>
      right.count - left.count
      || compareText(left.tool, right.tool)
      || compareText(left.message, right.message))

  return {
    toolCounts,
    repeated,
    errorGroups,
    totalErrors: rawErrors.length,
    files,
    unfinished,
    verification: {
      observed: verifyToolCalled || commands.length > 0,
      commands,
    },
  }
}

function renderMarkdown(eventCount: number, analysis: ReflectionAnalysis): string {
  const lines: string[] = [
    '## Summary',
    '',
    `- Events: ${eventCount}`,
    `- Tool calls: ${countToolCalls(analysis)}`,
    `- Tool errors: ${analysis.totalErrors}`,
    `- Repeated call groups: ${analysis.repeated.length}`,
    `- Files touched: ${analysis.files.length}${renderFileList(analysis.files)}`,
    `- Unfinished turns: ${analysis.unfinished.length}`,
    `- Verification observed: **${analysis.verification.observed ? 'yes' : 'no'}**`,
  ]

  if (analysis.toolCounts.length > 0) {
    lines.push(`- Tools: ${analysis.toolCounts.map(([name, count]) => `\`${name}\`×${count}`).join(', ')}`)
  }

  lines.push('', '## Repeated calls', '')
  if (analysis.repeated.length === 0) {
    lines.push('_No repeated identical calls recorded._')
  } else {
    for (const repeated of analysis.repeated.slice(0, MAX_REPEATED_DISPLAY)) {
      lines.push(`- \`${repeated.tool}\` called ${repeated.count} times with identical arguments: `
        + `\`${clip(repeated.canonicalArguments, 300)}\``)
    }
  }

  lines.push('', '## Errors', '')
  if (analysis.errorGroups.length === 0) {
    lines.push('_No tool errors recorded._')
  } else {
    for (const error of analysis.errorGroups.slice(0, MAX_ERRORS_DISPLAY)) {
      lines.push(`- \`${error.tool}\` (${error.count} ${error.count === 1 ? 'time' : 'times'}): ${clip(error.message, 300)}`)
    }
  }

  lines.push('', '## Verification', '')
  lines.push(`Verification observed: **${analysis.verification.observed ? 'yes' : 'no'}**.`)
  if (analysis.verification.observed) {
    lines.push('')
    if (analysis.verification.commands.length > 0) {
      for (const command of analysis.verification.commands.slice(0, MAX_COMMANDS_DISPLAY)) {
        lines.push(`- \`${clip(oneLine(command), 300)}\``)
      }
    }
    if (analysis.verification.commands.length === 0) {
      lines.push('- `verify` tool was called.')
    }
  } else {
    lines.push('')
    lines.push('_No test, lint, typecheck, build, or check command was observed._')
  }
  lines.push('', `Files changed: ${analysis.files.length}.`)

  lines.push('', '## Suggestions', '')
  for (const suggestion of buildSuggestions(analysis)) {
    lines.push(`- ${suggestion}`)
  }

  lines.push('')
  return lines.join('\n')
}

function buildSuggestions(analysis: ReflectionAnalysis): string[] {
  const suggestions: string[] = []

  for (const error of analysis.errorGroups) {
    if (error.count >= 2) {
      suggestions.push(`Tool ${error.tool} failed ${error.count} times: inspect the error and change approach.`)
    }
  }

  for (const repeated of analysis.repeated) {
    suggestions.push(`Repeated identical call to ${repeated.tool} ${repeated.count} times: cache the result or change the plan.`)
  }

  if (analysis.files.length > 0 && !analysis.verification.observed) {
    suggestions.push('Files changed without an observed verification command.')
  }

  for (const unfinished of analysis.unfinished.slice(-3)) {
    const detail = unfinished.detail === undefined ? '' : `: ${clip(oneLine(unfinished.detail), 200)}`
    suggestions.push(`Unfinished turn: turn ${unfinished.turn} ended with \`${unfinished.kind}\`${detail}.`)
  }

  if (suggestions.length === 0) {
    suggestions.push('No repeated failures or unverified edits detected.')
  }

  return suggestions
}

function countToolCalls(analysis: ReflectionAnalysis): number {
  return analysis.toolCounts.reduce((total, [, count]) => total + count, 0)
}

function renderFileList(files: readonly string[]): string {
  if (files.length === 0) return ''
  const visible = files.slice(0, 20).map(path => `\`${clip(path, 200)}\``).join(', ')
  return ` (${visible}${files.length > 20 ? `, … ${files.length - 20} more` : ''})`
}

function canonicalArguments(call: ReflectionToolCall): string {
  const value = call.arguments ?? call.rawArguments ?? null
  try {
    return canonicalJson(value)
  } catch {
    return String(value)
  }
}

function toolCallOf(data: Record<string, unknown> | undefined): ReflectionToolCall | undefined {
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

function filePathsOf(call: ReflectionToolCall): string[] {
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

function commandOf(call: ReflectionToolCall): string | undefined {
  for (const key of ['command', 'cmd', 'script']) {
    const value = call.arguments?.[key]
    if (typeof value === 'string' && value.trim().length > 0) return value
  }
  if (typeof call.rawArguments === 'string' && call.rawArguments.trim().length > 0) {
    return call.rawArguments
  }
  return undefined
}

function isVerificationCommand(command: string): boolean {
  const lowered = command.toLowerCase()
  return VERIFICATION_TOKENS.some(token => lowered.includes(token))
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
