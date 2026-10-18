/** Measure model-facing tool schema overhead for the three profiles. */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.ts'
import { fakeContext } from '../tests/fake-context.ts'
import type { SuperDshConfig } from '../src/plugin-types.ts'

function applyProfile(config: SuperDshConfig) {
  const dir = mkdtempSync(join(tmpdir(), 'super-dsh-overhead-'))
  const fake = fakeContext({ workingDirectory: dir })
  apply(fake.ctx, config)
  const tools = [...fake.tools.values()].sort((a, b) => a.name.localeCompare(b.name))
  const schema = JSON.stringify(tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })))
  return { tools: tools.length, schemaChars: schema.length, approxTokens: Math.ceil(schema.length / 4) }
}

const profiles = {
  core: applyProfile({ profile: 'core' }),
  coding: applyProfile({ profile: 'coding' }),
  full: applyProfile({
    profile: 'full',
    verify: { command: 'node -e "process.exit(0)"' },
    budget: { maxTokens: 1000 },
    retention: { maxAgeDays: 30 },
  }),
}
const out = join(import.meta.dir, 'results')
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'tool-overhead-bench.json'), JSON.stringify({
  experiment: 'tool-overhead-bench',
  generatedAt: new Date().toISOString(),
  profiles,
}, null, 2) + '\n')
for (const [name, p] of Object.entries(profiles)) {
  console.log(`${name.padEnd(7)} tools=${p.tools} chars=${p.schemaChars} approxTokens=${p.approxTokens}`)
}
