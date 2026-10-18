/**
 * Session token budget: accumulate provider-reported usage per session, expose
 * a `budget_status` tool, and optionally refuse model requests once a session
 * reaches its configured cap.
 *
 * Usage is read only from durable session events (`assistant/message` and
 * `compaction/summary`), deduplicated by event seq, so replaying an event or
 * observing it twice can never double-charge a session.
 */

import type {
  PluginContext,
  SuperDshConfig,
  ToolDefinitionLike,
  ToolExecutionLike,
} from '../plugin-types.ts'
import { sessionIdOf } from '../session-id.ts'
import { warn } from '../shared.ts'

const DEFAULT_MAX_TOKENS = 200_000
const USAGE_EVENT_TYPES = new Set(['assistant/message', 'compaction/summary'])

interface BudgetState {
  used: number
  /** Session event seqs whose usage has already been counted. */
  seen: Set<number>
}

interface BudgetStatus {
  session_id: string
  used_tokens: number
  max_tokens: number
  remaining: number
  exhausted: boolean
  enforced: boolean
}

export function applyBudget(ctx: PluginContext, config: SuperDshConfig): void {
  const raw = config.budget
  if (raw === undefined || raw === false || (raw as unknown) === null) return

  const options = typeof raw === 'object' ? raw : {}
  const configuredMax = options.maxTokens
  const maxTokens = typeof configuredMax === 'number'
    && Number.isFinite(configuredMax)
    && configuredMax > 0
    ? Math.floor(configuredMax)
    : DEFAULT_MAX_TOKENS
  const enforce = options.enforce === true
  const states = new Map<string, BudgetState>()

  const stateFor = (sessionId: string): BudgetState => {
    let state = states.get(sessionId)
    if (state === undefined) {
      state = { used: 0, seen: new Set<number>() }
      states.set(sessionId, state)
    }
    return state
  }

  ctx.systemPrompt.section({
    name: 'super-dsh:budget',
    order: 160,
    text: 'Token usage is tracked per session from provider usage records. '
      + 'Use `budget_status` to report used, remaining, and exhausted state'
      + (enforce ? '; model requests are refused once the session reaches its cap.' : '.'),
  })

  ctx.on('session/event', (session: unknown, event: unknown) => {
    const sessionId = sessionIdOfValue(session) ?? sessionIdOfValue(asRecord(event)?.session)
    if (sessionId === undefined) return
    const record = asRecord(event)
    if (record === undefined || typeof record.type !== 'string') return
    if (!USAGE_EVENT_TYPES.has(record.type)) return

    const data = asRecord(record.data)
    const usage = data?.usage ?? record.usage
    const tokens = usageTokens(usage)
    if (tokens === undefined) return

    const state = stateFor(sessionId)
    const seq = typeof record.seq === 'number' && Number.isSafeInteger(record.seq) ? record.seq : undefined
    if (seq !== undefined) {
      if (state.seen.has(seq)) return
      state.seen.add(seq)
    }
    state.used += tokens
  })

  // Optional lifecycle hook: materialize the per-session counter as soon as an
  // agent exists, so a status read never depends on usage having arrived.
  ctx.on('agent/created', (payload: unknown) => {
    const sessionId = requestSessionId(payload)
    if (sessionId !== undefined) stateFor(sessionId)
  })

  const statusTool: ToolDefinitionLike = {
    name: 'budget_status',
    description: 'Report the token budget state of a session: used tokens, maximum, remaining, '
      + 'whether the budget is exhausted, and whether enforcement is active.',
    parameters: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Session to inspect. Omit to use the current agent session.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          used_tokens: { type: 'integer' },
          max_tokens: { type: 'integer' },
          remaining: { type: 'integer' },
          exhausted: { type: 'boolean' },
          enforced: { type: 'boolean' },
        },
        required: ['session_id', 'used_tokens', 'max_tokens', 'remaining', 'exhausted', 'enforced'],
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${String(value.used_tokens)} / ${String(value.max_tokens)} tokens used, `
          + `${String(value.remaining)} remaining for session ${String(value.session_id)}`
          + (value.exhausted === true ? ' (exhausted)' : '')
          + (value.enforced === true ? ' [enforced]' : ''),
      }],
    },
    async execute(rawArgs: Record<string, unknown>, exec: ToolExecutionLike) {
      const requested = typeof rawArgs.session_id === 'string' ? rawArgs.session_id.trim() : ''
      const sessionId = requested.length > 0 ? requested : sessionIdOf(exec.agent)
      if (sessionId === undefined || sessionId.length === 0) {
        throw new Error('budget_status: no session id is available; pass session_id or call the tool from an agent session')
      }
      return statusOf(sessionId, states.get(sessionId)?.used ?? 0, maxTokens, enforce)
    },
  }

  try {
    ctx.tools.register(statusTool)
  } catch (error: unknown) {
    warn(ctx.logger, 'could not register budget_status', error)
  }

  if (!enforce) return

  ctx.on('agent/request', async (payload: unknown, next: () => Promise<unknown>) => {
    const sessionId = requestSessionId(payload)
      // A single tracked session is unambiguous even if the host omits the
      // agent from the waterfall payload.
      ?? (states.size === 1 ? states.keys().next().value : undefined)
    if (sessionId === undefined) return next()

    const used = states.get(sessionId)?.used ?? 0
    if (used >= maxTokens) {
      throw new Error(
        `super-dsh budget exhausted: session "${sessionId}" used ${Math.round(used)} of ${maxTokens} tokens`,
      )
    }
    return next()
  })
}

function statusOf(
  sessionId: string,
  rawUsed: number,
  maxTokens: number,
  enforced: boolean,
): BudgetStatus {
  const used = Math.max(0, Math.round(rawUsed))
  return {
    session_id: sessionId,
    used_tokens: used,
    max_tokens: maxTokens,
    remaining: Math.max(0, maxTokens - used),
    exhausted: rawUsed >= maxTokens,
    enforced,
  }
}

function usageTokens(usage: unknown): number | undefined {
  const record = asRecord(usage)
  if (record === undefined) return undefined

  const total = nonNegativeNumber(record.totalTokens)
  if (total !== undefined) return total

  const input = nonNegativeNumber(record.inputTokens)
  const output = nonNegativeNumber(record.outputTokens)
  if (input === undefined && output === undefined) return undefined
  return (input ?? 0) + (output ?? 0)
}

function requestSessionId(payload: unknown): string | undefined {
  const record = asRecord(payload)
  if (record === undefined) return undefined

  const direct = sessionIdOfValue(record.session)
    ?? sessionIdOfValue(record.sessionId)
    ?? sessionIdOfValue(record.session_id)
  if (direct !== undefined) return direct

  const agent = asRecord(record.agent)
  const fromAgent = sessionIdOfValue(agent?.session) ?? sessionIdOfValue(agent?.sessionId)
  if (fromAgent !== undefined) return fromAgent
  return undefined
}

function sessionIdOfValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) return value
  const record = asRecord(value)
  if (record === undefined) return undefined
  return typeof record.id === 'string' && record.id.length > 0 ? record.id : undefined
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
