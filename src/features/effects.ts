/**
 * Side-effect intent/commit ledger. Every tool call is recorded before it runs and resolved after it
 * finishes, so an interrupted irreversible action can be detected instead of
 * silently repeated.
 *
 * The ledger is append-only JSONL. A later record with the same callId
 * supersedes an earlier one when the ledger is folded, which is how a pending
 * intent becomes committed, failed, compensated, abandoned, or unknown after a
 * restart.
 *
 * Each session's file is read at most once per plugin instance. The folded
 * state is kept in memory (recordsByCall, pendingByKey, counts) and updated
 * synchronously after every append, so recording N calls is O(N) instead of
 * re-reading and re-folding the whole JSONL file on every tool call.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  AgentLike,
  PluginContext,
  SuperDshConfig,
  ToolDefinitionLike,
  ToolExecutionLike,
  ToolResultLike,
} from '../plugin-types.ts'
import { canonicalJson, dshHome, sha256, warn } from '../shared.ts'
import { safeFileStem, sessionIdOf, stableAgentKey } from '../session-id.ts'

export type EffectClass = 'pure' | 'idempotent' | 'reversible' | 'irreversible'
export type EffectStatus =
  | 'pending'
  | 'unknown'
  | 'committed'
  | 'failed'
  | 'compensated'
  | 'abandoned'
export type EffectResolution = 'committed' | 'compensated' | 'abandoned'
export type EffectDecision = 'replay' | 'compensate' | 'query'

export interface EffectPolicy {
  class?: EffectClass
  compensation?: string
}

interface EffectRecord {
  v: 1
  at: number
  callId: string
  key: string
  tool: string
  argsHash: string
  effectClass: EffectClass
  status: EffectStatus
  finishedAt?: number
  error?: string
  compensation?: string
  resolutionNote?: string
}

type EffectOptions = NonNullable<Exclude<SuperDshConfig['effects'], boolean>>

interface EffectCounts {
  pending: number
  unknown: number
  committed: number
  failed: number
  compensated: number
  abandoned: number
  total: number
}

/**
 * Folded in-memory view of one append-only session ledger.
 *
 * `recordsByCall` holds the latest accepted record per callId.
 * `pendingByKey` indexes the callIds whose folded status is still `pending`,
 * so duplicate-irreversible detection does not scan the ledger.
 */
interface SessionLedger {
  file: string
  recordsByCall: Map<string, EffectRecord>
  pendingByKey: Map<string, Set<string>>
  counts: EffectCounts
  loaded: boolean
  /** Append handle kept open for the lifetime of the plugin instance. */
  fd?: number
}

const EFFECT_CLASSES = new Set<EffectClass>(['pure', 'idempotent', 'reversible', 'irreversible'])
const EFFECT_STATUSES = new Set<EffectStatus>([
  'pending', 'unknown', 'committed', 'failed', 'compensated', 'abandoned',
])
const EFFECT_TOOLS = new Set(['effect_status', 'effect_reconcile', 'effect_resolve'])

const PURE_TOOLS = new Set([
  'read', 'grep', 'glob', 'ls', 'lsp', 'web_search',
  'effect_status', 'effect_reconcile', 'effect_resolve',
  'artifact_get', 'artifact_verify', 'artifact_list',
  'memory_search', 'repo_map', 'audit_verify',
])

const REVERSIBLE_TOOLS = new Set([
  'write', 'edit', 'fuzzy_edit', 'apply_patch', 'note_append',
  'artifact_put', 'knowledge_add', 'memory_save',
])

const SHELL_TOOLS = new Set(['shell', 'bash'])

