/**
 * Experiment 1 — patch reliability under formatting drift.
 *
 * Baseline: dsh's built-in `edit` semantics (exact literal match, must be unique).
 * Treatment: literal first, then `fuzzy-patch` (8 strategies) with a uniqueness
 * guard before applying.
 *
 * The corpus isolates *formatting drift*: the current file differs from the
 * model's remembered `old_string` only in whitespace, indentation, line endings,
 * or token spacing. Ambiguous and no-match controls measure wrong-edit risk.
 *
 * Run: bun experiments/patch-bench.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fuzzyApply } from '../src/fuzzy-apply.ts'

type Mutation = 'exact' | 'space_drift' | 'indent_drift' | 'line_ending_drift' | 'token_drift' | 'context_drift'

interface Case {
  id: string
  template: string
  mutation: Mutation | 'ambiguous' | 'no_match'
  current: string
  oldString: string
  newString: string
  expected: string
  shouldApply: boolean
}

interface Outcome {
  ok: boolean
  content: string
  reason?: string
  strategy?: string
}

interface Row {
  id: string
  template: string
  mutation: string
  shouldApply: boolean
  baseline: Outcome & { correct: boolean; wrong: boolean; ms: number }
  treatment: Outcome & { correct: boolean; wrong: boolean; ms: number }
}

interface Template {
  name: string
  target: string
  replacement: string
  prefix?: string
  suffix?: string
}

const templates: Template[] = [
  {
    name: 'typescript-object',
    prefix: 'import { startServer } from "./server"\n\nexport const defaults = {',
    target: '  port: 3000,\n  host: "localhost",\n  retries: 3,\n  timeoutMs: 2500,',
    replacement: '  port: 8080,\n  host: "0.0.0.0",\n  retries: 5,\n  timeoutMs: 5000,',
    suffix: '\n}\n\nexport function boot() {\n  return startServer(defaults)\n}\n',
  },
  {
    name: 'typescript-function',
    prefix: 'export function retryDelay(attempt: number, baseMs: number): number {\n',
    target: '  if (attempt <= 0) {\n    return baseMs\n  }\n  const jitter = Math.random() * 100\n  return baseMs * 2 ** attempt + jitter',
    replacement: '  if (attempt <= 0) {\n    return 0\n  }\n  const jitter = Math.random() * 250\n  return Math.min(baseMs * 2 ** attempt + jitter, 30_000)',
    suffix: '\n}\n\nexport function canRetry(attempt: number): boolean {\n  return attempt < 5\n}\n',
  },
  {
    name: 'python-method',
    prefix: 'class SessionStore:\n    def __init__(self, path):\n        self.path = path\n\n',
    target: '    def load(self, session_id: str) -> dict:\n        with open(self.path, "r", encoding="utf-8") as handle:\n            raw = handle.read()\n        return json.loads(raw)',
    replacement: '    def load(self, session_id: str) -> dict:\n        target = os.path.join(self.path, f"{session_id}.json")\n        with open(target, "r", encoding="utf-8") as handle:\n            raw = handle.read()\n        return json.loads(raw)',
    suffix: '\n\n    def save(self, session_id: str, value: dict) -> None:\n        raise NotImplementedError\n',
  },
  {
    name: 'rust-match',
    prefix: 'pub fn describe(code: u16) -> &\'static str {\n    match code {\n',
    target: '        200 => "ok",\n        404 => "not_found",\n        429 => "rate_limited",',
    replacement: '        200 => "ok",\n        201 => "created",\n        404 => "not_found",\n        409 => "conflict",',
    suffix: '\n        _ => "unknown",\n    }\n}\n\npub fn is_error(code: u16) -> bool {\n    code >= 400\n}\n',
  },
  {
    name: 'go-struct',
    prefix: 'package config\n\ntype Limits struct {\n',
    target: '\tMaxConcurrent int\n\tMaxQueueDepth int\n\tIdleTimeoutMs int',
    replacement: '\tMaxConcurrent int\n\tMaxQueueDepth int\n\tIdleTimeoutMs int\n\tMaxRetries    int',
    suffix: '\n}\n\nfunc DefaultLimits() Limits {\n\treturn Limits{MaxConcurrent: 8}\n}\n',
  },
  {
    name: 'css-rule',
    prefix: '.toolbar {\n  display: flex;\n',
    target: '  gap: 12px;\n  padding: 8px 16px;\n  border-bottom: 1px solid var(--border);\n  background: var(--surface);',
    replacement: '  gap: 8px;\n  padding: 4px 12px;\n  border-bottom: 1px solid var(--border);\n  background: var(--surface-raised);',
    suffix: '\n}\n\n.toolbar__spacer {\n  flex: 1;\n}\n',
  },
  {
    name: 'yaml-service',
    prefix: 'services:\n  api:\n    image: example/api:1.4.0\n',
    target: '    ports:\n      - "8080:8080"\n    environment:\n      LOG_LEVEL: info\n      WORKERS: "4"',
    replacement: '    ports:\n      - "9090:8080"\n    environment:\n      LOG_LEVEL: warn\n      WORKERS: "8"',
    suffix: '\n    healthcheck:\n      test: ["CMD", "curl", "-f", "http://localhost:8080/health"]\n',
  },
  {
    name: 'sql-query',
    prefix: 'SELECT user_id, COUNT(*) AS sessions\nFROM session_events\n',
    target: "WHERE created_at >= NOW() - INTERVAL '7 days'\n  AND event_type = 'turn_end'\nGROUP BY user_id",
    replacement: "WHERE created_at >= NOW() - INTERVAL '30 days'\n  AND event_type IN ('turn_end', 'turn_aborted')\nGROUP BY user_id",
    suffix: '\nHAVING COUNT(*) > 3\nORDER BY sessions DESC;\n\n-- keep the report bounded\nLIMIT 100;\n',
  },
  {
    name: 'markdown-section',
    prefix: '# Release checklist\n\n## Before tagging\n\n',
    target: '1. Run the full test suite.\n2. Update the changelog.\n3. Bump the package version.\n4. Verify the build on Windows.',
    replacement: '1. Run the full test suite on Windows, macOS, and Linux.\n2. Update the changelog and migration notes.\n3. Bump the package version.\n4. Verify the signed build artifacts.',
    suffix: '\n\n## After tagging\n\n- Publish the release notes.\n- Announce in the community channel.\n',
  },
  {
    name: 'shell-function',
    prefix: '#!/usr/bin/env bash\nset -euo pipefail\n\n',
    target: 'backup_db() {\n  local target="$1"\n  pg_dump "$DATABASE_URL" > "$target"\n  gzip -f "$target"\n}',
    replacement: 'backup_db() {\n  local target="$1"\n  pg_dump --no-owner "$DATABASE_URL" > "$target"\n  gzip -9 -f "$target"\n  sha256sum "$target.gz" > "$target.gz.sha256"\n}',
    suffix: '\n\ncleanup_old_backups() {\n  find ./backups -name "*.gz" -mtime +14 -delete\n}\n',
  },
  {
    name: 'react-component',
    prefix: 'export function Counter({ start = 0 }: { start?: number }) {\n',
    target: '  const [count, setCount] = useState(start)\n  const increment = () => setCount(count + 1)\n  return <button onClick={increment}>Count: {count}</button>',
    replacement: '  const [count, setCount] = useState(start)\n  const increment = () => setCount(value => value + 1)\n  return <button type="button" onClick={increment}>Count: {count}</button>',
    suffix: '\n}\n\nexport function Reset() {\n  return <button>Reset</button>\n}\n',
  },
  {
    name: 'java-method',
    prefix: 'public final class TokenBucket {\n    private long tokens;\n\n',
    target: '    public boolean tryAcquire(long now) {\n        if (tokens <= 0) {\n            return false;\n        }\n        tokens -= 1;\n        return true;\n    }',
    replacement: '    public boolean tryAcquire(long now) {\n        refill(now);\n        if (tokens <= 0) {\n            return false;\n        }\n        tokens -= 1;\n        return true;\n    }',
    suffix: '\n\n    private void refill(long now) {\n        tokens = Math.min(tokens + 1, 10);\n    }\n}\n',
  },
]

function applyLiteral(content: string, oldString: string, newString: string): Outcome {
  const first = content.indexOf(oldString)
  if (first === -1) return { ok: false, content, reason: 'no_exact_match' }
  if (content.indexOf(oldString, first + oldString.length) !== -1) {
    return { ok: false, content, reason: 'ambiguous_exact_match' }
  }
  return {
    ok: true,
    content: content.slice(0, first) + newString + content.slice(first + oldString.length),
  }
}

function applyTreatment(content: string, oldString: string, newString: string): Outcome {
  const result = fuzzyApply(content, oldString, newString)
  return result.ok
    ? { ok: true, content: result.content, strategy: result.strategy }
    : { ok: false, content, reason: result.reason ?? 'refused' }
}

function mutate(oldString: string, mutation: Mutation): string {
  switch (mutation) {
    case 'exact':
      return oldString
    case 'space_drift':
      return oldString
        .replace(/: /g, ':   ')
        .replace(/, /g, ',  ')
        .replace(/ = /g, '  =  ')
    case 'indent_drift':
      return oldString.split('\n').map(line => line.startsWith('  ') ? line.slice(2) : `  ${line}`).join('\n')
    case 'line_ending_drift':
      return oldString.replace(/\n/g, '\r\n')
    case 'token_drift':
      return oldString
        .replace(/\(/g, ' ( ')
        .replace(/\)/g, ' ) ')
        .replace(/\[/g, ' [ ')
        .replace(/\]/g, ' ] ')
        .replace(/\{/g, ' { ')
        .replace(/\}/g, ' } ')
        .replace(/[{},:;]/g, match => ` ${match} `)
    case 'context_drift': {
      const lines = oldString.split('\n')
      if (lines.length < 3) return oldString
      return [...lines.slice(0, 1), '', ...lines.slice(1)].join('\n')
    }
  }
}

function buildCases(): Case[] {
  const cases: Case[] = []
  const mutations: Mutation[] = [
    'exact',
    'space_drift',
    'indent_drift',
    'line_ending_drift',
    'token_drift',
    'context_drift',
  ]
  for (const template of templates) {
    const current = `${template.prefix ?? ''}${template.target}${template.suffix ?? ''}`
    const expected = `${template.prefix ?? ''}${template.replacement}${template.suffix ?? ''}`
    for (const mutation of mutations) {
      cases.push({
        id: `${template.name}--${mutation}`,
        template: template.name,
        mutation,
        current,
        oldString: mutate(template.target, mutation),
        newString: template.replacement,
        expected,
        shouldApply: true,
      })
    }
  }

  // Ambiguity controls: the intended block appears twice verbatim. Both arms
  // must refuse instead of guessing which copy to edit.
  for (const template of templates.slice(0, 4)) {
    const duplicated = `${template.prefix ?? ''}${template.target}${template.suffix ?? ''}`
    const block = `${template.prefix ?? ''}${template.target}${template.suffix ?? ''}`
    const current = `${block}\n${block}`
    cases.push({
      id: `${template.name}--ambiguous`,
      template: template.name,
      mutation: 'ambiguous',
      current,
      oldString: template.target,
      newString: template.replacement,
      expected: current,
      shouldApply: false,
    })
    void duplicated
  }

  // No-match controls: the remembered block does not exist anywhere.
  for (const template of templates.slice(4, 8)) {
    const current = `${template.prefix ?? ''}${template.target}${template.suffix ?? ''}`
    cases.push({
      id: `${template.name}--no_match`,
      template: template.name,
      mutation: 'no_match',
      current,
      oldString: 'function thisSymbolDoesNotExist(input) {\n  return input.map(value => value * 42)\n}',
      newString: 'function replacement() {\n  return null\n}',
      expected: current,
      shouldApply: false,
    })
  }

  return cases
}

function p95(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]
}

function summarize(rows: Row[], arm: 'baseline' | 'treatment'): Record<string, unknown> {
  const outcomes = rows.map(row => row[arm])
  const applicable = rows.filter(row => row.shouldApply)
  const refusals = rows.filter(row => !row.shouldApply)
  return {
    cases: rows.length,
    correct: outcomes.filter(outcome => outcome.correct).length,
    correctRate: round(outcomes.filter(outcome => outcome.correct).length / rows.length),
    appliedOnApplicable: applicable.filter(row => row[arm].ok).length,
    applyRate: round(applicable.filter(row => row[arm].ok).length / applicable.length),
    appliedCorrect: applicable.filter(row => row[arm].correct).length,
    wrongEdits: outcomes.filter(outcome => outcome.wrong).length,
    wrongEditRate: round(outcomes.filter(outcome => outcome.wrong).length / rows.length),
    correctRefusals: refusals.filter(row => !row[arm].ok).length,
    refusalRate: round(refusals.filter(row => !row[arm].ok).length / refusals.length),
    medianMs: round(median(applicable.map(row => row[arm].ms))),
    p95Ms: round(p95(applicable.map(row => row[arm].ms))),
  }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

const cases = buildCases()
const rows: Row[] = cases.map((testCase) => {
  const baselineStart = performance.now()
  const baseline = applyLiteral(testCase.current, testCase.oldString, testCase.newString)
  const baselineMs = performance.now() - baselineStart

  const treatmentStart = performance.now()
  const treatment = applyTreatment(testCase.current, testCase.oldString, testCase.newString)
  const treatmentMs = performance.now() - treatmentStart

  return {
    id: testCase.id,
    template: testCase.template,
    mutation: testCase.mutation,
    shouldApply: testCase.shouldApply,
    baseline: {
      ...baseline,
      correct: baseline.ok === testCase.shouldApply
        && (!baseline.ok || baseline.content === testCase.expected),
      wrong: baseline.ok && baseline.content !== testCase.expected,
      ms: baselineMs,
    },
    treatment: {
      ...treatment,
      correct: treatment.ok === testCase.shouldApply
        && (!treatment.ok || treatment.content === testCase.expected),
      wrong: treatment.ok && treatment.content !== testCase.expected,
      ms: treatmentMs,
    },
  }
})

const byMutation = Object.fromEntries(
  ['exact', 'space_drift', 'indent_drift', 'line_ending_drift', 'token_drift', 'context_drift', 'ambiguous', 'no_match']
    .map((mutation) => {
      const subset = rows.filter(row => row.mutation === mutation)
      return [mutation, {
        cases: subset.length,
        baselineCorrect: subset.filter(row => row.baseline.correct).length,
        treatmentCorrect: subset.filter(row => row.treatment.correct).length,
      }]
    }),
)

const strategies: Record<string, number> = {}
for (const row of rows) {
  if (row.treatment.ok && row.treatment.strategy !== undefined) {
    strategies[row.treatment.strategy] = (strategies[row.treatment.strategy] ?? 0) + 1
  }
}

const result = {
  experiment: 'patch-bench',
  generatedAt: new Date().toISOString(),
  hypothesis: 'A fuzzy fallback recovers formatting-drifted edits without increasing wrong-region edits.',
  corpus: {
    templates: templates.length,
    mutations: 6,
    controls: rows.length - templates.length * 6,
    total: rows.length,
  },
  baseline: summarize(rows, 'baseline'),
  treatment: summarize(rows, 'treatment'),
  byMutation,
  strategies,
  rows,
}

const outDir = join(import.meta.dir, 'results')
mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'patch-bench.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')

console.log('Patch reliability benchmark (formatting drift)')
console.log(`cases: ${rows.length}`)
console.log('metric                      baseline   treatment')
for (const key of ['correctRate', 'applyRate', 'wrongEditRate', 'refusalRate', 'medianMs', 'p95Ms'] as const) {
  console.log(`${key.padEnd(26)} ${String(result.baseline[key]).padStart(8)}   ${String(result.treatment[key]).padStart(8)}`)
}
console.log('strategy distribution:', strategies)
console.log(`wrote ${join(outDir, 'patch-bench.json')}`)

if (result.treatment.wrongEditRate > 0.02) {
  console.error('GUARDRAIL FAILED: treatment wrong-edit rate above 2%')
  process.exitCode = 1
}
if (result.treatment.correctRate < result.baseline.correctRate + 0.2) {
  console.error('HYPOTHESIS NOT SUPPORTED: treatment did not beat baseline by 20 points')
  process.exitCode = 1
}
