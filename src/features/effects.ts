/**
 * Side-effect intent/commit ledger, adapted from Nexus Runtime's effects
 * module. Every tool call is recorded before it runs and resolved after it
 * finishes, so an interrupted irreversible action can be detected instead of
 * silently repeated.
 *
 * The ledger is append-only JSONL. A later record with the same callId
 * supersedes an earlier one when the file is folded, which is how a pending
 * intent becomes committed, failed, or unknown after a restart.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
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

type EffectClass = 'pure' | 'idempotent' | 'reversible' | 'irreversible'
type EffectStatus = 'pending' | 'committed' | 'failed' | 'unknown'

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
}

const EFFECT_CLASSES = new Set<EffectClass>(['pure', 'idempotent', 'reversible', 'irreversible'])
const EFFECT_STATUSES = new Set<EffectStatus>(['pending', 'committed', 'failed', 'unknown'])

const PURE_TOOLS = new Set([
  'read', 'grep', 'glob', 'ls', 'lsp', 'web_search',
  'effect_status', 'artifact_get', 'artifact_verify', 'artifact_list',
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

export function applyEffects(ctx: PluginContext, config: SuperDshConfig): void {
  if (config.effects === false) return
  const options = typeof config.effects === 'object' ? config.effects : {}
  const dir = options.dir ?? join(dshHome(), 'super-dsh', 'effects')
  const denyUnresolved = options.denyUnresolvedIrreversible === true
  const overrides = new Set(
    Array.isArray(options.irreversibleTools)
      ? options.irreversibleTools.filter((name): name is string => typeof name === 'string' && name.length > 0)
      : [],
  )
  // Reconciliation runs once per session and process; a second agent/created
  // for the same session in this process must not mark live calls unknown.
  const createdSessions = new Set<string>()
  // callId -> session key, so a tools/result event without an agent can still
  // find the ledger file written by tools/pre-execute.
  const pendingCalls = new Map<string, string>()

  ctx.systemPrompt.section({
    name: 'super-dsh:effects',
    order: 122,
    text: 'Tool calls are recorded in a side-effect ledger before they run. If an irreversible call is denied because '
      + 'an identical earlier call is still unresolved, inspect it with `effect_status`; do not retry the same '
      + 'irreversible action blindly.',
  })

  ctx.on('tools/pre-execute', (exec: ToolExecutionLike, next: () => unknown) => {
    try {
      const session = sessionKeyOf(exec.agent)
      const tool = typeof exec.name === 'string' && exec.name.length > 0 ? exec.name : 'unknown-tool'
      const callId = callIdOf(exec.callId)
      const args = exec.arguments ?? null
      const effectClass = classify(tool, args, overrides)
      const { key, argsHash } = keyFor(tool, args)
      const file = ledgerFile(dir, session)
      // Read before appending: the current intent must not count as its own
      // unresolved predecessor.
      const prior = latestRecords(file)
      const pendingPredecessor = [...prior.values()].find(record => record.key === key && record.status === 'pending')

      appendRecord(file, {
        v: 1,
        at: Date.now(),
        callId,
        key,
        tool,
        argsHash,
        effectClass,
        status: 'pending',
      })
      pendingCalls.set(callId, session)

      if (denyUnresolved && effectClass === 'irreversible' && pendingPredecessor !== undefined) {
        return {
          kind: 'deny',
          reason: `super-dsh effects: an earlier irreversible call to "${tool}" with the same arguments `
            + `(call ${pendingPredecessor.callId}) is still unresolved (${pendingPredecessor.status}). `
            + 'Refusing to repeat an unresolved irreversible side effect; inspect it with effect_status first.',
        }
      }
    } catch (error: unknown) {
      warn(ctx.logger, 'could not record effect intent', error)
    }
    return next()
  })

  ctx.on('tools/result', (exec: ToolExecutionLike, result: ToolResultLike) => {
    try {
      const callId = callIdOf(exec.callId)
      const session = sessionIdOf(exec.agent) ?? pendingCalls.get(callId) ?? stableAgentKey(exec.agent)
      const file = ledgerFile(dir, session)
      const prior = latestRecords(file).get(callId)
      pendingCalls.delete(callId)
      if (prior !== undefined && (prior.status === 'committed' || prior.status === 'failed')) return

      const tool = prior?.tool
        ?? (typeof exec.name === 'string' && exec.name.length > 0 ? exec.name : 'unknown-tool')
      const args = exec.arguments ?? null
      const derived = prior === undefined ? keyFor(tool, args) : { key: prior.key, argsHash: prior.argsHash }
      const effectClass = prior?.effectClass ?? classify(tool, args, overrides)
      const status: EffectStatus = result?.isError === false ? 'committed' : 'failed'
      appendRecord(file, {
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
      const now = Date.now()
      for (const record of latestRecords(file).values()) {
        if (record.status !== 'pending') continue
        appendRecord(file, {
          ...record,
          status: 'unknown',
          finishedAt: now,
        })
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
              total: { type: 'integer' },
            },
            required: ['pending', 'unknown', 'committed', 'failed', 'total'],
            additionalProperties: false,
          },
        },
        required: ['ok', 'session', 'unresolved', 'counts'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const unresolved = value.unresolved as Array<{ tool: string; class: string; status: string; key: string }>
        const counts = value.counts as { pending: number; unknown: number; committed: number; failed: number; total: number }
        const header = `Session ${String(value.session)}: ${counts.total} effects `
          + `(pending ${counts.pending}, unknown ${counts.unknown}, committed ${counts.committed}, failed ${counts.failed}).`
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
      // The pre-execute hook records this very call before execute runs; do not
      // report the status query itself as an unresolved effect.
      const records = [...latestRecords(ledgerFile(dir, session)).values()]
        .filter(record => !(callId !== undefined && record.callId === callId
          && record.tool === 'effect_status' && record.status === 'pending'))

      const counts = { pending: 0, unknown: 0, committed: 0, failed: 0, total: records.length }
      for (const record of records) counts[record.status]++
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

  try {
    ctx.tools.register(statusTool)
  } catch (error: unknown) {
    warn(ctx.logger, 'could not register effect_status', error)
  }
}

function classify(tool: string, args: unknown, overrides: ReadonlySet<string>): EffectClass {
  if (overrides.has(tool)) return 'irreversible'
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

function latestRecords(file: string): Map<string, EffectRecord> {
  const latest = new Map<string, EffectRecord>()
  for (const record of readRecords(file)) latest.set(record.callId, record)
  return latest
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
}

function appendRecord(file: string, record: EffectRecord): void {
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8')
}

function errorText(result: ToolResultLike | undefined): string {
  const message = result?.error?.message
  if (typeof message === 'string' && message.length > 0) return message
  const code = result?.error?.code
  if (typeof code === 'string' && code.length > 0) return `tool error (${code})`
  if (typeof result?.content === 'string' && result.content.length > 0) return result.content.slice(0, 2000)
  return 'tool reported an error'
}