const DANGEROUS_COMMAND_PATTERNS: readonly RegExp[] = [
  // rm with both recursive and force flags, including --recursive --force.
  /\brm\s+(?=[^\n]*(?:-[A-Za-z]*[rR][A-Za-z]*|--recursive\b))(?=[^\n]*(?:-[A-Za-z]*f[A-Za-z]*|--force\b))/,
  /\bgit\s+push\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-[A-Za-z]*[dfx]/,
  /\b(?:npm|yarn|pnpm|bun)\s+publish\b/,
  /\bkubectl\s+(?:apply|delete|replace|patch|scale|rollout|drain|cordon)\b/,
  /\bhelm\s+(?:install|upgrade|uninstall|delete|rollback)\b/,
  /\bterraform\s+(?:apply|destroy)\b/,
  /(?:^|[\s;&|])(?:deploy|release)(?=\s|$)/,
  /\b(?:docker|podman)\s+push\b/,
  /\b(?:sendmail|mailx|send-email|sendgrid|twilio|slack|discord|telegram)\b/,
  /\b(?:send|send_message|send-message|sendMessage|post_message|notify)\b/,
  /\bcurl\b[^\n]*(?:\s-X\s*POST|\s--data\b|\s--json\b|\s-F\b|\s-d\s)/,
  /\bwget\b[^\n]*--post-data\b/,
  /\b(?:systemctl\s+(?:restart|stop|disable)|shutdown|reboot)\b/,
  /\b(?:drop\s+(?:table|database)|truncate\s+table)\b/,
  /\b(?:chmod\s+777|git\s+branch\s+-D|git\s+tag\s+-d)\b/,
]

/**
 * Event names understood by the effect state machine. Both imperative names
 * ("commit") and target status names ("committed") are accepted so callers can
 * use either style.
 */
const EFFECT_EVENT_TARGETS: Readonly<Record<string, EffectStatus>> = {
  intent: 'pending',
  pending: 'pending',
  commit: 'committed',
  committed: 'committed',
  fail: 'failed',
  failed: 'failed',
  'mark-unknown': 'unknown',
  unknown: 'unknown',
  compensate: 'compensated',
  compensated: 'compensated',
  abandon: 'abandoned',
  abandoned: 'abandoned',
}

const STATUS_EVENT: Readonly<Record<EffectStatus, string>> = {
  pending: 'intent',
  committed: 'commit',
  failed: 'fail',
  unknown: 'mark-unknown',
  compensated: 'compensate',
  abandoned: 'abandon',
}

const RESOLUTION_EVENT: Readonly<Record<EffectResolution, string>> = {
  committed: 'commit',
  compensated: 'compensate',
  abandoned: 'abandon',
}

/**
 * Pure state machine for one effect.
 *
 * Unresolved states (`pending`, `unknown`) may move to any resolution state
 * (`committed`, `failed`, `compensated`, `abandoned`) or from pending to
 * unknown. Terminal states are immutable: an illegal transition (including an
 * unknown event name) returns the current status unchanged rather than
 * regressing it.
 */
export function effectTransition(status: EffectStatus, event: string): EffectStatus {
  // Accept both hyphenated and underscored spellings, plus an optional
  // "resolve-" prefix ("resolve_committed"), to keep the machine forgiving.
  const normalized = typeof event === 'string' ? event.trim().toLowerCase().replace(/_/g, '-') : ''
  const target = EFFECT_EVENT_TARGETS[normalized]
    ?? EFFECT_EVENT_TARGETS[normalized.replace(/^resolve-/, '')]
  if (target === undefined) return status
  if (status !== 'pending' && status !== 'unknown') return status
  // unknown means the process died after the intent was recorded; a later
  // "intent" record is a stale replay, not a reason to forget the uncertainty.
  if (status === 'unknown' && target === 'pending') return status
  return target
}

