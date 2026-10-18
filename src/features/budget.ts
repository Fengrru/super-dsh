/**
 * Session token budget: accumulate provider-reported usage per session, expose
 * a `budget_status` tool, and optionally refuse model requests once a session
 * reaches its configured cap.
 *
 * Usage is read only from durable session events (`assistant/message` and
 * `compaction/summary`), deduplicated by event seq, so replaying an event or
 * observing it twice can never double-charge a session.
 *
 * When `reservePerRequest` is set, every model request reserves an estimate
 * before it is admitted. The reservation is settled against actual usage for
 * the same turn/step, released on `agent/request-error`, and swept on
 * `turn/end`. This closes the gap where several requests pass a used-tokens
 * check before any of their usage has been reported.
 */

import type {
  PluginContext,
  SuperDshConfig,
  ToolDefinitionLike,
  ToolExecutionLike,
} from '../plugin-types.ts'
import { BudgetLedger } from '../budget-ledger.ts'
import { sessionIdOf } from '../session-id.ts'
import { warn } from '../shared.ts'

const DEFAULT_MAX_TOKENS = 200_000
const USAGE_EVENT_TYPES = new Set(['assistant/message', 'compaction/summary'])

interface BudgetState {
  ledger: BudgetLedger
  /** Session event seqs whose usage has already been counted. */
  seen: Set<number>
}

interface BudgetStatus {
  session_id: string
  used_tokens: number
  max_tokens: number
  reserved: number
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
  const reservePerRequest = normalizeReservePerRequest(options.reservePerRequest)
  const states = new Map<string, BudgetState>()

  const stateFor = (sessionId: string): BudgetState => {
    let state = states.get(sessionId)
    if (state === undefined) {
      state = { ledger: new BudgetLedger(maxTokens), seen: new Set<number>() }
      states.set(sessionId, state)
    }
    return state
  }

  ctx.systemPrompt.section({
    name: 'super-dsh:budget',
    order: 160,
    text: 'Token usage is tracked per session from provider usage records. '
      + 'Use `budget_status` to report used, remaining, and exhausted state'
      + (reservePerRequest > 0
        ? `; ${String(reservePerRequest)} token(s) are reserved per model request and settled against actual usage.`
        : '')
      + (enforce ? ' Model requests are refused once the session reaches its cap.' : ''),
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

    // Assistant replies settle the reservation of the step that produced
    // them. Everything else (compaction summaries, events without turn/step)
    // is charged directly.
    const turn = integerField(data, 'turn') ?? integerField(record, 'turn')
    const step = integerField(data, 'step') ?? integerField(record, 'step')
    if (record.type === 'assistant/message' && turn !== undefined && step !== undefined) {
      const key = requestKey(sessionId, turn, step)
      if (state.ledger.hasReservation(key)) {
        state.ledger.settle(key, tokens)
        return
      }
    }
    state.ledger.charge(tokens)
  })

  // Optional lifecycle hook: materialize the per-session counter as soon as an
  // agent exists, so a status read never depends on usage having arrived.
  ctx.on('agent/created', (payload: unknown) => {
    const sessionId = requestSessionId(payload)
    if (sessionId !== undefined) stateFor(sessionId)
  })

