/**
 * Deterministic replay planning from a persisted session.
 *
 * `buildReplayPlan` is a pure event parser: it never executes the plan and
 * never calls a model. The `replay_plan` tool exposes the same result to the
 * agent, which can then decide which reads, re-runs, verifications, and
 * inspections are actually needed. Actions are capped at 20 per kind so a
 * long session still produces a bounded, stable response.
 *
 * Event shapes match `features/handoff.ts`: both `{type, data}` and snapshot
 * wrappers with `{events}` are accepted, and unknown shapes are skipped.
 */

import type {
  PluginContext,
  SuperDshConfig,
  ToolDefinitionLike,
  ToolExecutionLike,
} from './plugin-types.ts'
import { sessionIdOf } from './session-id.ts'
import { warn } from './shared.ts'

export type ReplayActionKind = 'read' | 'rerun' | 'verify' | 'inspect'

export interface ReplayAction {
  kind: ReplayActionKind
  target: string
  reason: string
}

export interface ReplayPlanStats {
  events: number
  actions: number
  changed_files: number
  commands: number
  errors: number
}

export interface ReplayPlan {
  actions: ReplayAction[]
  changed_files: string[]
  commands: string[]
  unresolved_errors: string[]
  unfinished_turns: string[]
  stats: ReplayPlanStats
}

interface SessionQueryLike {
  readSession(sessionId: string): Promise<unknown>
}

interface ToolCallRecord {
  name: string
  normalizedName: string
  callId: string | undefined
  arguments: Record<string, unknown> | undefined
  rawArguments: unknown
}

interface FailedCallRecord {
  callId: string | undefined
  tool: string | undefined
  command: string | undefined
  message: string
}

interface TurnIssue {
  turn: number | undefined
  text: string
}

const FILE_TOOLS = new Set(['write', 'edit', 'fuzzy_edit', 'apply_patch'])
const COMMAND_TOOLS = new Set(['bash', 'shell', 'pwsh', 'powershell', 'cmd', 'run_command'])
const MAX_ACTIONS_PER_KIND = 20

/**
 * Tokens that indicate a verification-style command. Boundary matching avoids
 * treating `git checkout` as a check and `latest` as a test, while still
 * recognizing common runners such as `eslint`, `tsc`, `pytest`, and `vitest`.
 */
const VERIFICATION_COMMAND = new RegExp(
  '(?:^|[^A-Za-z0-9_-])(?:test|tests|lint|lints|typecheck|type-check|build|check'
  + '|pytest|jest|vitest|eslint|tsc)(?=$|[^A-Za-z0-9_-])',
  'i',
)

export function applyReplayPlan(ctx: PluginContext, config: SuperDshConfig): void {
  if (config.replayPlan === false) return

  ctx.systemPrompt.section({
    name: 'super-dsh:replay-plan',
    order: 151,
    text: 'Use `replay_plan` after a restart or compaction to obtain a deterministic, machine-readable '
      + 'plan of reads, re-runs, verifications, and unfinished turns from the persisted session. '
      + 'It only inspects events; it never executes the plan and makes no model call.',
  })

  const replayPlanTool: ToolDefinitionLike = {
    name: 'replay_plan',
    description: 'Build a deterministic replay plan from a persisted session: files to re-read, failed '
      + 'commands/tools to re-run, verification commands, unresolved errors, and unfinished turns. '
      + 'Requires the sessionQuery service. Reads events only; no model call is made.',
    parameters: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Session to plan from. Omit to use the current agent session.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          actions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['read', 'rerun', 'verify', 'inspect'] },
                target: { type: 'string' },
                reason: { type: 'string' },
              },
              required: ['kind', 'target', 'reason'],
              additionalProperties: false,
            },
          },
          changed_files: { type: 'array', items: { type: 'string' } },
          commands: { type: 'array', items: { type: 'string' } },
          unresolved_errors: { type: 'array', items: { type: 'string' } },
          unfinished_turns: { type: 'array', items: { type: 'string' } },
          stats: {
            type: 'object',
            properties: {
              events: { type: 'integer' },
              actions: { type: 'integer' },
              changed_files: { type: 'integer' },
              commands: { type: 'integer' },
              errors: { type: 'integer' },
            },
            required: ['events', 'actions', 'changed_files', 'commands', 'errors'],
            additionalProperties: false,
          },
        },
        required: [
          'actions',
          'changed_files',
          'commands',
          'unresolved_errors',
          'unfinished_turns',
          'stats',
        ],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(rawArgs: Record<string, unknown>, exec: ToolExecutionLike) {
      // Check the service before the id so the failure names the real cause.
      const service = sessionQueryOf(ctx)
      const requested = typeof rawArgs.session_id === 'string' ? rawArgs.session_id.trim() : ''
      const sessionId = requested.length > 0 ? requested : sessionIdOf(exec.agent)
      if (sessionId === undefined || sessionId.length === 0) {
        throw new Error('replay_plan: no session id is available; pass session_id or call the tool from an agent session')
      }

      let snapshot: unknown
      try {
        snapshot = await service.readSession(sessionId)
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(`replay_plan: could not read session "${sessionId}": ${detail}`)
      }

      const events = eventsOf(snapshot)
      if (events === undefined) {
        throw new Error(`replay_plan: sessionQuery.readSession returned no event list for session "${sessionId}"`)
      }

      return buildReplayPlan(events) as unknown as Record<string, unknown>
    },
  }

  try {
    ctx.tools.register(replayPlanTool)
  } catch (error: unknown) {
    warn(ctx.logger, 'could not register replay_plan', error)
  }
}

