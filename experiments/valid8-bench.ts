/**
 * Experiment: is valid8 worth using as an output-validation gate?
 *
 * 20 code fragments (10 correct, 10 buggy) are fed to a fresh
 * ValidationNetwork. Each fragment is checked with:
 *   - runSyntaxValidation(code, 'sample.ts')
 *   - runSecurityValidation(code)   (no permission ruleset, no external scanner)
 *
 * A fragment is flagged when either layer's score is below the default
 * threshold (0.7). Correct fragments that get flagged are false positives;
 * buggy fragments that get flagged are true positives.
 *
 * Correct fragments include deliberate false-positive probes: three use
 * `any`, two use console.log, and one uses an empty catch that is acceptable
 * for the business logic. Buggy fragments cover syntax errors, duplicate
 * declarations, mismatched brackets, an obvious command-concatenation
 * injection, an off-by-one loop, an assignment in a condition, and a missing
 * await.
 *
 * Decision:
 *   add-narrow-validator iff false-positive rate <= 10% AND true-positive
 *   rate >= 50%.
 *
 * If TypeScript is unavailable (or incompatible) the AST layer silently
 * degrades to regex fallback. That is recorded explicitly.
 *
 * Run: bun experiments/valid8-bench.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ValidationNetwork } from '../../awesome-agent-infra/packages/valid8/src/index.ts'

type Expectation = 'correct' | 'buggy'

interface Fragment {
  id: string
  expectation: Expectation
  category: string
  description: string
  code: string
}

interface LayerResult {
  score: number
  report: string
  flagged: boolean
}

interface FragmentOutcome {
  id: string
  expectation: Expectation
  category: string
  description: string
  syntax: LayerResult
  security: LayerResult
  flagged: boolean
  flagReasons: string[]
}

interface TypeScriptInfo {
  resolved: boolean
  version?: string
  astAvailable: boolean
  failure?: string
  degradationNote: string
}

const THRESHOLD = 0.7

const FRAGMENTS: Fragment[] = [
  // ── Correct: plain valid TypeScript ────────────────────────────────────
  {
    id: 'correct-sum',
    expectation: 'correct',
    category: 'plain',
    description: 'Typed array reduction',
    code: [
      'export function sum(values: number[]): number {',
      '  return values.reduce((total, value) => total + value, 0)',
      '}',
      '',
    ].join('\n'),
  },
  {
    id: 'correct-interface',
    expectation: 'correct',
    category: 'plain',
    description: 'Interface plus nullish fallback',
    code: [
      'export interface User {',
      '  id: string',
      '  email: string',
      '}',
      '',
      'export function displayName(user: User): string {',
      "  return user.email.split('@')[0] ?? user.id",
      '}',
      '',
    ].join('\n'),
  },
  {
    id: 'correct-async',
    expectation: 'correct',
    category: 'plain',
    description: 'Async function with await',
    code: [
      'export async function loadValue(',
      '  key: string,',
      '  store: Map<string, string>,',
      '): Promise<string | undefined> {',
      '  await Promise.resolve()',
      '  return store.get(key)',
      '}',
      '',
    ].join('\n'),
  },
  {
    id: 'correct-discriminated-union',
    expectation: 'correct',
    category: 'plain',
    description: 'Discriminated union with generic helper',
    code: [
      'export type Result<T> = { ok: true; value: T } | { ok: false; error: string }',
      '',
      'export function unwrap<T>(result: Result<T>): T | undefined {',
      '  return result.ok ? result.value : undefined',
      '}',
      '',
    ].join('\n'),
  },

  // ── Correct: deliberate `any` usage (should not be a hard failure) ─────
  {
    id: 'correct-any-json',
    expectation: 'correct',
    category: 'any',
    description: 'JSON.parse boundary returns any',
    code: [
      'export function parseJson(text: string): any {',
      '  return JSON.parse(text)',
      '}',
      '',
    ].join('\n'),
  },
  {
    id: 'correct-any-payload',
    expectation: 'correct',
    category: 'any',
    description: 'Untrusted payload kept as any at the boundary',
    code: [
      'export function readField(payload: any, field: string): unknown {',
      '  return payload?.[field]',
      '}',
      '',
    ].join('\n'),
  },
  {
    id: 'correct-any-cache',
    expectation: 'correct',
    category: 'any',
    description: 'Loosely typed heterogeneous cache',
    code: [
      'const cache: any = new Map<string, unknown>()',
      '',
      'export function remember(key: string, value: unknown): void {',
      '  cache.set(key, value)',
      '}',
      '',
    ].join('\n'),
  },

  // ── Correct: console output (should not be a hard failure) ────────────
  {
    id: 'correct-console-progress',
    expectation: 'correct',
    category: 'console-log',
    description: 'Progress log in a CLI helper',
    code: [
      'export function reportProgress(done: number, total: number): void {',
      '  console.log(`progress ${done}/${total}`)',
      '}',
      '',
    ].join('\n'),
  },
  {
    id: 'correct-console-error',
    expectation: 'correct',
    category: 'console-log',
    description: 'Failure log in an error path',
    code: [
      'export function reportFailure(message: string): void {',
      '  console.error(`failed: ${message}`)',
      '}',
      '',
    ].join('\n'),
  },

  // ── Correct: empty catch that is acceptable here ──────────────────────
  {
    id: 'correct-empty-catch',
    expectation: 'correct',
    category: 'empty-catch',
    description: 'Fallback port parse; swallowing the parse failure is intended',
    code: [
      'export function parsePort(raw: string, fallback: number): number {',
      '  try {',
      '    const port = Number.parseInt(raw, 10)',
      '    return Number.isFinite(port) ? port : fallback',
      '  } catch {',
      '    return fallback',
      '  }',
      '}',
      '',
    ].join('\n'),
  },

  // ── Buggy: syntax errors ──────────────────────────────────────────────
  {
    id: 'buggy-missing-expression',
    expectation: 'buggy',
    category: 'syntax-error',
    description: 'Missing initializer expression after =',
    code: [
      'const total = ;',
      'export function getTotal(): number {',
      '  return total',
      '}',
      '',
    ].join('\n'),
  },
  {
    id: 'buggy-unclosed-function',
    expectation: 'buggy',
    category: 'syntax-error',
    description: 'Function body never closed',
    code: [
      'export function broken(value: number): number {',
      '  return value + 1',
      '',
    ].join('\n'),
  },

  // ── Buggy: duplicate declarations ────────────────────────────────────
  {
    id: 'buggy-duplicate-const',
    expectation: 'buggy',
    category: 'duplicate-declaration',
    description: 'double const keyword',
    code: [
      'const const retries = 3',
      'export function getRetries(): number {',
      '  return retries',
      '}',
      '',
    ].join('\n'),
  },
  {
    id: 'buggy-duplicate-let',
    expectation: 'buggy',
    category: 'duplicate-declaration',
    description: 'double let keyword',
    code: [
      'let let cache = new Map<string, number>()',
      'export function cacheSize(): number {',
      '  return cache.size',
      '}',
      '',
    ].join('\n'),
  },

  // ── Buggy: mismatched delimiters ─────────────────────────────────────
  {
    id: 'buggy-missing-brace',
    expectation: 'buggy',
    category: 'bracket-mismatch',
    description: 'Missing closing brace on an if block',
    code: [
      'export function maybe(ready: boolean): number {',
      '  if (ready) {',
      '    return 1',
      '  }',
      '',
    ].join('\n'),
  },
  {
    id: 'buggy-missing-paren',
    expectation: 'buggy',
    category: 'bracket-mismatch',
    description: 'Call expression never closed',
    code: [
      "const message = format('start'",
      'export function format(value: string): string {',
      '  return value',
      '}',
      '',
    ].join('\n'),
  },

  // ── Buggy: obvious command-concatenation injection ───────────────────
  {
    id: 'buggy-command-injection',
    expectation: 'buggy',
    category: 'security-command-concat',
    description: 'User input concatenated into a shell command plus a sensitive path',
    code: [
      "import { exec } from 'node:child_process'",
      '',
      'export function cleanup(userInput: string): void {',
      "  const target = '../../etc/passwd'",
      "  exec('rm -rf ' + userInput)",
      '  console.log(`cleaning ${target}`)',
      '}',
      '',
    ].join('\n'),
  },

  // ── Buggy: logic errors that still parse ─────────────────────────────
  {
    id: 'buggy-off-by-one',
    expectation: 'buggy',
    category: 'logic-off-by-one',
    description: 'Loop condition uses <= and reads past the array end',
    code: [
      'export function totalLength(items: string[]): number {',
      '  let total = 0',
      '  for (let i = 0; i <= items.length; i++) {',
      '    total += items[i].length',
      '  }',
      '  return total',
      '}',
      '',
    ].join('\n'),
  },
  {
    id: 'buggy-assignment-condition',
    expectation: 'buggy',
    category: 'assignment-condition',
    description: 'Assignment used where an equality check was intended',
    code: [
      'export function isAdmin(mode: string): boolean {',
      "  if (mode = 'admin') {",
      '    return true',
      '  }',
      '  return false',
      '}',
      '',
    ].join('\n'),
  },
  {
    id: 'buggy-missing-await',
    expectation: 'buggy',
    category: 'unawaited-async',
    description: 'Async write is fire-and-forget',
    code: [
      "import { promises as fs } from 'node:fs'",
      '',
      'export async function save(path: string, data: string): Promise<void> {',
      '  fs.writeFile(path, data)',
      '}',
      '',
    ].join('\n'),
  },
]

function round(value: number, digits = 4): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

async function probeTypeScript(): Promise<TypeScriptInfo> {
  try {
    const ts = await import('typescript') as Record<string, unknown>
    const astAvailable =
      typeof ts.createSourceFile === 'function'
      && typeof ts.ScriptTarget === 'object'
      && ts.ScriptTarget !== null
    const version = typeof ts.version === 'string' ? ts.version : 'unknown'
    let degradationNote = 'AST syntax checks are available.'
    if (!astAvailable) {
      degradationNote =
        `typescript@${version} resolved but does not expose a usable createSourceFile/ScriptTarget API; `
        + 'valid8 catches the failure and falls back to regex-only checks: duplicate '
        + '`const const`/`let let`/`var var` declarations and bare TODO comments. '
        + 'For .ts files the fallback does not check brace or parenthesis balance.'
    }
    return { resolved: true, version, astAvailable, degradationNote }
  } catch (error) {
    return {
      resolved: false,
      astAvailable: false,
      failure: error instanceof Error ? error.message : String(error),
      degradationNote:
        'typescript could not be imported; valid8 runs regex-only checks '
        + '(duplicate same-keyword declarations and bare TODO comments; no delimiter checks for .ts).',
    }
  }
}

function summarizeGroup(outcomes: FragmentOutcome[]) {
  const flagged = outcomes.filter(outcome => outcome.flagged).length
  const byCategory = new Map<string, FragmentOutcome[]>()
  for (const outcome of outcomes) {
    const list = byCategory.get(outcome.category)
    if (list === undefined) byCategory.set(outcome.category, [outcome])
    else list.push(outcome)
  }
  return {
    total: outcomes.length,
    flagged,
    flagRate: round(flagged / outcomes.length),
    avgSyntaxScore: round(
      outcomes.reduce((sum, outcome) => sum + outcome.syntax.score, 0) / outcomes.length,
    ),
    avgSecurityScore: round(
      outcomes.reduce((sum, outcome) => sum + outcome.security.score, 0) / outcomes.length,
    ),
    byCategory: [...byCategory.entries()].map(([category, group]) => ({
      category,
      total: group.length,
      flagged: group.filter(outcome => outcome.flagged).length,
      flagRate: round(group.filter(outcome => outcome.flagged).length / group.length),
      ids: group.map(outcome => outcome.id),
    })),
  }
}

async function run(): Promise<void> {
  const typescript = await probeTypeScript()

  const probeNetwork = new ValidationNetwork()
  const astProbe = await probeNetwork.runSyntaxValidation(
    'const value: any = 1\nconsole.log(value)\n',
    'probe.ts',
  )

  const outcomes: FragmentOutcome[] = []
  for (const fragment of FRAGMENTS) {
    const network = new ValidationNetwork()
    const syntax = await network.runSyntaxValidation(fragment.code, 'sample.ts')
    const security = await network.runSecurityValidation(fragment.code)
    const syntaxFlagged = syntax.score < THRESHOLD
    const securityFlagged = security.score < THRESHOLD
    const flagReasons: string[] = []
    if (syntaxFlagged) flagReasons.push(`syntax score ${syntax.score}: ${syntax.report}`)
    if (securityFlagged) flagReasons.push(`security score ${security.score}: ${security.report}`)
    outcomes.push({
      id: fragment.id,
      expectation: fragment.expectation,
      category: fragment.category,
      description: fragment.description,
      syntax: { score: round(syntax.score), report: syntax.report, flagged: syntaxFlagged },
      security: { score: round(security.score), report: security.report, flagged: securityFlagged },
      flagged: syntaxFlagged || securityFlagged,
      flagReasons,
    })
  }

  const correct = outcomes.filter(outcome => outcome.expectation === 'correct')
  const buggy = outcomes.filter(outcome => outcome.expectation === 'buggy')
  const correctSummary = summarizeGroup(correct)
  const buggySummary = summarizeGroup(buggy)

  const falsePositiveRate = correctSummary.flagRate
  const truePositiveRate = buggySummary.flagRate
  const syntaxOnly = {
    falsePositiveRate: round(correct.filter(outcome => outcome.syntax.flagged).length / correct.length),
    truePositiveRate: round(buggy.filter(outcome => outcome.syntax.flagged).length / buggy.length),
    correctFlagged: correct.filter(outcome => outcome.syntax.flagged).length,
    buggyFlagged: buggy.filter(outcome => outcome.syntax.flagged).length,
  }
  const securityOnly = {
    falsePositiveRate: round(correct.filter(outcome => outcome.security.flagged).length / correct.length),
    truePositiveRate: round(buggy.filter(outcome => outcome.security.flagged).length / buggy.length),
    correctFlagged: correct.filter(outcome => outcome.security.flagged).length,
    buggyFlagged: buggy.filter(outcome => outcome.security.flagged).length,
  }

  const criteria = {
    falsePositiveRateAtMost10Pct: falsePositiveRate <= 0.1,
    truePositiveRateAtLeast50Pct: truePositiveRate >= 0.5,
  }
  const decision = criteria.falsePositiveRateAtMost10Pct && criteria.truePositiveRateAtLeast50Pct
    ? 'add-narrow-validator'
    : 'do-not-add'

  const result = {
    experiment: 'valid8-bench',
    generatedAt: new Date().toISOString(),
    hypothesis:
      'valid8 can act as a narrow output gate: it flags most objectively broken snippets while rarely flagging correct snippets, including deliberate any/console.log/empty-catch cases.',
    source: '../../awesome-agent-infra/packages/valid8/src/index.ts',
    configuration: {
      threshold: THRESHOLD,
      flagRule: 'flagged when syntax score < threshold OR security score < threshold',
      syntaxFile: 'sample.ts',
      securityOptions: 'no permission ruleset, no external scanner',
      fragments: { total: FRAGMENTS.length, correct: correct.length, buggy: buggy.length },
    },
    environment: {
      runtime: `bun ${Bun.version}`,
      node: process.version,
      typescript,
      astProbe: {
        code: 'const value: any = 1\\nconsole.log(value)',
        score: round(astProbe.score),
        report: astProbe.report,
        astIssuesIfActive: 2,
        note: astProbe.score === 1 && astProbe.report === 'Syntax check passed'
          ? 'AST quality checks did not run; only regex fallback was active.'
          : 'AST quality checks appear to be active.',
      },
    },
    summary: {
      correct: correctSummary,
      buggy: buggySummary,
      falsePositiveRate,
      truePositiveRate,
      layers: {
        syntaxOnly,
        securityOnly,
        combined: {
          falsePositiveRate,
          truePositiveRate,
          correctFlagged: correctSummary.flagged,
          buggyFlagged: buggySummary.flagged,
        },
      },
    },
    decisionRules: {
      required: 'false-positive rate <= 0.10 AND true-positive rate >= 0.50',
      criteria,
    },
    decision,
    snippets: outcomes,
  }

  const resultsDir = join(dirname(fileURLToPath(import.meta.url)), 'results')
  mkdirSync(resultsDir, { recursive: true })
  writeFileSync(
    join(resultsDir, 'valid8-bench.json'),
    `${JSON.stringify(result, null, 2)}\n`,
    'utf8',
  )

  console.log('valid8-bench')
  console.log(
    `typescript: ${typescript.resolved ? `resolved${typescript.version ? ` (${typescript.version})` : ''}` : 'unresolved'}`
    + `, AST ${typescript.astAvailable ? 'available' : 'unavailable -> regex fallback'}`,
  )
  if (!typescript.astAvailable) console.log(`note: ${typescript.degradationNote}`)
  console.log(
    `correct: ${correctSummary.flagged}/${correctSummary.total} flagged  FP ${(falsePositiveRate * 100).toFixed(1)}%  `
    + `avg syntax ${correctSummary.avgSyntaxScore.toFixed(3)} / security ${correctSummary.avgSecurityScore.toFixed(3)}`,
  )
  console.log(
    `buggy  : ${buggySummary.flagged}/${buggySummary.total} flagged  TP ${(truePositiveRate * 100).toFixed(1)}%  `
    + `avg syntax ${buggySummary.avgSyntaxScore.toFixed(3)} / security ${buggySummary.avgSecurityScore.toFixed(3)}`,
  )
  console.log(
    `syntax-only: FP ${(syntaxOnly.falsePositiveRate * 100).toFixed(1)}%  TP ${(syntaxOnly.truePositiveRate * 100).toFixed(1)}%`,
  )
  console.log('by buggy category:')
  for (const entry of buggySummary.byCategory) {
    console.log(
      `  ${entry.category.padEnd(24)} ${entry.flagged}/${entry.total} flagged (${(entry.flagRate * 100).toFixed(0)}%)`,
    )
  }
  console.log(`criteria: ${JSON.stringify(criteria)}`)
  console.log(`decision: ${decision}`)
  console.log(`results: ${join(resultsDir, 'valid8-bench.json')}`)
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})