  const statusTool: ToolDefinitionLike = {
    name: 'budget_status',
    description: 'Report the token budget state of a session: used tokens, reserved tokens, maximum, '
      + 'remaining, whether the budget is exhausted, and whether enforcement is active.',
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
          reserved: { type: 'integer' },
          remaining: { type: 'integer' },
          exhausted: { type: 'boolean' },
          enforced: { type: 'boolean' },
        },
        required: [
          'session_id',
          'used_tokens',
          'max_tokens',
          'reserved',
          'remaining',
          'exhausted',
          'enforced',
        ],
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${String(value.used_tokens)} / ${String(value.max_tokens)} tokens used, `
          + `${String(value.remaining)} remaining for session ${String(value.session_id)}`
          + (typeof value.reserved === 'number' && value.reserved > 0
            ? ` (${String(value.reserved)} reserved)`
            : '')
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
      const state = states.get(sessionId)
      return statusOf(
        sessionId,
        state?.ledger.used ?? 0,
        state?.ledger.reserved ?? 0,
        maxTokens,
        enforce,
      )
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

    const state = stateFor(sessionId)
    const ledger = state.ledger

    // Default behavior: no reservation, only refuse once usage reached the cap.
    if (reservePerRequest <= 0) {
      if (ledger.used >= maxTokens) {
        throw exhaustedError(sessionId, ledger.used, ledger.reserved, maxTokens, 0)
      }
      return next()
    }

    const turn = coordinateOf(asRecord(payload), 'turn') ?? 0
    const step = coordinateOf(asRecord(payload), 'step') ?? 0
    const key = requestKey(sessionId, turn, step)

    // A retried waterfall for the same turn/step keeps its existing hold
    // instead of reserving twice.
    if (ledger.hasReservation(key)) return next()

    if (ledger.used + ledger.reserved + reservePerRequest > maxTokens) {
      throw exhaustedError(sessionId, ledger.used, ledger.reserved, maxTokens, reservePerRequest)
    }
    if (!ledger.reserve(key, reservePerRequest)) {
      throw exhaustedError(sessionId, ledger.used, ledger.reserved, maxTokens, reservePerRequest)
    }

    try {
      return await next()
    } catch (error: unknown) {
      // Do not keep a hold for a request the host rejected before usage.
      ledger.release(key)
      throw error
    }
  })

  if (reservePerRequest <= 0) return

  ctx.on('agent/request-error', (payload: unknown) => {
    const sessionId = requestSessionId(payload)
    if (sessionId === undefined) return
    const state = states.get(sessionId)
    if (state === undefined) return

    const record = asRecord(payload)
    const turn = coordinateOf(record, 'turn')
    const step = coordinateOf(record, 'step')
    if (turn !== undefined && step !== undefined) {
      state.ledger.release(requestKey(sessionId, turn, step))
    } else if (turn !== undefined) {
      state.ledger.releasePrefix(`${sessionId}:${turn}:`)
    } else {
      state.ledger.releasePrefix(`${sessionId}:`)
    }
  })

  ctx.on('turn/end', (payload: unknown) => {
    const sessionId = requestSessionId(payload)
    if (sessionId === undefined) return
    const state = states.get(sessionId)
    if (state === undefined) return

    const turn = coordinateOf(asRecord(payload), 'turn')
    if (turn === undefined) {
      state.ledger.releasePrefix(`${sessionId}:`)
    } else {
      state.ledger.releasePrefix(`${sessionId}:${turn}:`)
    }
  })
}

function statusOf(
  sessionId: string,
  rawUsed: number,
  rawReserved: number,
  maxTokens: number,
  enforced: boolean,
): BudgetStatus {
  const used = Math.max(0, Math.round(rawUsed))
  const reserved = Math.max(0, Math.round(rawReserved))
  return {
    session_id: sessionId,
    used_tokens: used,
    max_tokens: maxTokens,
    reserved,
    remaining: Math.max(0, maxTokens - used),
    exhausted: rawUsed >= maxTokens,
    enforced,
  }
}

function exhaustedError(
  sessionId: string,
  used: number,
  reserved: number,
  maxTokens: number,
  needed: number,
): Error {
  return new Error(
    `super-dsh budget exhausted: session "${sessionId}" used ${Math.round(used)} `
    + `and reserved ${Math.round(reserved)} of ${maxTokens} tokens`
    + (needed > 0 ? `; ${needed} more token(s) are required for this request` : ''),
  )
}

function requestKey(sessionId: string, turn: number, step: number): string {
  return `${sessionId}:${turn}:${step}`
}

function normalizeReservePerRequest(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : 0
}

function coordinateOf(record: Record<string, unknown> | undefined, key: 'turn' | 'step'): number | undefined {
  return integerField(record, key) ?? integerField(asRecord(record?.data), key)
}

function integerField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key]
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
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