/** Pure, deterministic replay planner. Unknown events are ignored. */
export function buildReplayPlan(events: readonly unknown[]): ReplayPlan {
  const calls: ToolCallRecord[] = []
  const turnIssues: TurnIssue[] = []

  for (const raw of events) {
    const event = asRecord(raw)
    if (event === undefined || typeof event.type !== 'string') continue
    const data = asRecord(event.data)

    if (event.type === 'tool/call') {
      const call = toolCallOf(data)
      if (call !== undefined) calls.push(call)
      continue
    }

    if (event.type === 'turn/end') {
      const issue = turnEndIssue(data)
      if (issue !== undefined) turnIssues.push(issue)
      continue
    }

    if (event.type === 'assistant/message' && data?.interrupted === true) {
      const turn = typeof data.turn === 'number' ? data.turn : undefined
      turnIssues.push({
        turn,
        text: `turn ${turn ?? '?'} was interrupted before the assistant finished`,
      })
    }
  }

  const callsById = new Map<string, ToolCallRecord>()
  for (const call of calls) {
    if (call.callId !== undefined && !callsById.has(call.callId)) callsById.set(call.callId, call)
  }

  const failedCalls: FailedCallRecord[] = []
  const unresolvedErrors: string[] = []
  const seenErrors = new Set<string>()
  for (const raw of events) {
    const event = asRecord(raw)
    if (event === undefined || event.type !== 'tool/result') continue
    const data = asRecord(event.data)
    if (!isErrorResult(event, data)) continue

    const message = errorMessageOf(event, data)
    if (!seenErrors.has(message)) {
      seenErrors.add(message)
      unresolvedErrors.push(message)
    }

    const messageRecord = asRecord(data?.message)
    const callId = firstString(
      data?.callId,
      messageRecord?.toolCallId,
      messageRecord?.callId,
      data?.toolCallId,
    )
    const call = callId === undefined ? undefined : callsById.get(callId)
    const tool = firstString(data?.name, data?.toolName, messageRecord?.name, call?.name)
    const command = call === undefined ? undefined : commandOf(call)
    failedCalls.push({ callId, tool, command, message })
  }

  const changedFiles: string[] = []
  const seenFiles = new Set<string>()
  const commands: string[] = []
  const seenCommands = new Set<string>()
  const verificationCommands: string[] = []
  const seenVerification = new Set<string>()

  for (const call of calls) {
    if (FILE_TOOLS.has(call.normalizedName)) {
      for (const path of filePathsOf(call)) {
        if (seenFiles.has(path)) continue
        seenFiles.add(path)
        changedFiles.push(path)
      }
    }

    if (!COMMAND_TOOLS.has(call.normalizedName)) continue
    const command = commandOf(call)
    if (command === undefined) continue
    if (!seenCommands.has(command)) {
      seenCommands.add(command)
      commands.push(command)
    }
    if (VERIFICATION_COMMAND.test(command) && !seenVerification.has(command)) {
      seenVerification.add(command)
      verificationCommands.push(command)
    }
  }

  const actions: ReplayAction[] = []
  const seenActions = new Set<string>()
  const kindCounts = new Map<ReplayActionKind, number>()
  const pushAction = (kind: ReplayActionKind, target: string, reason: string): void => {
    const key = `${kind}\u0000${target}`
    if (seenActions.has(key)) return
    const count = kindCounts.get(kind) ?? 0
    if (count >= MAX_ACTIONS_PER_KIND) return
    seenActions.add(key)
    kindCounts.set(kind, count + 1)
    actions.push({ kind, target, reason })
  }

  for (const path of changedFiles) {
    pushAction('read', path, 're-read before editing')
  }
  for (const failure of failedCalls) {
    const target = failure.command ?? failure.tool ?? failure.callId
    if (target !== undefined) {
      pushAction('rerun', target, 'previous attempt failed; re-run before continuing')
    }
  }
  for (const command of verificationCommands) {
    pushAction('verify', command, 'verification command; run it again after the planned edits')
  }
  for (const issue of turnIssues) {
    pushAction('inspect', `turn ${issue.turn ?? '?'}`, issue.text)
  }

  const unfinishedTurns: string[] = []
  const seenTurns = new Set<string>()
  for (const issue of turnIssues) {
    if (seenTurns.has(issue.text)) continue
    seenTurns.add(issue.text)
    unfinishedTurns.push(issue.text)
  }

  return {
    actions,
    changed_files: changedFiles,
    commands,
    unresolved_errors: unresolvedErrors,
    unfinished_turns: unfinishedTurns,
    stats: {
      events: events.length,
      actions: actions.length,
      changed_files: changedFiles.length,
      commands: commands.length,
      errors: unresolvedErrors.length,
    },
  }
}

