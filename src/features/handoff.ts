/**
 * Deterministic session handoff: a compact, reproducible Markdown report of a
 * persisted session, intended to seed the next session's context without an
 * extra model call.
 *
 * The report is derived only from session events: user requests, the final
 * assistant answer, tool-call counts and key arguments, accumulated errors,
 * touched files, executed commands, unfinished turn states, and an explicit
 * resume checklist. Unknown event shapes are skipped rather than guessed at,
 * so a harness format change degrades the report instead of breaking it.
 */

import type {
  PluginContext,
  SuperDshConfig,
  ToolDefinitionLike,
  ToolExecutionLike,
} from '../plugin-types.ts'
import { sessionIdOf } from '../session-id.ts'
import { warn } from '../shared.ts'

interface SessionQueryLike {
  readSession(sessionId: string): Promise<unknown>
}

interface ToolCallRecord {
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

interface ToolErrorRecord {
  callId: string | undefined
  tool: string | undefined
  message: string
}

interface HandoffStats {
  events: number
  userMessages: number
  toolCalls: number
  toolErrors: number
  files: number
  commands: number
}

const FILE_TOOLS = new Set(['write', 'edit', 'fuzzy_edit', 'apply_patch'])
const COMMAND_TOOLS = new Set(['bash', 'shell', 'pwsh', 'powershell', 'cmd', 'run_command'])
const MAX_USER_REQUESTS = 10
const MAX_TOOL_CALLS = 20
const MAX_TOOL_ERRORS = 10
const MAX_COMMANDS = 10

export function applyHandoff(ctx: PluginContext, config: SuperDshConfig): void {
  if (config.handoff === false) return

  ctx.systemPrompt.section({
    name: 'super-dsh:handoff',
    order: 150,
    text: 'Use `handoff` when the user asks for a resumable summary before switching sessions or compacting. '
      + 'It reads the persisted session log and returns a deterministic Markdown report; no model call is made.',
  })

  const handoffTool: ToolDefinitionLike = {
    name: 'handoff',
    description: 'Build a deterministic Markdown handoff report from a persisted session: user requests, final answer, '
      + 'tool-call summary, errors, touched files, commands, unfinished turns, and a resume checklist. '
      + 'Requires the sessionQuery service. No model call is made.',
    parameters: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Session to summarize. Omit to use the current agent session.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          markdown: { type: 'string' },
          stats: {
            type: 'object',
            properties: {
              events: { type: 'integer' },
              userMessages: { type: 'integer' },
              toolCalls: { type: 'integer' },
              toolErrors: { type: 'integer' },
              files: { type: 'integer' },
              commands: { type: 'integer' },
            },
            required: ['events', 'userMessages', 'toolCalls', 'toolErrors', 'files', 'commands'],
            additionalProperties: false,
          },
        },
        required: ['markdown', 'stats'],
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
        throw new Error('handoff: no session id is available; pass session_id or call the tool from an agent session')
      }

      let snapshot: unknown
      try {
        snapshot = await service.readSession(sessionId)
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(`handoff: could not read session "${sessionId}": ${detail}`)
      }

      const events = eventsOf(snapshot)
      if (events === undefined) {
        throw new Error(`handoff: sessionQuery.readSession returned no event list for session "${sessionId}"`)
      }

      const report = buildReport(sessionId, events)
      return { markdown: report.markdown, stats: report.stats }
    },
  }

  try {
    ctx.tools.register(handoffTool)
  } catch (error: unknown) {
    warn(ctx.logger, 'could not register handoff', error)
  }
}

function sessionQueryOf(ctx: PluginContext): SessionQueryLike {
  const service = ctx.get?.('sessionQuery')
  const record = asRecord(service)
  if (record === undefined || typeof record.readSession !== 'function') {
    throw new Error('handoff requires the sessionQuery service, but it is not available in this harness')
  }
  return service as SessionQueryLike
}

function eventsOf(snapshot: unknown): unknown[] | undefined {
  if (Array.isArray(snapshot)) return snapshot as unknown[]
  const record = asRecord(snapshot)
  if (record !== undefined && Array.isArray(record.events)) return record.events as unknown[]
  return undefined
}

