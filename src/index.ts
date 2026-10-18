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

export function apply(ctx: PluginContext, rawConfig: SuperDshConfig = {}): void {
  const config: SuperDshConfig = rawConfig ?? {}

  guard(ctx, 'effects', () => applyEffects(ctx, config))
  guard(ctx, 'artifacts', () => applyArtifacts(ctx, config))
  guard(ctx, 'notes', () => applyNotes(ctx, config))
  guard(ctx, 'repo-map', () => applyRepoMap(ctx, config))
  guard(ctx, 'apply-patch', () => applyPatch(ctx, config))
  guard(ctx, 'knowledge', () => applyKnowledge(ctx, config))
  guard(ctx, 'fuzzy-edit', () => applyFuzzyEdit(ctx, config))
  guard(ctx, 'memory', () => applyMemory(ctx, config))
  guard(ctx, 'audit', () => applyAudit(ctx, config))
  guard(ctx, 'handoff', () => applyHandoff(ctx, config))
  guard(ctx, 'history-compact', () => applyHistoryCompact(ctx, config))
  guard(ctx, 'reflection', () => applyReflection(ctx, config))
  guard(ctx, 'repairs', () => applyRepairs(ctx, config))
  guard(ctx, 'replay-plan', () => applyReplayPlan(ctx, config))
  guard(ctx, 'budget', () => applyBudget(ctx, config))
  if (config.retention !== undefined && config.retention !== false) {
    guard(ctx, 'retention', () => applyRetention(ctx, config))
  }
  if (config.verify !== undefined && config.verify !== false) {
    guard(ctx, 'verify', () => applyVerify(ctx, config))
  }
}

function guard(ctx: PluginContext, feature: string, load: () => void): void {
  try {
    load()
  } catch (error: unknown) {
    warn(ctx.logger, `${feature} feature failed to load`, error)
  }
}

export default { name, inject, apply }