function sessionQueryOf(ctx: PluginContext): SessionQueryLike {
  const service = ctx.get?.('sessionQuery')
  const record = asRecord(service)
  if (record === undefined || typeof record.readSession !== 'function') {
    throw new Error('replay_plan requires the sessionQuery service, but it is not available in this harness')
  }
  return service as SessionQueryLike
}

function eventsOf(snapshot: unknown): unknown[] | undefined {
  if (Array.isArray(snapshot)) return snapshot as unknown[]
  const record = asRecord(snapshot)
  if (record !== undefined && Array.isArray(record.events)) return record.events as unknown[]
  return undefined
}

function toolCallOf(data: Record<string, unknown> | undefined): ToolCallRecord | undefined {
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

function filePathsOf(call: ToolCallRecord): string[] {
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

function commandOf(call: ToolCallRecord): string | undefined {
  for (const key of ['command', 'cmd', 'script']) {
    const value = call.arguments?.[key]
    if (typeof value === 'string' && value.trim().length > 0) return value
  }
  if (typeof call.rawArguments === 'string' && call.rawArguments.trim().length > 0) {
    return call.rawArguments
  }
  return undefined
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

function errorMessageOf(
  event: Record<string, unknown>,
  data: Record<string, unknown> | undefined,
): string {
  const message = asRecord(data?.message)
  const structured = errorText(data?.error) || errorText(event.error)
  const content = contentText(message?.content) || contentText(data?.content) || contentText(data?.message)
  const text = structured.length > 0 ? structured : content
  return text.length === 0 ? 'tool reported an error' : text
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

function turnEndIssue(data: Record<string, unknown> | undefined): TurnIssue | undefined {
  if (data === undefined) return undefined
  const reason = data.reason
  const reasonRecord = asRecord(reason)
  const kind = typeof reason === 'string' ? reason : firstString(reasonRecord?.kind)
  if (kind === undefined || kind === 'completed') return undefined
  const turn = typeof data.turn === 'number' ? data.turn : undefined
  const detail = firstString(asRecord(reasonRecord?.error)?.message, reasonRecord?.message)
  const suffix = detail === undefined ? '' : `: ${clip(detail, 300)}`
  return {
    turn,
    text: `turn ${turn ?? '?'} ended with \`${kind}\`${suffix}`,
  }
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