export function applyEffects(ctx: PluginContext, config: SuperDshConfig): void {
  if (config.effects === false) return
  const options: EffectOptions = typeof config.effects === 'object' ? config.effects : {}
  const dir = options.dir ?? join(dshHome(), 'super-dsh', 'effects')
  const denyUnresolved = options.denyUnresolvedIrreversible === true
  const overrides = new Set(
    Array.isArray(options.irreversibleTools)
      ? options.irreversibleTools.filter((name): name is string => typeof name === 'string' && name.length > 0)
      : [],
  )
  const policies = policyMap(options.effectPolicies)
  // Reconciliation runs once per session and process; a second agent/created
  // for the same session in this process must not mark live calls unknown.
  const createdSessions = new Set<string>()
  // callId -> session key, so a tools/result event without an agent can still
  // find the ledger file written by tools/pre-execute.
  const pendingCalls = new Map<string, string>()
  // Ledger file -> folded in-memory state. Loading happens on first access and
  // every append below updates this state synchronously.
  const ledgers = new Map<string, SessionLedger>()

  const ledgerFor = (session: string): SessionLedger => sessionLedger(ledgers, dir, session)

  // Append handles stay open for the plugin's lifetime to avoid an
  // open/close syscall pair per record. The OS reclaims them on process exit;
  // dispose them early when the host offers a lifecycle hook.
  if (typeof ctx.effect === 'function') {
    try {
      ctx.effect(() => () => {
        for (const ledger of ledgers.values()) closeLedger(ledger)
        ledgers.clear()
      }, 'super-dsh:effects')
    } catch (error: unknown) {
      warn(ctx.logger, 'could not register effects cleanup', error)
    }
  }

  ctx.systemPrompt.section({
    name: 'super-dsh:effects',
    order: 122,
    text: 'Tool calls are recorded in a side-effect ledger before they run. If an irreversible call is denied because '
      + 'an identical earlier call is still unresolved, inspect it with `effect_status`; plan recovery with '
      + '`effect_reconcile`; after checking the real world, record the outcome with `effect_resolve`. '
      + 'Do not retry an irreversible action blindly.',
  })

  ctx.on('tools/pre-execute', (exec: ToolExecutionLike, next: () => unknown) => {
    try {
      const session = sessionKeyOf(exec.agent)
      const tool = typeof exec.name === 'string' && exec.name.length > 0 ? exec.name : 'unknown-tool'
      const callId = callIdOf(exec.callId)
      const args = exec.arguments ?? null
      const effectClass = classify(tool, args, overrides, policies)
      const { key, argsHash } = keyFor(tool, args)
      const ledger = ledgerFor(session)
      // Check before appending: the current intent must not count as its own
      // unresolved predecessor. `unknown` means a previous process died after
      // recording the intent, so it is just as unresolved as `pending`.
      const pendingPredecessor = findUnresolvedPredecessor(ledger, key)
      const compensation = policies.get(tool)?.compensation

      if (denyUnresolved && effectClass === 'irreversible' && pendingPredecessor !== undefined) {
        return {
          kind: 'deny',
          reason: `super-dsh effects: an earlier irreversible call to "${tool}" with the same arguments `
            + `(call ${pendingPredecessor.callId}) is still unresolved (${pendingPredecessor.status}). `
            + 'Refusing to repeat an unresolved irreversible side effect; inspect it with effect_status first.',
        }
      }

      appendAndApply(ledger, {
        v: 1,
        at: Date.now(),
        callId,
        key,
        tool,
        argsHash,
        effectClass,
        status: 'pending',
        ...(compensation === undefined ? {} : { compensation }),
      })
      pendingCalls.set(callId, session)
    } catch (error: unknown) {
      warn(ctx.logger, 'could not record effect intent', error)
    }
    return next()
  })

  ctx.on('tools/result', (exec: ToolExecutionLike, result: ToolResultLike) => {
    try {
      const callId = callIdOf(exec.callId)
      const session = sessionIdOf(exec.agent) ?? pendingCalls.get(callId) ?? stableAgentKey(exec.agent)
      const ledger = ledgerFor(session)
      const prior = ledger.recordsByCall.get(callId)
      pendingCalls.delete(callId)

      const tool = prior?.tool
        ?? (typeof exec.name === 'string' && exec.name.length > 0 ? exec.name : 'unknown-tool')
      const args = exec.arguments ?? null
      const derived = prior === undefined ? keyFor(tool, args) : { key: prior.key, argsHash: prior.argsHash }
      const effectClass = prior?.effectClass ?? classify(tool, args, overrides, policies)
      const status = effectTransition(prior?.status ?? 'pending', result?.isError === false ? 'commit' : 'fail')
      // A terminal effect (or a duplicate completion) must not be overwritten.
      if (prior !== undefined && status === prior.status) return

      const compensation = prior?.compensation ?? policies.get(tool)?.compensation
      appendAndApply(ledger, {
        v: 1,
        at: prior?.at ?? Date.now(),
        callId,
        key: derived.key,
        tool,
        argsHash: derived.argsHash,
        effectClass,
        status,
        finishedAt: Date.now(),
        ...(status === 'failed' ? { error: errorText(result) } : {}),
        ...(compensation === undefined ? {} : { compensation }),
      })
    } catch (error: unknown) {
      warn(ctx.logger, 'could not record effect result', error)
    }
  })

  ctx.on('agent/created', (payload: { agent?: AgentLike }) => {
    try {
      const agent = payload?.agent
      if (agent === undefined) return
      const session = sessionKeyOf(agent)
      if (createdSessions.has(session)) return
      createdSessions.add(session)

      const file = ledgerFile(dir, session)
      if (!existsSync(file)) return
      const ledger = ledgerFor(session)
      const now = Date.now()
      const pending = [...ledger.recordsByCall.values()].filter(record => record.status === 'pending')
      for (const record of pending) {
        appendAndApply(ledger, { ...record, status: 'unknown', finishedAt: now })
      }
    } catch (error: unknown) {
      warn(ctx.logger, 'could not reconcile pending effects', error)
    }
  })

  const statusTool: ToolDefinitionLike = {
    name: 'effect_status',
    description: 'Report unresolved side effects (pending or unknown) and status counts for one session. '
      + 'Use this after a crash or a denied irreversible retry to inspect the side-effect ledger.',
    parameters: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Session id to inspect. Omit to inspect the current session.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          session: { type: 'string' },
          unresolved: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                key: { type: 'string' },
                tool: { type: 'string' },
                class: { type: 'string', enum: ['pure', 'idempotent', 'reversible', 'irreversible'] },
                status: { type: 'string', enum: ['pending', 'unknown'] },
                at: { type: 'integer' },
              },
              required: ['key', 'tool', 'class', 'status', 'at'],
              additionalProperties: false,
            },
          },
          counts: {
            type: 'object',
            properties: {
              pending: { type: 'integer' },
              unknown: { type: 'integer' },
              committed: { type: 'integer' },
              failed: { type: 'integer' },
              compensated: { type: 'integer' },
              abandoned: { type: 'integer' },
              total: { type: 'integer' },
            },
            required: [
              'pending', 'unknown', 'committed', 'failed', 'compensated', 'abandoned', 'total',
            ],
            additionalProperties: false,
          },
        },
        required: ['ok', 'session', 'unresolved', 'counts'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const unresolved = value.unresolved as Array<{ tool: string; class: string; status: string; key: string }>
        const counts = value.counts as EffectCounts
        const header = `Session ${String(value.session)}: ${counts.total} effects `
          + `(pending ${counts.pending}, unknown ${counts.unknown}, committed ${counts.committed}, `
          + `failed ${counts.failed}, compensated ${counts.compensated}, abandoned ${counts.abandoned}).`
        if (unresolved.length === 0) return [{ type: 'text', text: `${header}\nNo unresolved effects.` }]
        const lines = unresolved.map(record =>
          `- ${record.tool} [${record.class}/${record.status}] key ${record.key.slice(0, 12)}…`)
        return [{ type: 'text', text: `${header}\n${lines.join('\n')}` }]
      },
    },
    async execute(rawArgs: Record<string, unknown>, exec: ToolExecutionLike) {
      const requested = typeof rawArgs.session_id === 'string' && rawArgs.session_id.trim().length > 0
        ? rawArgs.session_id.trim()
        : undefined
      const session = requested ?? sessionKeyOf(exec.agent)
      const callId = typeof exec.callId === 'string' ? exec.callId : undefined
      const ledger = ledgerFor(session)
      // The pre-execute hook records this very call before execute runs; do not
      // report the status query itself as an unresolved effect.
      const records = [...ledger.recordsByCall.values()]
        .filter(record => !isInFlightEffectTool(record, callId))
      const counts = countRecords(records)
      const unresolved = records
        .filter(record => record.status === 'pending' || record.status === 'unknown')
        .sort((left, right) => left.at - right.at)
        .map(record => ({
          key: record.key,
          tool: record.tool,
          class: record.effectClass,
          status: record.status as 'pending' | 'unknown',
          at: record.at,
        }))

      return { ok: true, session, unresolved, counts }
    },
  }

  const reconcileTool: ToolDefinitionLike = {
    name: 'effect_reconcile',
    description: 'Plan recovery for unresolved side effects (pending or unknown) in one session. '
      + 'Pure and idempotent effects are marked replay; reversible effects with a configured compensation '
      + 'are marked compensate; irreversible effects are marked query. This tool never executes side effects '
      + 'in either dry_run or normal mode; after checking the real world, record the outcome with effect_resolve.',
    parameters: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Session id to reconcile. Omit to inspect the current session.',
        },
        dry_run: {
          type: 'boolean',
          description: 'Return only the plan. Normal mode is also read-only and returns the same plan.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          session: { type: 'string' },
          plan: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                callId: { type: 'string' },
                key: { type: 'string' },
                tool: { type: 'string' },
                effectClass: { type: 'string', enum: ['pure', 'idempotent', 'reversible', 'irreversible'] },
                status: { type: 'string', enum: ['pending', 'unknown'] },
                decision: { type: 'string', enum: ['replay', 'compensate', 'query'] },
                reason: { type: 'string' },
                compensation: { type: 'string' },
              },
              required: ['callId', 'key', 'tool', 'effectClass', 'status', 'decision', 'reason'],
              additionalProperties: false,
            },
          },
          summary: {
            type: 'object',
            properties: {
              replay: { type: 'integer' },
              compensate: { type: 'integer' },
              query: { type: 'integer' },
              unknown: { type: 'integer', description: 'Plan entries whose ledger status is unknown (recovered after a restart).' },
              total: { type: 'integer' },
            },
            required: ['replay', 'compensate', 'query', 'unknown', 'total'],
            additionalProperties: false,
          },
        },
        required: ['session', 'plan', 'summary'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const summary = value.summary as {
          replay: number
          compensate: number
          query: number
          unknown: number
          total: number
        }
        const plan = value.plan as Array<{
          tool: string
          effectClass: string
          status: string
          decision: string
          compensation?: string
        }>
        const header = `Session ${String(value.session)}: ${summary.total} unresolved `
          + `(replay ${summary.replay}, compensate ${summary.compensate}, query ${summary.query}, `
          + `unknown ${summary.unknown}).`
        if (plan.length === 0) return [{ type: 'text', text: `${header}\nNothing to reconcile.` }]
        const lines = plan.map(entry => `- ${entry.tool} [${entry.effectClass}/${entry.status}] -> ${entry.decision}`
          + (entry.compensation === undefined ? '' : `: ${entry.compensation}`))
        return [{ type: 'text', text: `${header}\n${lines.join('\n')}` }]
      },
    },
    async execute(rawArgs: Record<string, unknown>, exec: ToolExecutionLike) {
      // dry_run and normal mode are both read-only; the parameter is accepted
      // so callers can express intent without changing the plan.
      const requested = typeof rawArgs.session_id === 'string' && rawArgs.session_id.trim().length > 0
        ? rawArgs.session_id.trim()
        : undefined
      const session = requested ?? sessionKeyOf(exec.agent)
      const callId = typeof exec.callId === 'string' ? exec.callId : undefined
      const ledger = ledgerFor(session)
      const records = [...ledger.recordsByCall.values()]
        .filter(record => !isInFlightEffectTool(record, callId))
        .filter(record => record.status === 'pending' || record.status === 'unknown')
        .sort((left, right) => left.at - right.at)

      const summary = { replay: 0, compensate: 0, query: 0, unknown: 0, total: 0 }
      const plan = records.map(record => {
        const compensation = record.compensation ?? policies.get(record.tool)?.compensation
        const { decision, reason } = reconcileDecision(record.effectClass, compensation)
        summary[decision]++
        if (record.status === 'unknown') summary.unknown++
        summary.total++
        return {
          callId: record.callId,
          key: record.key,
          tool: record.tool,
          effectClass: record.effectClass,
          status: record.status as 'pending' | 'unknown',
          decision,
          reason,
          ...(decision === 'compensate' && compensation !== undefined ? { compensation } : {}),
        }
      })

      return { session, plan, summary }
    },
  }

  const resolveTool: ToolDefinitionLike = {
    name: 'effect_resolve',
    description: 'Record the manual outcome of an unresolved side effect after checking the real world. '
      + 'Appends a resolution record whose status is committed, compensated, or abandoned. '
      + 'Terminal effects are never regressed; resolving to the current status is idempotent.',
    parameters: {
      type: 'object',
      properties: {
        callId: { type: 'string', description: 'callId of the unresolved effect to resolve.' },
        resolution: {
          type: 'string',
          enum: ['committed', 'compensated', 'abandoned'],
          description: 'Observed outcome: committed, compensated, or abandoned.',
        },
        note: { type: 'string', description: 'Optional free-text note stored with the resolution record.' },
      },
      required: ['callId', 'resolution'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          resolved: { type: 'boolean' },
          callId: { type: 'string' },
          status: {
            type: 'string',
            enum: ['pending', 'unknown', 'committed', 'failed', 'compensated', 'abandoned'],
          },
          unresolved: { type: 'integer' },
          reason: { type: 'string' },
        },
        required: ['resolved', 'callId', 'status', 'unresolved'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const outcome = value.resolved === true ? 'Resolved' : 'Not resolved'
        const reason = typeof value.reason === 'string' ? ` (${value.reason})` : ''
        return [{
          type: 'text',
          text: `${outcome} ${String(value.callId)} as ${String(value.status)}; `
            + `${String(value.unresolved)} unresolved effect(s) remain.${reason}`,
        }]
      },
    },
    async execute(rawArgs: Record<string, unknown>, exec: ToolExecutionLike) {
      const callId = typeof rawArgs.callId === 'string' ? rawArgs.callId.trim() : ''
      if (callId.length === 0) throw new Error('effect_resolve: callId is required')
      const resolution = rawArgs.resolution
      if (resolution !== 'committed' && resolution !== 'compensated' && resolution !== 'abandoned') {
        throw new Error('effect_resolve: resolution must be one of committed, compensated, abandoned')
      }
      const rawNote = typeof rawArgs.note === 'string' ? rawArgs.note.trim() : ''
      const note = rawNote.length > 0 ? rawNote : undefined

      const session = sessionKeyOf(exec.agent)
      const ledger = ledgerFor(session)
      const current = ledger.recordsByCall.get(callId)
      if (current === undefined) {
        throw new Error(`effect_resolve: no effect record for callId "${callId}" in session "${session}"`)
      }
      const selfCallId = typeof exec.callId === 'string' ? exec.callId : undefined
      const nextStatus = effectTransition(current.status, RESOLUTION_EVENT[resolution])

      if (nextStatus === current.status) {
        const unresolved = unresolvedCount(ledger, selfCallId)
        if (current.status === resolution) {
          // Idempotent: the requested state is already recorded.
          return { resolved: true, callId, status: current.status, unresolved }
        }
        return {
          resolved: false,
          callId,
          status: current.status,
          unresolved,
          reason: `${current.status} is terminal and cannot become ${resolution}`,
        }
      }

      appendAndApply(ledger, {
        v: 1,
        at: current.at,
        callId,
        key: current.key,
        tool: current.tool,
        argsHash: current.argsHash,
        effectClass: current.effectClass,
        status: nextStatus,
        finishedAt: Date.now(),
        ...(current.compensation === undefined ? {} : { compensation: current.compensation }),
        ...(note === undefined ? {} : { resolutionNote: note }),
      })

      return { resolved: true, callId, status: nextStatus, unresolved: unresolvedCount(ledger, selfCallId) }
    },
  }

  for (const definition of [statusTool, reconcileTool, resolveTool]) {
    try {
      ctx.tools.register(definition)
    } catch (error: unknown) {
      warn(ctx.logger, `could not register ${definition.name}`, error)
    }
  }
}

