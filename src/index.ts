/**
 * SuperDSH — a dsh plugin bundle that adds the capabilities the public harness
 * leaves open.
 *
 * Load with an overlay:
 *
 * ```yaml
 * - insert:
 *     - id: super-dsh
 *       name: '/absolute/path/to/super-dsh/dist/index.js'
 *       config:
 *         verify:
 *           command: 'npm test'
 * ```
 *
 * Or install the built bundle as a dsh plugin. Every feature is independently
 * switchable; see README.md and docs/analysis/ for the evidence behind each.
 */

import type { PluginContext, SuperDshConfig } from './plugin-types.ts'
import { applyFuzzyEdit } from './features/fuzzy-edit.ts'
import { applyMemory } from './features/memory.ts'
import { applyAudit } from './features/audit.ts'
import { applyVerify } from './features/verify.ts'
import { applyEffects } from './features/effects.ts'
import { applyArtifacts } from './features/artifacts.ts'
import { applyNotes } from './features/notes.ts'
import { applyRepoMap } from './features/repo-map.ts'
import { applyPatch } from './features/apply-patch.ts'
import { applyKnowledge } from './features/knowledge.ts'
import { applyHandoff } from './features/handoff.ts'
import { applyHistoryCompact } from './features/history-compact.ts'
import { applyReflection } from './features/reflection.ts'
import { applyRepairs } from './features/repairs.ts'
import { applyRetention } from './features/retention.ts'
import { applyReplayPlan } from './replay-plan.ts'
import { applyBudget } from './features/budget.ts'
import { warn } from './shared.ts'

export const name = 'super-dsh'

/** Services touched by the features; the host provides all of them in the base bundle. */
export const inject = ['tools', 'fs', 'systemPrompt', 'workingDirectory']

// Nexus-inspired building blocks for integrations that need them. These are
// not registered as model-facing tools by default.
export {
  capabilityPermits,
  DEFAULT_CAPABILITY_TTL_MS,
  issueCapability,
  verifyCapability,
} from './capability.ts'
export type {
  CapabilityFailureReason,
  CapabilityPayload,
  CapabilityRequest,
  CapabilityVerification,
  IssueCapabilityOptions,
} from './capability.ts'
export { CausalClock } from './causal-clock.ts'
export type { CausalComparison } from './causal-clock.ts'
export {
  decodeWorkerLine,
  encodeWorkerMessage,
  MAX_WORKER_LINE_BYTES,
  validateWorkerMessage,
  WorkerTaskState,
} from './worker-protocol.ts'
export type {
  WorkerCancel,
  WorkerCheckpoint,
  WorkerDecodeResult,
  WorkerExecute,
  WorkerMessage,
  WorkerResult,
  WorkerTaskStatus,
} from './worker-protocol.ts'
export { buildReplayPlan } from './replay-plan.ts'
export type { ReplayAction, ReplayActionKind, ReplayPlan, ReplayPlanStats } from './replay-plan.ts'

type ProfileName = NonNullable<SuperDshConfig['profile']>

type FeatureFlag =
  | 'fuzzyEdit'
  | 'applyPatch'
  | 'memory'
  | 'audit'
  | 'effects'
  | 'artifacts'
  | 'repairs'
  | 'notes'
  | 'repoMap'
  | 'knowledge'
  | 'handoff'
  | 'historyCompact'
  | 'reflection'
  | 'replayPlan'
  | 'verify'
  | 'budget'
  | 'retention'

/** Default core safety/recovery surface. Repair memory is opt-in. */
const CORE_FEATURES: readonly FeatureFlag[] = [
  'fuzzyEdit',
  'applyPatch',
  'memory',
  'audit',
  'effects',
  'artifacts',
]

/** The default profile: core plus project-orientation and session tooling. */
const CODING_FEATURES: readonly FeatureFlag[] = [
  ...CORE_FEATURES,
  'notes',
  'repoMap',
  'knowledge',
  'handoff',
  'historyCompact',
  'reflection',
  'replayPlan',
]

/**
 * Everything, including the opt-in operational groups. Verify, budget, and
 * retention still require their config; the profile alone never enables them.
 */
const FULL_FEATURES: readonly FeatureFlag[] = [...CODING_FEATURES, 'verify', 'budget', 'retention']

const PROFILE_FEATURES: Record<ProfileName, ReadonlySet<FeatureFlag>> = {
  core: new Set(CORE_FEATURES),
  coding: new Set(CODING_FEATURES),
  full: new Set(FULL_FEATURES),
}

const CONFIG_REQUIRED_FEATURES: ReadonlySet<FeatureFlag> = new Set(['verify', 'budget', 'retention'])

function isOptionsObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Resolve one feature. An explicit boolean or options object wins over the
 * profile; `false` always disables. Unset flags follow the profile, except for
 * verify/budget/retention, which full only enables when configured.
 */
function featureEnabled(config: SuperDshConfig, feature: FeatureFlag, profile: ProfileName): boolean {
  const setting = config[feature]
  if (setting === false) return false
  if (setting === true || isOptionsObject(setting)) return true
  const features = PROFILE_FEATURES[profile] ?? PROFILE_FEATURES.coding
  if (!features.has(feature)) return false
  return !CONFIG_REQUIRED_FEATURES.has(feature)
}

export function apply(ctx: PluginContext, rawConfig: SuperDshConfig = {}): void {
  const config: SuperDshConfig = rawConfig ?? {}
  const profile = config.profile ?? 'core'
  const enabled = (feature: FeatureFlag): boolean => featureEnabled(config, feature, profile)

  if (enabled('effects')) guard(ctx, 'effects', () => applyEffects(ctx, config))
  if (enabled('artifacts')) guard(ctx, 'artifacts', () => applyArtifacts(ctx, config))
  if (enabled('notes')) guard(ctx, 'notes', () => applyNotes(ctx, config))
  if (enabled('repoMap')) guard(ctx, 'repo-map', () => applyRepoMap(ctx, config))
  if (enabled('applyPatch')) guard(ctx, 'apply-patch', () => applyPatch(ctx, config))
  if (enabled('knowledge')) guard(ctx, 'knowledge', () => applyKnowledge(ctx, config))
  if (enabled('fuzzyEdit')) guard(ctx, 'fuzzy-edit', () => applyFuzzyEdit(ctx, config))
  if (enabled('memory')) guard(ctx, 'memory', () => applyMemory(ctx, config))
  if (enabled('audit')) guard(ctx, 'audit', () => applyAudit(ctx, config))
  if (enabled('handoff')) guard(ctx, 'handoff', () => applyHandoff(ctx, config))
  if (enabled('historyCompact')) guard(ctx, 'history-compact', () => applyHistoryCompact(ctx, config))
  if (enabled('reflection')) guard(ctx, 'reflection', () => applyReflection(ctx, config))
  if (enabled('repairs')) guard(ctx, 'repairs', () => applyRepairs(ctx, config))
  if (enabled('replayPlan')) guard(ctx, 'replay-plan', () => applyReplayPlan(ctx, config))
  if (enabled('budget')) guard(ctx, 'budget', () => applyBudget(ctx, config))
  if (enabled('retention')) guard(ctx, 'retention', () => applyRetention(ctx, config))
  if (enabled('verify')) guard(ctx, 'verify', () => applyVerify(ctx, config))
}

function guard(ctx: PluginContext, feature: string, load: () => void): void {
  try {
    load()
  } catch (error: unknown) {
    warn(ctx.logger, `${feature} feature failed to load`, error)
  }
}

export default { name, inject, apply }
