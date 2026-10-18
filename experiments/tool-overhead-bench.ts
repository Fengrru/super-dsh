/** Measure model-facing tool schema overhead for candidate default profiles. */
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeContext } from '../tests/fake-context.ts'
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
import { applyRepairs } from '../src/features/repairs.ts'
import { applyRetention } from '../src/features/retention.ts'
import { applyReplayPlan } from '../src/replay-plan.ts'
import { applyBudget } from '../src/features/budget.ts'

type Feature = 'fuzzy' | 'memory' | 'audit' | 'effects' | 'artifacts' | 'notes' | 'repo' | 'apply' | 'knowledge' | 'handoff' | 'compact' | 'reflect' | 'repairs' | 'replay' | 'verify' | 'budget' | 'retention'
const core: Feature[] = ['fuzzy', 'memory', 'audit', 'effects', 'artifacts', 'apply', 'repairs']
const coding: Feature[] = [...core, 'repo', 'notes', 'knowledge', 'handoff', 'compact', 'reflect', 'replay']
const full: Feature[] = [...coding, 'verify', 'budget', 'retention']

function applySet(features: Set<Feature>) {
  const dir = mkdtempSync(join(tmpdir(), 'super-dsh-overhead-'))
  const f = fakeContext({ workingDirectory: dir })
  if (features.has('fuzzy')) applyFuzzyEdit(f.ctx, {})
  if (features.has('memory')) applyMemory(f.ctx, { memory: { dir: join(dir, 'm') } })
  if (features.has('audit')) applyAudit(f.ctx, { audit: { dir: join(dir, 'a') } })
  if (features.has('effects')) applyEffects(f.ctx, { effects: { dir: join(dir, 'e') } })
  if (features.has('artifacts')) applyArtifacts(f.ctx, { artifacts: { dir: join(dir, 'ar') } })
  if (features.has('notes')) applyNotes(f.ctx, { notes: { dir: join(dir, 'n') } })
  if (features.has('repo')) applyRepoMap(f.ctx, { repoMap: { root: dir } })
  if (features.has('apply')) applyPatch(f.ctx, { applyPatch: { useLocks: false } })
  if (features.has('knowledge')) applyKnowledge(f.ctx, { knowledge: { dir: join(dir, 'k') } })
  if (features.has('handoff')) applyHandoff(f.ctx, {})
  if (features.has('compact')) applyHistoryCompact(f.ctx, {})
  if (features.has('reflect')) applyReflection(f.ctx, {})
  if (features.has('repairs')) applyRepairs(f.ctx, { repairs: { dir: join(dir, 'r') } })
  if (features.has('replay')) applyReplayPlan(f.ctx, {})
  if (features.has('verify')) applyVerify(f.ctx, { verify: { command: 'node -e "process.exit(0)"' } })
  if (features.has('budget')) applyBudget(f.ctx, { budget: { maxTokens: 1000 } })
  if (features.has('retention')) applyRetention(f.ctx, { retention: { dir: join(dir, 'ret') } })
  const tools = [...f.tools.values()].sort((a, b) => a.name.localeCompare(b.name))
  const schema = JSON.stringify(tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })))
  return { tools: tools.length, schemaChars: schema.length, approxTokens: Math.ceil(schema.length / 4), names: tools.map(t => t.name) }
}

const profiles = { core: applySet(new Set(core)), coding: applySet(new Set(coding)), full: applySet(new Set(full)) }
const result = { experiment: 'tool-overhead-bench', generatedAt: new Date().toISOString(), profiles }
const out = join(import.meta.dir, 'results')
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'tool-overhead-bench.json'), JSON.stringify(result, null, 2) + '\n')
for (const [name, p] of Object.entries(profiles)) console.log(`${name.padEnd(7)} tools=${p.tools} chars=${p.schemaChars} approxTokens=${p.approxTokens}`)
