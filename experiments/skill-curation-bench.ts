/**
 * Experiment — skill curation simulation.
 *
 * Question: would a curator policy (archive stale and near-duplicate skills,
 * pin the most-used skills) improve lexical skill retrieval enough to justify
 * a SuperDSH curator tool?
 *
 * The corpus is fully synthetic: 24 skills (16 active, 4 stale, 4
 * near-duplicates) and 12 queries. Baseline retrieval searches all 24 skills.
 * Treatment first archives near-duplicates (keeping the higher-uses copy),
 * archives stale skills (lastUsedDays > 90 and uses < 2), pins the top 20% of
 * remaining skills by uses, then retrieves from the remaining skills with a
 * small pin boost.
 *
 * Metrics: hit@3, MRR, stale/duplicate share of the top-3, and average
 * candidate description characters (prompt token-cost proxy).
 *
 * This is not Agent-level evidence. Passing the decision rule only yields
 * decision "defer" until the policy is evaluated on the real dsh skill corpus
 * and real agent tasks.
 *
 * Run: bun experiments/skill-curation-bench.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

interface Skill {
  name: string
  description: string
  tags: string[]
  lastUsedDays: number
  uses: number
  duplicateOf?: string
}

interface QueryCase {
  id: string
  query: string
  expectedSkill: string
  scenario: 'clean' | 'crowded'
  note?: string
}

interface SkillScore {
  name: string
  score: number
  lexical: number
  usageBoost: number
  recencyBoost: number
  pinBoost: number
  nameHits: number
  tagHits: number
  descriptionHits: number
  descriptionChars: number
}

interface QueryEvaluation {
  top3: Array<{
    name: string
    score: number
    lexical: number
    usageBoost: number
    recencyBoost: number
    pinBoost: number
  }>
  expectedRank: number
  hitAt3: boolean
  reciprocalRank: number
  noiseSelected: string[]
  noiseSelectionCount: number
  noiseSelectionRate: number
  avgCandidateDescriptionChars: number
}

interface ArchiveEntry {
  reason: 'near-duplicate' | 'stale'
  duplicateOf?: string
  jaccard?: number
}

interface MetricsSummary {
  queries: number
  hitsAt3: number
  hitAt3: number
  mrr: number
  noiseSelections: number
  noiseSelectionRate: number
  queriesWithNoise: number
  avgCandidateDescriptionChars: number
  avgPoolDescriptionChars: number
  searchableSkills: number
}

const TOP_K = 3
const STALE_DAYS = 90
const STALE_USES_BELOW = 2
const DUP_JACCARD_ABOVE = 0.8
const PIN_PERCENT = 0.2
const PIN_BOOST = 0.1

const SCORE_WEIGHTS = {
  name: 3,
  tag: 2,
  description: 1,
  usage: 0.35,
  recency: 0.5,
}

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'for', 'to', 'in', 'of', 'with', 'by',
  'it', 'its', 'on', 'from', 'at', 'as', 'is', 'are', 'be', 'this', 'that',
  'current',
])

const SKILLS: Skill[] = [
  // --- 16 active, useful skills -------------------------------------------
  {
    name: 'run-tests',
    description: 'Run the project test suite and report failing tests with diagnostics',
    tags: ['test', 'suite', 'verification'],
    lastUsedDays: 1,
    uses: 48,
  },
  {
    name: 'type-check',
    description: 'Run the TypeScript compiler in no-emit mode to find type errors',
    tags: ['typescript', 'compiler', 'diagnostics'],
    lastUsedDays: 2,
    uses: 36,
  },
  {
    name: 'format-code',
    description: 'Format source files with the repository formatter and fix style issues',
    tags: ['format', 'style', 'cleanup'],
    lastUsedDays: 5,
    uses: 22,
  },
  {
    name: 'git-diff-review',
    description: 'Review a git diff for bugs, missing tests, and risky changes',
    tags: ['git', 'diff', 'review'],
    lastUsedDays: 3,
    uses: 30,
  },
  {
    name: 'dependency-audit',
    description: 'Scan package dependencies for known vulnerabilities and outdated versions',
    tags: ['security', 'dependencies', 'audit'],
    lastUsedDays: 7,
    uses: 14,
  },
  {
    name: 'build-bundle',
    description: 'Build the production bundle and inspect output size warnings',
    tags: ['build', 'bundle', 'production'],
    lastUsedDays: 4,
    uses: 18,
  },
  {
    name: 'benchmark-performance',
    description: 'Benchmark a function or command and compare latency regressions',
    tags: ['performance', 'benchmark', 'latency'],
    lastUsedDays: 12,
    uses: 9,
  },
  {
    name: 'write-unit-test',
    description: 'Create unit tests for an existing module with edge case coverage',
    tags: ['test', 'unit', 'coverage'],
    lastUsedDays: 6,
    uses: 20,
  },
  {
    name: 'debug-failing-test',
    description: 'Debug a failing test by reproducing it and isolating the root cause',
    tags: ['debug', 'test', 'failing'],
    lastUsedDays: 2,
    uses: 26,
  },
  {
    name: 'release-notes',
    description: 'Draft release notes from merged pull requests and changelog entries',
    tags: ['release', 'changelog', 'notes'],
    lastUsedDays: 15,
    uses: 8,
  },
  {
    name: 'refactor-module',
    description: 'Refactor a module while preserving behavior and public APIs',
    tags: ['refactor', 'module', 'maintain'],
    lastUsedDays: 9,
    uses: 11,
  },
  {
    name: 'update-docs',
    description: 'Update README and API docs to match current behavior',
    tags: ['docs', 'readme', 'documentation'],
    lastUsedDays: 8,
    uses: 16,
  },
  {
    name: 'database-migration',
    description: 'Create and verify a database schema migration with rollback',
    tags: ['database', 'migration', 'schema'],
    lastUsedDays: 21,
    uses: 7,
  },
  {
    name: 'generate-api-client',
    description: 'Generate a typed client from an OpenAPI schema',
    tags: ['api', 'openapi', 'client'],
    lastUsedDays: 25,
    uses: 6,
  },
  {
    name: 'analyze-logs',
    description: 'Analyze application logs to find error patterns and correlations',
    tags: ['logs', 'errors', 'analysis'],
    lastUsedDays: 11,
    uses: 12,
  },
  {
    name: 'review-security',
    description: 'Review code changes for security vulnerabilities and unsafe input handling',
    tags: ['security', 'review', 'vulnerabilities'],
    lastUsedDays: 5,
    uses: 17,
  },

  // --- 4 stale skills (lastUsedDays > 90, uses < 2) ------------------------
  {
    name: 'legacy-test-runner',
    description: 'Run the legacy JUnit test suite on the sunset CI host, upload XML reports, and publish the results to the old dashboard',
    tags: ['test', 'legacy', 'ci', 'xml', 'report'],
    lastUsedDays: 240,
    uses: 1,
  },
  {
    name: 'legacy-typecheck',
    description: 'Run the deprecated TypeScript type checker on the old CI host and report legacy type diagnostics to the build dashboard',
    tags: ['typescript', 'legacy', 'ci', 'report', 'diagnostic'],
    lastUsedDays: 300,
    uses: 1,
  },
  {
    name: 'test-suite-mirror',
    description: 'Synchronize the legacy test suite mirror repository, upload XML reports, and refresh the old documentation index',
    tags: ['svn', 'mirror', 'test', 'suite', 'xml', 'report'],
    lastUsedDays: 180,
    uses: 1,
  },
  {
    name: 'type-error-report',
    description: 'Produce the nightly TypeScript error summary report for the retired build host and email the archive to the old partner',
    tags: ['typescript', 'report', 'ci', 'legacy'],
    lastUsedDays: 400,
    uses: 0,
  },

  // --- 4 near-duplicates of active skills (description Jaccard > 0.8) ------
  {
    name: 'run-tests-legacy',
    description: 'Run the project test suite and report failing tests with detailed diagnostics',
    tags: ['test', 'suite', 'xml', 'ci', 'report'],
    lastUsedDays: 10,
    uses: 4,
    duplicateOf: 'run-tests',
  },
  {
    name: 'type-check-fast',
    description: 'Run the TypeScript compiler in no-emit mode to find type errors quickly',
    tags: ['typescript', 'compiler', 'checker', 'ci', 'diagnostic'],
    lastUsedDays: 18,
    uses: 3,
    duplicateOf: 'type-check',
  },
  {
    name: 'git-diff-review-plus',
    description: 'Review a git diff for bugs, missing tests, and risky code changes',
    tags: ['git', 'diff', 'review', 'code'],
    lastUsedDays: 16,
    uses: 5,
    duplicateOf: 'git-diff-review',
  },
  {
    name: 'debug-failing-test-v2',
    description: 'Debug a failing test by reproducing it and isolating the root cause quickly',
    tags: ['debug', 'test', 'failing'],
    lastUsedDays: 12,
    uses: 6,
    duplicateOf: 'debug-failing-test',
  },
]

const QUERIES: QueryCase[] = [
  {
    id: 'q01',
    query: 'run the test suite on CI and upload XML reports for the repository',
    expectedSkill: 'run-tests',
    scenario: 'crowded',
    note: 'Deliberately crowded by a near-duplicate runner and two legacy test/report tools.',
  },
  {
    id: 'q02',
    query: 'run the TypeScript checker on CI and report type diagnostics',
    expectedSkill: 'type-check',
    scenario: 'crowded',
    note: 'Deliberately crowded by a near-duplicate checker and two stale type/report tools.',
  },
  {
    id: 'q03',
    query: 'format source files and fix style issues',
    expectedSkill: 'format-code',
    scenario: 'clean',
  },
  {
    id: 'q04',
    query: 'review a git diff for bugs missing tests and risky changes',
    expectedSkill: 'git-diff-review',
    scenario: 'clean',
  },
  {
    id: 'q05',
    query: 'scan package dependencies for known security vulnerabilities',
    expectedSkill: 'dependency-audit',
    scenario: 'clean',
  },
  {
    id: 'q06',
    query: 'build the production bundle and inspect output size warnings',
    expectedSkill: 'build-bundle',
    scenario: 'clean',
  },
  {
    id: 'q07',
    query: 'benchmark function latency and compare performance regressions',
    expectedSkill: 'benchmark-performance',
    scenario: 'clean',
  },
  {
    id: 'q08',
    query: 'create unit tests for an existing module with edge case coverage',
    expectedSkill: 'write-unit-test',
    scenario: 'clean',
  },
  {
    id: 'q09',
    query: 'debug a failing test and isolate the root cause',
    expectedSkill: 'debug-failing-test',
    scenario: 'clean',
  },
  {
    id: 'q10',
    query: 'create and verify a database schema migration with rollback',
    expectedSkill: 'database-migration',
    scenario: 'clean',
  },
  {
    id: 'q11',
    query: 'generate a typed API client from an OpenAPI schema',
    expectedSkill: 'generate-api-client',
    scenario: 'clean',
  },
  {
    id: 'q12',
    query: 'review code changes for security vulnerabilities and unsafe input handling',
    expectedSkill: 'review-security',
    scenario: 'clean',
  },
]

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function normalizeToken(token: string): string {
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`
  if (token.length > 3 && token.endsWith('s') && !/(ss|us|is)$/.test(token)) return token.slice(0, -1)
  return token
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0 && !STOPWORDS.has(token))
    .map(normalizeToken)
}

function tokenSet(text: string): Set<string> {
  return new Set(tokenize(text))
}

function uniqueTokens(text: string): string[] {
  return [...tokenSet(text)]
}

function jaccard(left: Set<string>, right: Set<string>): number {
  let intersection = 0
  for (const token of left) {
    if (right.has(token)) intersection++
  }
  const union = left.size + right.size - intersection
  return union === 0 ? 0 : intersection / union
}

function round(value: number, digits = 3): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length
}

function isStale(skill: Skill): boolean {
  return skill.lastUsedDays > STALE_DAYS && skill.uses < STALE_USES_BELOW
}

function chooseKeeper(left: Skill, right: Skill): { kept: Skill; archived: Skill } {
  if (left.uses !== right.uses) {
    return left.uses > right.uses
      ? { kept: left, archived: right }
      : { kept: right, archived: left }
  }
  if (left.lastUsedDays !== right.lastUsedDays) {
    return left.lastUsedDays < right.lastUsedDays
      ? { kept: left, archived: right }
      : { kept: right, archived: left }
  }
  return left.name < right.name
    ? { kept: left, archived: right }
    : { kept: right, archived: left }
}

function findNearDuplicatePairs(skills: Skill[]): Array<{ kept: string; archived: string; jaccard: number }> {
  const pairs: Array<{ kept: string; archived: string; jaccard: number }> = []
  for (let leftIndex = 0; leftIndex < skills.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < skills.length; rightIndex++) {
      const left = skills[leftIndex]
      const right = skills[rightIndex]
      const similarity = jaccard(tokenSet(left.description), tokenSet(right.description))
      if (similarity > DUP_JACCARD_ABOVE) {
        const { kept, archived } = chooseKeeper(left, right)
        pairs.push({ kept: kept.name, archived: archived.name, jaccard: similarity })
      }
    }
  }
  return pairs
}

function scoreSkill(skill: Skill, queryTokens: string[], pinned: boolean): SkillScore {
  const nameTokens = tokenSet(skill.name)
  const tagTokens = tokenSet(skill.tags.join(' '))
  const descriptionTokens = tokenSet(skill.description)

  let lexical = 0
  let nameHits = 0
  let tagHits = 0
  let descriptionHits = 0

  for (const token of queryTokens) {
    if (nameTokens.has(token)) {
      lexical += SCORE_WEIGHTS.name
      nameHits++
    }
    if (tagTokens.has(token)) {
      lexical += SCORE_WEIGHTS.tag
      tagHits++
    }
    if (descriptionTokens.has(token)) {
      lexical += SCORE_WEIGHTS.description
      descriptionHits++
    }
  }

  const usageBoost = SCORE_WEIGHTS.usage * Math.log1p(skill.uses)
  const recencyBoost = SCORE_WEIGHTS.recency * (1 - Math.min(skill.lastUsedDays, 365) / 365)
  const pinBoost = pinned ? PIN_BOOST : 0

  return {
    name: skill.name,
    score: lexical + usageBoost + recencyBoost + pinBoost,
    lexical,
    usageBoost,
    recencyBoost,
    pinBoost,
    nameHits,
    tagHits,
    descriptionHits,
    descriptionChars: skill.description.length,
  }
}

function rankSkills(pool: Skill[], query: string, pinned: Set<string>): SkillScore[] {
  const queryTokens = uniqueTokens(query)
  return pool
    .map((skill) => scoreSkill(skill, queryTokens, pinned.has(skill.name)))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score
      const leftSkill = pool.find((skill) => skill.name === left.name)!
      const rightSkill = pool.find((skill) => skill.name === right.name)!
      if (rightSkill.uses !== leftSkill.uses) return rightSkill.uses - leftSkill.uses
      return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    })
}

function evaluateQuery(
  ranking: SkillScore[],
  expectedSkill: string,
  isNoise: (name: string) => boolean,
): QueryEvaluation {
  const top = ranking.slice(0, TOP_K)
  const expectedRank = ranking.findIndex((row) => row.name === expectedSkill) + 1
  const noiseSelected = top.filter((row) => isNoise(row.name)).map((row) => row.name)

  return {
    top3: top.map((row) => ({
      name: row.name,
      score: round(row.score),
      lexical: round(row.lexical),
      usageBoost: round(row.usageBoost),
      recencyBoost: round(row.recencyBoost),
      pinBoost: round(row.pinBoost),
    })),
    expectedRank,
    hitAt3: expectedRank > 0 && expectedRank <= TOP_K,
    reciprocalRank: expectedRank > 0 ? 1 / expectedRank : 0,
    noiseSelected,
    noiseSelectionCount: noiseSelected.length,
    noiseSelectionRate: noiseSelected.length / TOP_K,
    avgCandidateDescriptionChars: mean(top.map((row) => row.descriptionChars)),
  }
}

function summarizeQueries(evaluations: QueryEvaluation[], searchableSkills: Skill[]): MetricsSummary {
  const hitsAt3 = evaluations.filter((evaluation) => evaluation.hitAt3).length
  const noiseSelections = evaluations.reduce((sum, evaluation) => sum + evaluation.noiseSelectionCount, 0)
  return {
    queries: evaluations.length,
    hitsAt3,
    hitAt3: hitsAt3 / evaluations.length,
    mrr: mean(evaluations.map((evaluation) => evaluation.reciprocalRank)),
    noiseSelections,
    noiseSelectionRate: noiseSelections / (evaluations.length * TOP_K),
    queriesWithNoise: evaluations.filter((evaluation) => evaluation.noiseSelectionCount > 0).length,
    avgCandidateDescriptionChars: mean(evaluations.map((evaluation) => evaluation.avgCandidateDescriptionChars)),
    avgPoolDescriptionChars: mean(searchableSkills.map((skill) => skill.description.length)),
    searchableSkills: searchableSkills.length,
  }
}

function roundMetrics(summary: MetricsSummary): MetricsSummary {
  return {
    ...summary,
    hitAt3: round(summary.hitAt3, 4),
    mrr: round(summary.mrr, 4),
    noiseSelectionRate: round(summary.noiseSelectionRate, 4),
    avgCandidateDescriptionChars: round(summary.avgCandidateDescriptionChars, 2),
    avgPoolDescriptionChars: round(summary.avgPoolDescriptionChars, 2),
  }
}

function main(): void {
  // --- corpus validation ---------------------------------------------------
  assert(SKILLS.length === 24, `expected 24 skills, got ${SKILLS.length}`)
  assert(new Set(SKILLS.map((skill) => skill.name)).size === SKILLS.length, 'skill names must be unique')
  assert(QUERIES.length === 12, `expected 12 queries, got ${QUERIES.length}`)

  const duplicateSkills = SKILLS.filter((skill) => skill.duplicateOf !== undefined)
  const staleSkills = SKILLS.filter((skill) => skill.duplicateOf === undefined && isStale(skill))
  const activeSkills = SKILLS.filter((skill) => skill.duplicateOf === undefined && !isStale(skill))
  assert(activeSkills.length === 16, `expected 16 active skills, got ${activeSkills.length}`)
  assert(staleSkills.length === 4, `expected 4 stale skills, got ${staleSkills.length}`)
  assert(duplicateSkills.length === 4, `expected 4 near-duplicate skills, got ${duplicateSkills.length}`)

  const pairs = findNearDuplicatePairs(SKILLS)
  assert(pairs.length === 4, `expected exactly 4 near-duplicate pairs, got ${pairs.length}`)
  const pairByArchived = new Map(pairs.map((pair) => [pair.archived, pair]))
  for (const pair of pairs) {
    assert(pair.jaccard > DUP_JACCARD_ABOVE, `pair ${pair.kept}/${pair.archived} has Jaccard ${pair.jaccard}`)
    const archivedSkill = SKILLS.find((skill) => skill.name === pair.archived)!
    assert(
      archivedSkill.duplicateOf === pair.kept,
      `detected pair ${pair.kept}/${pair.archived} does not match duplicateOf metadata`,
    )
  }
  for (const skill of duplicateSkills) {
    const pair = pairByArchived.get(skill.name)
    assert(pair !== undefined && pair.kept === skill.duplicateOf, `duplicateOf metadata missing for ${skill.name}`)
  }

  const skillByName = new Map(SKILLS.map((skill) => [skill.name, skill]))
  const duplicateNames = new Set(duplicateSkills.map((skill) => skill.name))
  const staleNames = new Set(staleSkills.map((skill) => skill.name))
  const isNoise = (name: string): boolean => duplicateNames.has(name) || staleNames.has(name)

  for (const queryCase of QUERIES) {
    const expected = skillByName.get(queryCase.expectedSkill)
    assert(expected !== undefined, `query ${queryCase.id} references missing skill ${queryCase.expectedSkill}`)
    assert(!isNoise(expected.name), `query ${queryCase.id} expects a noise skill ${expected.name}`)
  }

  // --- curatorial policy ---------------------------------------------------
  const archived = new Map<string, ArchiveEntry>()
  for (const pair of pairs) {
    archived.set(pair.archived, {
      reason: 'near-duplicate',
      duplicateOf: pair.kept,
      jaccard: round(pair.jaccard, 4),
    })
  }
  for (const skill of staleSkills) {
    if (!archived.has(skill.name)) archived.set(skill.name, { reason: 'stale' })
  }

  const archivedSkills = SKILLS.filter((skill) => archived.has(skill.name))
  const remainingSkills = SKILLS.filter((skill) => !archived.has(skill.name))
  assert(archivedSkills.length === 8, `expected 8 archived skills, got ${archivedSkills.length}`)
  assert(remainingSkills.length === 16, `expected 16 remaining skills, got ${remainingSkills.length}`)

  const pinCount = Math.max(1, Math.ceil(remainingSkills.length * PIN_PERCENT))
  const pinnedNames = [...remainingSkills]
    .sort((left, right) =>
      right.uses - left.uses
      || left.lastUsedDays - right.lastUsedDays
      || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .slice(0, pinCount)
    .map((skill) => skill.name)
  const pinnedSet = new Set(pinnedNames)
  assert(pinnedNames.length === 4, `expected 4 pinned skills, got ${pinnedNames.length}`)
  for (const name of pinnedNames) {
    assert(activeSkills.some((skill) => skill.name === name), `pinned skill ${name} is not active`)
  }

  // --- retrieval evaluation ------------------------------------------------
  const evaluations = QUERIES.map((queryCase) => {
    const baselineRanking = rankSkills(SKILLS, queryCase.query, new Set())
    const treatmentRanking = rankSkills(remainingSkills, queryCase.query, pinnedSet)
    return {
      id: queryCase.id,
      query: queryCase.query,
      expectedSkill: queryCase.expectedSkill,
      scenario: queryCase.scenario,
      note: queryCase.note,
      baseline: evaluateQuery(baselineRanking, queryCase.expectedSkill, isNoise),
      treatment: evaluateQuery(treatmentRanking, queryCase.expectedSkill, isNoise),
    }
  })

  const baselineEvaluation = evaluations.map((evaluation) => evaluation.baseline)
  const treatmentEvaluation = evaluations.map((evaluation) => evaluation.treatment)
  const baseline = summarizeQueries(baselineEvaluation, SKILLS)
  const treatment = summarizeQueries(treatmentEvaluation, remainingSkills)

  const scenarioBreakdown = (() => {
    const summarizeScenario = (scenario: 'clean' | 'crowded') => {
      const subset = evaluations.filter((evaluation) => evaluation.scenario === scenario)
      return {
        queries: subset.length,
        baseline: roundMetrics(summarizeQueries(subset.map((evaluation) => evaluation.baseline), SKILLS)),
        treatment: roundMetrics(summarizeQueries(subset.map((evaluation) => evaluation.treatment), remainingSkills)),
      }
    }
    return {
      clean: summarizeScenario('clean'),
      crowded: summarizeScenario('crowded'),
    }
  })()

  assert(treatment.noiseSelections === 0, 'treatment should exclude every stale/duplicate skill')
  assert(treatment.hitAt3 >= baseline.hitAt3, 'treatment regressed hit@3 in this fixture')

  // --- decision ------------------------------------------------------------
  const hitAt3Delta = treatment.hitAt3 - baseline.hitAt3
  const noiseSelectionReduction = baseline.noiseSelectionRate === 0
    ? 0
    : (baseline.noiseSelectionRate - treatment.noiseSelectionRate) / baseline.noiseSelectionRate
  const candidateCharDelta = treatment.avgCandidateDescriptionChars - baseline.avgCandidateDescriptionChars
  const poolCharDelta = treatment.avgPoolDescriptionChars - baseline.avgPoolDescriptionChars

  const checks = {
    hitAt3Improvement: {
      actual: round(hitAt3Delta, 4),
      required: 0.1,
      pass: hitAt3Delta >= 0.1 - 1e-9,
    },
    noiseSelectionReduction: {
      actual: round(noiseSelectionReduction, 4),
      required: 0.5,
      pass: noiseSelectionReduction >= 0.5 - 1e-9,
    },
    characterCostNotUp: {
      actualCandidateCharDelta: round(candidateCharDelta, 2),
      actualPoolCharDelta: round(poolCharDelta, 2),
      required: 'both <= 0',
      pass: candidateCharDelta <= 1e-9 && poolCharDelta <= 1e-9,
    },
  }

  const ruleDecision = Object.values(checks).every((check) => check.pass)
    ? 'add-curator-tool'
    : 'do-not-add'
  // This experiment is a synthetic simulation. Even when the simulated rule
  // passes, the evidence is not Agent-level and there is no real skill corpus,
  // so the final recommendation is defer rather than add.
  const decision = ruleDecision === 'add-curator-tool' ? 'defer' : 'do-not-add'

  const result = {
    experiment: 'skill-curation-bench',
    generatedAt: new Date().toISOString(),
    evidenceLevel: 'synthetic-simulation',
    hypothesis: 'Archiving stale and near-duplicate skills while pinning high-frequency skills improves top-3 skill retrieval and lowers context cost without hurting retrieval accuracy.',
    caveat: 'Synthetic skills and queries with a lexical retriever. This is not Agent-level evidence and does not measure real dsh skill usage.',
    config: {
      skills: 24,
      activeSkills: 16,
      staleSkills: 4,
      nearDuplicateSkills: 4,
      queries: 12,
      topK: TOP_K,
      staleLastUsedDaysAbove: STALE_DAYS,
      staleUsesBelow: STALE_USES_BELOW,
      nearDuplicateJaccardAbove: DUP_JACCARD_ABOVE,
      pinTopPercent: PIN_PERCENT,
      pinBoost: PIN_BOOST,
      scoreWeights: SCORE_WEIGHTS,
      metricDefinitions: {
        hitAt3: 'Fraction of queries whose expected active skill is ranked in the top 3.',
        mrr: 'Mean reciprocal rank of the expected active skill.',
        noiseSelectionRate: 'Share of all top-3 slots occupied by a stale or near-duplicate skill, averaged over queries.',
        avgCandidateDescriptionChars: 'Mean character count of the three returned candidates per query (prompt token-cost proxy).',
        avgPoolDescriptionChars: 'Mean character count over all searchable skills (curation breadth, not the injected top-3).',
      },
    },
    corpus: {
      skills: SKILLS.map((skill) => ({ ...skill })),
      queries: QUERIES.map((queryCase) => ({ ...queryCase })),
    },
    curation: {
      policyOrder: [
        'Archive near-duplicates, keeping the copy with higher uses.',
        'Archive stale skills (lastUsedDays > 90 and uses < 2).',
        'Pin the top 20% of remaining skills by uses with a small retrieval boost.',
      ],
      nearDuplicatePairs: pairs.map((pair) => ({
        kept: pair.kept,
        archived: pair.archived,
        keptUses: skillByName.get(pair.kept)!.uses,
        archivedUses: skillByName.get(pair.archived)!.uses,
        jaccard: round(pair.jaccard, 4),
      })),
      archived: archivedSkills.map((skill) => {
        const entry = archived.get(skill.name)!
        return {
          name: skill.name,
          reason: entry.reason,
          duplicateOf: entry.duplicateOf,
          jaccard: entry.jaccard,
          lastUsedDays: skill.lastUsedDays,
          uses: skill.uses,
          descriptionChars: skill.description.length,
        }
      }),
      archivedCount: archivedSkills.length,
      pinned: pinnedNames,
      remaining: remainingSkills.map((skill) => skill.name),
    },
    metrics: {
      baseline: roundMetrics(baseline),
      treatment: roundMetrics(treatment),
      scenarioBreakdown,
      delta: {
        hitAt3: round(hitAt3Delta, 4),
        mrr: round(treatment.mrr - baseline.mrr, 4),
        noiseSelectionRate: round(treatment.noiseSelectionRate - baseline.noiseSelectionRate, 4),
        noiseSelectionRelativeReduction: round(noiseSelectionReduction, 4),
        avgCandidateDescriptionChars: round(candidateCharDelta, 2),
        avgPoolDescriptionChars: round(poolCharDelta, 2),
      },
    },
    decision,
    decisionDetail: {
      ruleDecision,
      rule: 'add-curator-tool only if treatment hit@3 >= baseline + 0.10 AND stale/duplicate selection rate falls by >= 50% AND character cost does not rise; otherwise do-not-add.',
      checks,
      evidenceLevel: 'synthetic-simulation',
      simulationOnly: true,
      rationale: ruleDecision === 'add-curator-tool'
        ? 'The simulated thresholds pass, but the advantage comes from a hand-authored synthetic corpus and two deliberately crowded queries. There is no real dsh skill corpus or Agent-level task evidence, so the recommendation is defer, not add.'
        : 'The simulated thresholds do not pass. On this evidence, do not add a curator tool.',
      recommendedNextStep: decision === 'defer'
        ? 'Collect real dsh skill usage and 30-50 real agent tasks, then re-evaluate curation against the real skill corpus and an Agent-level success metric before adding the tool.'
        : 'Keep the current retrieval path and revisit only if real-corpus evidence shows retrieval harm from stale or duplicate skills.',
    },
    perQuery: evaluations,
    limitations: [
      '24 hand-authored synthetic skills and 12 queries are not a sample of the real dsh skill corpus.',
      'Two queries (q01, q02) are deliberately crowded by legacy and near-duplicate tools; they are a stress case, not an estimate of how often such collisions occur in production.',
      'Retrieval is lexical token scoring with hand-set weights; real skill selection may use embeddings, model judgment, or instructions and can behave differently.',
      'Metrics are retrieval-only: no agent task success, latency, or end-to-end context-ablation evidence.',
      'Near-duplicate detection uses description token Jaccard > 0.8; real skill descriptions may need a different threshold or a semantic detector.',
      'Pinning reorders results; this simulation does not measure diversity loss or starvation of long-tail skills.',
    ],
  }

  const resultsDir = join(import.meta.dir, 'results')
  mkdirSync(resultsDir, { recursive: true })
  const resultFile = join(resultsDir, 'skill-curation-bench.json')
  writeFileSync(resultFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8')

  // --- console summary -----------------------------------------------------
  console.log('Skill curation simulation (synthetic corpus; not Agent-level evidence)')
  console.log(`skills                24 = 16 active + 4 stale + 4 near-duplicate`)
  console.log(`queries               12 (10 clean, 2 deliberately crowded)`)
  console.log(`archived              8 (${pairs.length} near-duplicate, ${staleSkills.length} stale)`)
  console.log(`pinned                ${pinnedNames.join(', ')}`)
  console.log('')
  console.log(`baseline hit@3        ${(baseline.hitAt3 * 100).toFixed(1)}%  (${baseline.hitsAt3}/${baseline.queries})`)
  console.log(`treatment hit@3       ${(treatment.hitAt3 * 100).toFixed(1)}%  (${treatment.hitsAt3}/${treatment.queries})`)
  console.log(`  clean queries       ${(scenarioBreakdown.clean.baseline.hitAt3 * 100).toFixed(1)}% -> ${(scenarioBreakdown.clean.treatment.hitAt3 * 100).toFixed(1)}%  (n=${scenarioBreakdown.clean.queries})`)
  console.log(`  crowded queries     ${(scenarioBreakdown.crowded.baseline.hitAt3 * 100).toFixed(1)}% -> ${(scenarioBreakdown.crowded.treatment.hitAt3 * 100).toFixed(1)}%  (n=${scenarioBreakdown.crowded.queries})`)
  console.log(`baseline MRR          ${baseline.mrr.toFixed(3)}`)
  console.log(`treatment MRR         ${treatment.mrr.toFixed(3)}`)
  console.log(`stale/dup selection   ${(baseline.noiseSelectionRate * 100).toFixed(1)}% -> ${(treatment.noiseSelectionRate * 100).toFixed(1)}%  (${baseline.noiseSelections} -> ${treatment.noiseSelections} slots)`)
  console.log(`candidate chars       ${baseline.avgCandidateDescriptionChars.toFixed(1)} -> ${treatment.avgCandidateDescriptionChars.toFixed(1)} (top-3 proxy)`)
  console.log(`pool chars            ${baseline.avgPoolDescriptionChars.toFixed(1)} -> ${treatment.avgPoolDescriptionChars.toFixed(1)} (24 -> 16 skills)`)
  console.log('')
  console.log(`decision              ${decision}  (simulated rule: ${ruleDecision})`)
  for (const [name, check] of Object.entries(checks)) {
    console.log(`  ${name.padEnd(26)} ${check.pass ? 'PASS' : 'FAIL'}`)
  }
  console.log(`wrote ${resultFile}`)
}

main()
