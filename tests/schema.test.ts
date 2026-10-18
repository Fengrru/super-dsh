/**
 * Guard against tool schemas that dsh's restricted JSON-Schema subset rejects.
 * dsh validates output schemas at registration and only supports a small keyword
 * set; a stray `maxItems`/`minimum` silently prevents a whole feature from
 * loading (caught by the plugin's own try/catch).
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyFuzzyEdit } from '../src/features/fuzzy-edit.ts'
import { applyMemory } from '../src/features/memory.ts'
import { applyAudit } from '../src/features/audit.ts'
import { applyVerify } from '../src/features/verify.ts'
import { applyEffects } from '../src/features/effects.ts'
import { applyArtifacts } from '../src/features/artifacts.ts'
import { applyNotes } from '../src/features/notes.ts'
import { applyRepoMap } from '../src/features/repo-map.ts'
import { applyPatch } from '../src/features/apply-patch.ts'
import { applyKnowledge } from '../src/features/knowledge.ts'
import { applyHandoff } from '../src/features/handoff.ts'
import { applyHistoryCompact } from '../src/features/history-compact.ts'
import { applyReflection } from '../src/features/reflection.ts'
import { applyReplayPlan } from '../src/replay-plan.ts'
import { applyRepairs } from '../src/features/repairs.ts'
import { applyRetention } from '../src/features/retention.ts'
import { applyBudget } from '../src/features/budget.ts'
import { fakeContext } from './fake-context.ts'
import type { ToolDefinitionLike } from '../src/plugin-types.ts'

const ALLOWED = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items',
  'enum', 'const', 'description', 'title', 'default', 'examples',
  'deprecated', 'readOnly', 'writeOnly', '$comment',
])

function collectTools(): Map<string, ToolDefinitionLike> {
  const dir = mkdtempSync(join(tmpdir(), 'super-dsh-schema-'))
  const fake = fakeContext({ workingDirectory: dir })
  applyFuzzyEdit(fake.ctx, {})
  applyEffects(fake.ctx, { effects: { dir: join(dir, 'effects') } })
  applyArtifacts(fake.ctx, { artifacts: { dir: join(dir, 'artifacts') } })
  applyNotes(fake.ctx, { notes: { dir: join(dir, 'notes') } })
  applyRepoMap(fake.ctx, { repoMap: { root: dir, maxFiles: 10 } })
  applyPatch(fake.ctx, { applyPatch: { useLocks: false } })
  applyKnowledge(fake.ctx, { knowledge: { dir: join(dir, 'knowledge') } })
  applyMemory(fake.ctx, { memory: { dir: join(dir, 'memory') } })
  applyAudit(fake.ctx, { audit: { dir: join(dir, 'audit') } })
  applyHandoff(fake.ctx, {})
  applyHistoryCompact(fake.ctx, {})
  applyReflection(fake.ctx, {})
  applyReplayPlan(fake.ctx, {})
  applyRepairs(fake.ctx, { repairs: { dir: join(dir, 'repairs') } })
  applyRetention(fake.ctx, { retention: { dir: join(dir, 'retention') } })
  applyBudget(fake.ctx, { budget: { maxTokens: 1000 } })
  applyVerify(fake.ctx, { verify: { command: 'node -e "process.exit(0)"' } })
  return fake.tools
}

function assertSupported(node: unknown, path: string, failures: string[]): void {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    node.forEach((item, index) => assertSupported(item, `${path}[${index}]`, failures))
    return
  }
  const record = node as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!ALLOWED.has(key)) failures.push(`${path}.${key} is not supported by dsh's schema subset`)
  }
  const properties = record.properties
  if (properties !== null && typeof properties === 'object' && !Array.isArray(properties)) {
    for (const [name, child] of Object.entries(properties as Record<string, unknown>)) {
      assertSupported(child, `${path}.properties.${name}`, failures)
    }
  }
  if (record.items !== undefined) assertSupported(record.items, `${path}.items`, failures)
  if (Array.isArray(record.oneOf)) {
    record.oneOf.forEach((child, index) => assertSupported(child, `${path}.oneOf[${index}]`, failures))
  }
  const additional = record.additionalProperties
  if (additional !== null && typeof additional === 'object') {
    assertSupported(additional, `${path}.additionalProperties`, failures)
  }
}

describe('dsh tool schema subset', () => {
  test('every registered output and parameter schema uses only supported keywords', () => {
    const tools = collectTools()
    expect(tools.size).toBeGreaterThan(30)
    const failures: string[] = []
    for (const [name, tool] of tools) {
      assertSupported(tool.output.schema, `${name}.output.schema`, failures)
      assertSupported(tool.parameters, `${name}.parameters`, failures)
    }
    expect(failures).toEqual([])
  })
})