function policyMap(raw: EffectOptions['effectPolicies']): Map<string, EffectPolicy> {
  const policies = new Map<string, EffectPolicy>()
  if (raw === undefined) return policies
  for (const [name, value] of Object.entries(raw)) {
    if (value === null || typeof value !== 'object') continue
    const policy: EffectPolicy = {}
    if (EFFECT_CLASSES.has(value.class as EffectClass)) policy.class = value.class
    const compensation = typeof value.compensation === 'string' ? value.compensation.trim() : ''
    if (compensation.length > 0) policy.compensation = compensation
    if (policy.class !== undefined || policy.compensation !== undefined) policies.set(name, policy)
  }
  return policies
}

function classify(
  tool: string,
  args: unknown,
  overrides: ReadonlySet<string>,
  policies: ReadonlyMap<string, EffectPolicy>,
): EffectClass {
  // An explicit irreversibleTools entry always wins, even over a policy that
  // tries to relax the tool; safety overrides convenience.
  if (overrides.has(tool)) return 'irreversible'
  const policyClass = policies.get(tool)?.class
  if (policyClass !== undefined) return policyClass
  if (PURE_TOOLS.has(tool)) return 'pure'
  if (SHELL_TOOLS.has(tool) && shellLooksDangerous(args)) return 'irreversible'
  if (SHELL_TOOLS.has(tool) || REVERSIBLE_TOOLS.has(tool)) return 'reversible'
  // Unknown tools may mutate something; treat them as reversible rather than
  // pure so the ledger does not imply they are free of side effects.
  return 'reversible'
}

