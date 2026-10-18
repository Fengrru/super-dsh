/**
 * SuperDSH — a dsh plugin bundle that adds the capabilities the public harness
 * leaves open: tolerant edits, cross-session project memory, a verification
 * gate, and a tamper-evident audit ledger.
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
 * switchable; see README.md for the experiment that justifies its default.
 */

import type { PluginContext, SuperDshConfig } from './plugin-types.ts'
import { applyFuzzyEdit } from './features/fuzzy-edit.ts'
import { applyMemory } from './features/memory.ts'
import { applyAudit } from './features/audit.ts'
import { applyVerify } from './features/verify.ts'
import { warn } from './shared.ts'

export const name = 'super-dsh'

/** Services touched by the features; the host provides all of them in the base bundle. */
export const inject = ['tools', 'fs', 'systemPrompt', 'workingDirectory']

export function apply(ctx: PluginContext, rawConfig: SuperDshConfig = {}): void {
  const config: SuperDshConfig = rawConfig ?? {}

  if (config.fuzzyEdit !== false) {
    try {
      applyFuzzyEdit(ctx, config)
    } catch (error: unknown) {
      warn(ctx.logger, 'fuzzy-edit feature failed to load', error)
    }
  }

  if (config.memory !== false) {
    try {
      applyMemory(ctx, config)
    } catch (error: unknown) {
      warn(ctx.logger, 'memory feature failed to load', error)
    }
  }

  if (config.audit !== false) {
    try {
      applyAudit(ctx, config)
    } catch (error: unknown) {
      warn(ctx.logger, 'audit feature failed to load', error)
    }
  }

  if (config.verify !== false && config.verify !== undefined) {
    try {
      applyVerify(ctx, config)
    } catch (error: unknown) {
      warn(ctx.logger, 'verify feature failed to load', error)
    }
  }
}

export default { name, inject, apply }