function buildReport(sessionId: string, events: readonly unknown[]): {
  markdown: string
  stats: HandoffStats
} {
  const requests: string[] = []
  const seenRequests = new Set<string>()
  const calls: ToolCallRecord[] = []
  const turnIssues: string[] = []
  let finalAnswer = ''

  for (const raw of events) {
    const event = asRecord(raw)
    if (event === undefined || typeof event.type !== 'string') continue
    const data = asRecord(event.data)

    if (event.type === 'user/message') {
      const text = messageText(data).trim()
      if (text.length === 0 || seenRequests.has(text) || isInjectedContext(text)) continue
      seenRequests.add(text)
      requests.push(text)
      continue
    }

    if (event.type === 'assistant/message') {
      const text = messageText(data)
      if (text.length > 0) finalAnswer = text
      if (data?.interrupted === true) {
        const turn = typeof data.turn === 'number' ? data.turn : undefined
        turnIssues.push(`Assistant output in turn ${turn ?? '?'} was interrupted before completion.`)
      }
      continue
    }

    if (event.type === 'tool/call') {
      const call = toolCallOf(data)
      if (call !== undefined) calls.push(call)
      continue
    }

    if (event.type === 'turn/end') {
      const issue = turnEndIssue(data)
      if (issue !== undefined) turnIssues.push(issue)
    }
  }

  const callNames = new Map<string, string>()
  for (const call of calls) {
    if (call.callId !== undefined) callNames.set(call.callId, call.name)
  }

  const errors: ToolErrorRecord[] = []
  for (const raw of events) {
    const event = asRecord(raw)
    if (event === undefined || event.type !== 'tool/result') continue
    const data = asRecord(event.data)
    if (!isErrorResult(event, data)) continue
    errors.push(toolErrorOf(event, data, callNames))
  }

  const toolCounts = new Map<string, number>()
  for (const call of calls) toolCounts.set(call.name, (toolCounts.get(call.name) ?? 0) + 1)
  const sortedCounts = [...toolCounts.entries()]
    .sort((left, right) => right[1] - left[1] || compareText(left[0], right[0]))

  const files: string[] = []
  const seenFiles = new Set<string>()
  const commands: string[] = []
  for (const call of calls) {
    if (FILE_TOOLS.has(call.normalizedName)) {
      for (const path of filePathsOf(call)) {
        if (seenFiles.has(path)) continue
        seenFiles.add(path)
        files.push(path)
      }
    }
    if (COMMAND_TOOLS.has(call.normalizedName)) {
      const command = commandOf(call)
      if (command !== undefined) commands.push(command)
    }
  }

  const notable = calls
    .filter(call => FILE_TOOLS.has(call.normalizedName) || COMMAND_TOOLS.has(call.normalizedName))
    .slice(0, MAX_TOOL_CALLS)

  const lines: string[] = [
    `# Session handoff: \`${sessionId}\``,
    '',
    `Deterministic report derived from ${events.length} recorded session events. No model call was used.`,
    '',
    '## User requests',
    '',
  ]

  if (requests.length === 0) {
    lines.push('_No user messages recorded._')
  } else {
    requests.slice(0, MAX_USER_REQUESTS).forEach((text, index) => {
      lines.push(`${index + 1}. ${indentContinuation(clip(text, 500), 3)}`)
    })
  }

  lines.push('', '## Final assistant answer', '')
  lines.push(finalAnswer.length > 0 ? clip(finalAnswer, 2000) : '_No assistant message recorded._')

  lines.push('', '## Tool calls', '')
  if (calls.length === 0) {
    lines.push('_No tool calls recorded._')
  } else {
    lines.push('Counts:', '')
    for (const [name, count] of sortedCounts) lines.push(`- \`${name}\`: ${count}`)
    lines.push('', 'Mutating and command calls:', '')
    if (notable.length === 0) {
      lines.push('_No mutating or command tool calls recorded._')
    } else {
      for (const call of notable) lines.push(describeCall(call))
    }
  }

  lines.push('', '## Tool errors', '')
  if (errors.length === 0) {
    lines.push('_No tool errors recorded._')
  } else {
    for (const error of errors.slice(-MAX_TOOL_ERRORS)) {
      const callId = error.callId === undefined ? 'unknown call' : `\`${error.callId}\``
      const tool = error.tool === undefined ? '' : ` (\`${error.tool}\`)`
      lines.push(`- ${callId}${tool}: ${clip(error.message, 500)}`)
    }
  }

  lines.push('', '## Files touched', '')
  if (files.length === 0) {
    lines.push('_No files were touched by write, edit, fuzzy_edit, or apply_patch._')
  } else {
    for (const path of files) lines.push(`- \`${path}\``)
  }

  lines.push('', '## Commands run', '')
  if (commands.length === 0) {
    lines.push('_No bash or shell commands were recorded._')
  } else {
    commands.slice(0, MAX_COMMANDS).forEach((command, index) => {
      lines.push(`${index + 1}. \`${clip(oneLine(command), 300)}\``)
    })
  }

  lines.push('', '## Recent issues', '')
  const recentIssues: string[] = [...turnIssues.slice(-5)]
  if (errors.length > 0) {
    const last = errors[errors.length - 1]
    const callId = last.callId === undefined ? 'unknown call' : `\`${last.callId}\``
    const tool = last.tool === undefined ? '' : ` (\`${last.tool}\`)`
    recentIssues.push(`Last tool error: ${callId}${tool}: ${clip(last.message, 300)}`)
  }
  if (recentIssues.length === 0) {
    lines.push('- None recorded.')
  } else {
    for (const issue of recentIssues) lines.push(`- ${issue}`)
  }

  lines.push(
    '',
    '## Resume checklist',
    '',
    '- Re-read every file listed under "Files touched" before editing it again.',
    '- Re-run the failed commands or verification steps called out under "Tool errors" and "Recent issues" until they pass.',
    '- Confirm the unfinished items under "Recent issues" with the user before continuing.',
    '',
  )

  return {
    markdown: lines.join('\n'),
    stats: {
      events: events.length,
      userMessages: requests.length,
      toolCalls: calls.length,
      toolErrors: errors.length,
      files: files.length,
      commands: commands.length,
    },
  }
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

function isInjectedContext(text: string): boolean {
  return text.startsWith('Current runtime context')
    || text.includes('<system-reminder>')
    || text.includes('<available_skills>')
    || text.startsWith('A skill is a reusable set of task-specific instructions')
}

function commandOf(call: ToolCallRecord): string | undefined {  for (const key of ['command', 'cmd', 'script']) {
    const value = call.arguments?.[key]
    if (typeof value === 'string' && value.trim().length > 0) return value
  }
  if (typeof call.rawArguments === 'string' && call.rawArguments.trim().length > 0) {
    return call.rawArguments
  }
  return undefined
}

function describeCall(call: ToolCallRecord): string {
  const parts: string[] = []
  if (FILE_TOOLS.has(call.normalizedName)) {
    const paths = [...new Set(filePathsOf(call))]
    if (paths.length === 0) {
      parts.push('file_path=(missing)')
    } else {
      for (const path of paths) parts.push(`file_path=\`${clip(path, 200)}\``)
    }
  }
  if (COMMAND_TOOLS.has(call.normalizedName)) {
    const command = commandOf(call)
    parts.push(command === undefined ? 'command=(missing)' : `command=\`${clip(oneLine(command), 300)}\``)
  }
  return parts.length === 0 ? `- \`${call.name}\`` : `- \`${call.name}\` ${parts.join(', ')}`
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

function toolErrorOf(
  event: Record<string, unknown>,
  data: Record<string, unknown> | undefined,
  callNames: Map<string, string>,
): ToolErrorRecord {
  const message = asRecord(data?.message)
  const callId = firstString(
    data?.callId,
    message?.toolCallId,
    message?.callId,
    data?.toolCallId,
    asRecord(message?.source)?.callId,
  )
  const directTool = firstString(data?.name, data?.toolName, message?.name)
  const tool = directTool ?? (callId === undefined ? undefined : callNames.get(callId))
  const structured = errorText(data?.error) || errorText(event.error)
  const content = contentText(message?.content) || contentText(data?.content) || contentText(data?.message)
  const text = structured.length > 0 ? structured : content
  return {
    callId,
    tool,
    message: text.length === 0 ? 'tool reported an error' : text,
  }
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

function turnEndIssue(data: Record<string, unknown> | undefined): string | undefined {
  if (data === undefined) return undefined
  const reason = data.reason
  const reasonRecord = asRecord(reason)
  const kind = typeof reason === 'string' ? reason : firstString(reasonRecord?.kind)
  if (kind === undefined || kind === 'completed') return undefined
  const turn = typeof data.turn === 'number' ? data.turn : undefined
  const detail = firstString(asRecord(reasonRecord?.error)?.message, reasonRecord?.message)
  const suffix = detail === undefined ? '' : `: ${clip(detail, 300)}`
  return `Turn ${turn ?? '?'} ended with \`${kind}\`${suffix}`
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

function indentContinuation(text: string, spaces: number): string {
  return text.replace(/\r?\n/g, `\n${' '.repeat(spaces)}`)
}