function shellLooksDangerous(args: unknown): boolean {
  const command = shellCommand(args)
  return DANGEROUS_COMMAND_PATTERNS.some(pattern => pattern.test(command))
}

function shellCommand(args: unknown): string {
  if (args === null || typeof args !== 'object') return typeof args === 'string' ? args : ''
  const record = args as Record<string, unknown>
  const parts: string[] = []
  for (const field of ['command', 'cmd', 'script', 'shell', 'args']) {
    const value = record[field]
    if (typeof value === 'string') parts.push(value)
    else if (Array.isArray(value)) {
      parts.push(value.filter((part): part is string => typeof part === 'string').join(' '))
    }
  }
  return parts.length > 0 ? parts.join('\n') : canonicalJson(record)
}

function keyFor(tool: string, args: unknown): { key: string; argsHash: string } {
  const json = canonicalJson(args)
  return { key: sha256(`${tool}\n${json}`), argsHash: sha256(json) }
}

function callIdOf(value: unknown): string {
  return typeof value === 'string' && value.length > 0
    ? value
    : `unknown-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function sessionKeyOf(agent: AgentLike | undefined): string {
  return sessionIdOf(agent) ?? stableAgentKey(agent)
}

function ledgerFile(dir: string, session: string): string {
  return join(dir, `${safeFileStem(session)}.jsonl`)
}

function sessionLedger(ledgers: Map<string, SessionLedger>, dir: string, session: string): SessionLedger {
  const file = ledgerFile(dir, session)
  const existing = ledgers.get(file)
  if (existing !== undefined) return existing
  const ledger: SessionLedger = {
    file,
    recordsByCall: new Map(),
    pendingByKey: new Map(),
    counts: emptyCounts(),
    loaded: false,
  }
  ledgers.set(file, ledger)
  loadLedger(ledger)
  return ledger
}

function loadLedger(ledger: SessionLedger): void {
  if (ledger.loaded) return
  ledger.loaded = true
  for (const record of readRecords(ledger.file)) applyRecord(ledger, record)
}

/**
 * Fold one record into the in-memory ledger. The state machine rejects
 * terminal regressions and stale `pending` records that follow an `unknown`
 * intent, so the folded state matches what a full re-read would produce.
 */
function applyRecord(ledger: SessionLedger, incoming: EffectRecord): void {
  const prior = ledger.recordsByCall.get(incoming.callId)
  if (prior === undefined) {
    ledger.recordsByCall.set(incoming.callId, incoming)
    ledger.counts[incoming.status]++
    ledger.counts.total++
    if (isUnresolved(incoming.status)) addPendingKey(ledger, incoming)
    return
  }
  const status = effectTransition(prior.status, STATUS_EVENT[incoming.status])
  if (status === prior.status) return
  ledger.counts[prior.status]--
  ledger.counts[status]++
  if (isUnresolved(prior.status)) removePendingKey(ledger, prior)
  ledger.recordsByCall.set(incoming.callId, incoming)
  if (isUnresolved(status)) addPendingKey(ledger, incoming)
}

function isUnresolved(status: EffectStatus): boolean {
  return status === 'pending' || status === 'unknown'
}

function addPendingKey(ledger: SessionLedger, record: EffectRecord): void {
  let ids = ledger.pendingByKey.get(record.key)
  if (ids === undefined) {
    ids = new Set()
    ledger.pendingByKey.set(record.key, ids)
  }
  ids.add(record.callId)
}

function removePendingKey(ledger: SessionLedger, record: EffectRecord): void {
  const ids = ledger.pendingByKey.get(record.key)
  if (ids === undefined) return
  ids.delete(record.callId)
  if (ids.size === 0) ledger.pendingByKey.delete(record.key)
}

function findUnresolvedPredecessor(ledger: SessionLedger, key: string): EffectRecord | undefined {
  const ids = ledger.pendingByKey.get(key)
  if (ids === undefined) return undefined
  for (const callId of ids) {
    const record = ledger.recordsByCall.get(callId)
    if (record !== undefined && (record.status === 'pending' || record.status === 'unknown')) return record
  }
  return undefined
}

function emptyCounts(): EffectCounts {
  return {
    pending: 0,
    unknown: 0,
    committed: 0,
    failed: 0,
    compensated: 0,
    abandoned: 0,
    total: 0,
  }
}

function countRecords(records: readonly EffectRecord[]): EffectCounts {
  const counts = emptyCounts()
  for (const record of records) counts[record.status]++
  counts.total = records.length
  return counts
}

function isInFlightEffectTool(record: EffectRecord, callId: string | undefined): boolean {
  return callId !== undefined
    && record.callId === callId
    && record.status === 'pending'
    && EFFECT_TOOLS.has(record.tool)
}

function unresolvedCount(ledger: SessionLedger, excludeCallId: string | undefined): number {
  let count = 0
  for (const record of ledger.recordsByCall.values()) {
    if (record.status !== 'pending' && record.status !== 'unknown') continue
    if (isInFlightEffectTool(record, excludeCallId)) continue
    count++
  }
  return count
}

function reconcileDecision(
  effectClass: EffectClass,
  compensation: string | undefined,
): { decision: EffectDecision; reason: string } {
  switch (effectClass) {
    case 'pure':
      return {
        decision: 'replay',
        reason: 'pure effect has no external side effects; replay is safe.',
      }
    case 'idempotent':
      return {
        decision: 'replay',
        reason: 'idempotent effect produces the same result when repeated; replay is safe.',
      }
    case 'reversible':
      return compensation === undefined
        ? {
            decision: 'query',
            reason: 'reversible effect has no configured compensation; inspect the target state first.',
          }
        : {
            decision: 'compensate',
            reason: `reversible effect has a configured compensation: ${compensation}`,
          }
    case 'irreversible':
      return {
        decision: 'query',
        reason: 'irreversible effect cannot be replayed automatically; inspect the target state and resolve it manually.',
      }
    default:
      return {
        decision: 'query',
        reason: 'unknown effect class; inspect the target state before deciding.',
      }
  }
}

function readRecords(file: string): EffectRecord[] {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const records: EffectRecord[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length === 0) continue
    try {
      const parsed = JSON.parse(line) as Partial<EffectRecord>
      if (isEffectRecord(parsed)) records.push(parsed)
    } catch {
      // A torn tail line (crash during append) must not hide the rest.
    }
  }
  return records
}

function isEffectRecord(value: Partial<EffectRecord>): value is EffectRecord {
  return value.v === 1
    && typeof value.at === 'number' && Number.isFinite(value.at)
    && typeof value.callId === 'string' && value.callId.length > 0
    && typeof value.key === 'string' && value.key.length > 0
    && typeof value.tool === 'string' && value.tool.length > 0
    && typeof value.argsHash === 'string'
    && EFFECT_CLASSES.has(value.effectClass as EffectClass)
    && EFFECT_STATUSES.has(value.status as EffectStatus)
    && (value.finishedAt === undefined || typeof value.finishedAt === 'number')
    && (value.error === undefined || typeof value.error === 'string')
    && (value.compensation === undefined || typeof value.compensation === 'string')
    && (value.resolutionNote === undefined || typeof value.resolutionNote === 'string')
}

function appendRecord(ledger: SessionLedger, record: EffectRecord): void {
  const line = `${JSON.stringify(record)}\n`
  let fd = ledger.fd
  if (fd === undefined) {
    mkdirSync(dirname(ledger.file), { recursive: true })
    fd = openSync(ledger.file, 'a')
    ledger.fd = fd
  }
  writeSync(fd, line)
}

function closeLedger(ledger: SessionLedger): void {
  if (ledger.fd === undefined) return
  try {
    closeSync(ledger.fd)
  } catch {
    // Closing a handle we already lost must not break disposal.
  }
  ledger.fd = undefined
}

function appendAndApply(ledger: SessionLedger, record: EffectRecord): void {
  appendRecord(ledger, record)
  applyRecord(ledger, record)
}

function errorText(result: ToolResultLike | undefined): string {
  const message = result?.error?.message
  if (typeof message === 'string' && message.length > 0) return message
  const code = result?.error?.code
  if (typeof code === 'string' && code.length > 0) return `tool error (${code})`
  if (typeof result?.content === 'string' && result.content.length > 0) return result.content.slice(0, 2000)
  return 'tool reported an error'
}
