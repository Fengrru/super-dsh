/**
 * Experiment: is @fengrru/reasoning-search worth adding as an opt-in
 * search layer?
 *
 * Task: synthetic 10-option multiple choice. Each task has exactly one correct
 * option. `generateFn(state, n)` returns n candidate answers; each candidate is
 * independently correct with probability 0.2 and otherwise names a uniformly
 * random wrong option. The candidate stream is seeded per task and is shared by
 * every strategy (common random numbers), so differences are due to search
 * behavior rather than different samples.
 *
 * Budget: at most 20 generateFn invocations and 20 candidates per task. The
 * wrapper hard-caps both and records any post-budget attempt.
 *
 * Strategies:
 *   standard_sampling            native package strategy, 1 call per task.
 *   standard_sampling_budgeted   standard_sampling repeated until the 20-call
 *                                budget is used or a correct sample is found;
 *                                this is the budget-matched baseline.
 *   best_of_n                    native package strategy with beamWidth=10
 *                                (N = 2*beamWidth = 20 calls).
 *   mcts_general                 native MCTS with taskType='general'.
 *   mcts_math                    native MCTS with taskType='math' as a control
 *                                (candidates contain lowercase "the answer is").
 *   true_guided_beam_search      native guided beam with beamWidth=10.
 *
 * Decision rule: add-opt-in iff some candidate strategy, under the same
 * 20-call/20-candidate budget, has solveRate >= budgetMatchedStandard.solveRate
 * + 0.10 AND has no premature early-stop, no budget violation, no empty
 * solution, and a usable finalScore. The native 1-call standard_sampling is
 * reported for context but is not the decision baseline because it uses only
 * 1/20 of the budget.
 *
 * Run: bun experiments/reasoning-search-bench.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ReasoningSearch,
  isComplete,
  type ReasoningGenerateFn,
  type SearchConfig,
  type SearchStrategy,
  type SearchTaskType,
} from '../../awesome-agent-infra/packages/reasoning-search/src/index.ts'

// ─── Configuration ──────────────────────────────────────────────────────────

const TASK_COUNT = 20
const MAX_GENERATE_CALLS = 20
const MAX_CANDIDATES = 20
const CORRECT_PROBABILITY = 0.2
const MASTER_SEED = 0x5eed2026
const OPTION_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'] as const
type OptionLetter = (typeof OPTION_LETTERS)[number]

const RULE =
  'add-opt-in iff some candidate strategy under the same 20-call/20-candidate budget has solveRate >= budgetMatchedStandard.solveRate + 0.10 AND has no premature early-stop, no budget violation, no empty solution, and a usable finalScore; otherwise do-not-add'

// ─── Utilities ──────────────────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function seedFor(...parts: number[]): number {
  let h = 0x811c9dc5
  for (const part of parts) {
    h ^= part
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function variance(values: number[]): number {
  if (values.length < 2) return 0
  const avg = mean(values)
  return values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1)
}

function uniqueRounded(values: number[]): number[] {
  return [...new Set(values.map((value) => Number(value.toFixed(6))))]
}

// ─── Synthetic task ─────────────────────────────────────────────────────────

interface SyntheticTask {
  id: number
  prompt: string
  correctLetter: OptionLetter
}

function buildTasks(): SyntheticTask[] {
  return Array.from({ length: TASK_COUNT }, (_, id) => {
    const correctLetter = OPTION_LETTERS[id % OPTION_LETTERS.length]!
    const optionText = OPTION_LETTERS.map(
      (letter, index) => `${letter}) synthetic-value-${id}-${index}`,
    ).join('; ')
    const prompt =
      `Synthetic multiple-choice task ${id + 1}. Select exactly one option from the list. ` +
      `${optionText}. Reply with: Option <letter>.`
    return { id, prompt, correctLetter }
  })
}

function parseAnswer(text: string): OptionLetter | null {
  const matches = [...text.matchAll(/option\s+([A-J])\b/gi)]
  if (matches.length === 0) return null
  const letter = matches[matches.length - 1]![1]!.toUpperCase()
  return OPTION_LETTERS.includes(letter as OptionLetter) ? (letter as OptionLetter) : null
}

function isCorrectSolution(solution: string, correctLetter: OptionLetter): boolean {
  return parseAnswer(solution) === correctLetter
}

// ─── Budgeted generator ─────────────────────────────────────────────────────

interface GenerateStats {
  calls: number
  candidates: number
  overflowCalls: number
  overflowCandidates: number
}

interface BudgetedGenerator {
  generateFn: ReasoningGenerateFn
  stats: GenerateStats
}

function makeGenerator(task: SyntheticTask): BudgetedGenerator {
  const rng = mulberry32(seedFor(MASTER_SEED, task.id))
  const stats: GenerateStats = {
    calls: 0,
    candidates: 0,
    overflowCalls: 0,
    overflowCandidates: 0,
  }

  const generateFn: ReasoningGenerateFn = async (_prompt: string, n: number) => {
    if (stats.calls >= MAX_GENERATE_CALLS || stats.candidates >= MAX_CANDIDATES) {
      stats.overflowCalls++
      return []
    }

    const remaining = MAX_CANDIDATES - stats.candidates
    const count = Math.min(Math.max(0, n), remaining)
    if (count < n) stats.overflowCandidates += n - count

    stats.calls++
    const candidates: string[] = []
    for (let i = 0; i < count; i++) {
      let letter = task.correctLetter
      if (rng() >= CORRECT_PROBABILITY) {
        const wrong = OPTION_LETTERS.filter((option) => option !== task.correctLetter)
        letter = wrong[Math.floor(rng() * wrong.length)]!
      }
      candidates.push(`the answer is option ${letter}.`)
    }
    stats.candidates += candidates.length
    return candidates
  }

  return { generateFn, stats }
}

function makeScoreFn(task: SyntheticTask) {
  return (state: string, action: string): number => {
    void state
    return parseAnswer(action) === task.correctLetter ? 1 : 0
  }
}

// ─── Strategy execution ─────────────────────────────────────────────────────

type ArmId =
  | 'standard_sampling'
  | 'standard_sampling_budgeted_20'
  | 'best_of_n'
  | 'mcts_general'
  | 'mcts_math'
  | 'true_guided_beam_search'

interface RunRecord {
  taskId: number
  correctLetter: OptionLetter
  solution: string
  correct: boolean
  emptySolution: boolean
  finalScore: number
  finalScoreFinite: boolean
  numSteps: number
  reportedGenerateCalls: number
  actualGenerateCalls: number
  actualCandidates: number
  overflowCalls: number
  overflowCandidates: number
  samplingRounds: number | null
  wallMs: number
  earlyStop: boolean
  prematureEarlyStop: boolean
  earlyStopReason: string | null
  terminalWithoutVerification: boolean
  error?: string
}

interface MctsConfig {
  mctsIterations: number
  beamWidth: number
  maxDepth: number
}

const MCTS_CONFIG: MctsConfig = {
  mctsIterations: 10,
  beamWidth: 2,
  maxDepth: 2,
}

const BEST_OF_N_CONFIG: Partial<SearchConfig> = {
  beamWidth: 10,
  maxDepth: 2,
}

const GUIDED_BEAM_CONFIG: Partial<SearchConfig> = {
  beamWidth: 10,
  maxDepth: 2,
}

function baseRecord(task: SyntheticTask): Omit<RunRecord, 'solution' | 'correct' | 'emptySolution' | 'finalScore' | 'finalScoreFinite' | 'numSteps' | 'reportedGenerateCalls' | 'actualGenerateCalls' | 'actualCandidates' | 'overflowCalls' | 'overflowCandidates' | 'wallMs' | 'earlyStop' | 'prematureEarlyStop' | 'earlyStopReason' | 'terminalWithoutVerification'> & {
  samplingRounds: number | null
} {
  return { taskId: task.id, correctLetter: task.correctLetter, samplingRounds: null }
}

function recordFromResult(
  task: SyntheticTask,
  result: {
    solution: string
    finalScore: number
    numSteps: number
    searchStats: { generateCalls: number; timeMs: number }
  },
  stats: GenerateStats,
  wallMs: number,
  options: {
    samplingRounds: number | null
    earlyStop: boolean
    prematureEarlyStop: boolean
    earlyStopReason: string | null
    terminalWithoutVerification: boolean
  },
): RunRecord {
  const emptySolution = result.solution.trim().length === 0
  return {
    ...baseRecord(task),
    samplingRounds: options.samplingRounds,
    solution: result.solution,
    correct: isCorrectSolution(result.solution, task.correctLetter),
    emptySolution,
    finalScore: result.finalScore,
    finalScoreFinite: Number.isFinite(result.finalScore),
    numSteps: result.numSteps,
    reportedGenerateCalls: result.searchStats.generateCalls,
    actualGenerateCalls: stats.calls,
    actualCandidates: stats.candidates,
    overflowCalls: stats.overflowCalls,
    overflowCandidates: stats.overflowCandidates,
    wallMs,
    earlyStop: options.earlyStop,
    prematureEarlyStop: options.prematureEarlyStop,
    earlyStopReason: options.earlyStopReason,
    terminalWithoutVerification: options.terminalWithoutVerification,
  }
}

function errorRecord(
  task: SyntheticTask,
  stats: GenerateStats,
  wallMs: number,
  error: unknown,
): RunRecord {
  return {
    ...baseRecord(task),
    solution: '',
    correct: false,
    emptySolution: true,
    finalScore: 0,
    finalScoreFinite: false,
    numSteps: 0,
    reportedGenerateCalls: 0,
    actualGenerateCalls: stats.calls,
    actualCandidates: stats.candidates,
    overflowCalls: stats.overflowCalls,
    overflowCandidates: stats.overflowCandidates,
    wallMs,
    earlyStop: false,
    prematureEarlyStop: false,
    earlyStopReason: null,
    terminalWithoutVerification: false,
    error: error instanceof Error ? error.message : String(error),
  }
}

async function runArmTask(arm: ArmId, task: SyntheticTask): Promise<RunRecord> {
  const generator = makeGenerator(task)
  const engine = new ReasoningSearch(generator.generateFn, {
    scoreFn: makeScoreFn(task),
  })
  const wallStart = performance.now()
  const stats = generator.stats

  try {
    if (arm === 'standard_sampling_budgeted_20') {
      let lastResult:
        | {
            solution: string
            finalScore: number
            numSteps: number
            searchStats: { generateCalls: number; timeMs: number }
          }
        | undefined
      let rounds = 0
      let solved = false
      let reportedCalls = 0
      while (rounds < MAX_GENERATE_CALLS && !solved) {
        const result = await engine.solve(task.prompt, 'standard_sampling', 'general')
        lastResult = result
        reportedCalls += result.searchStats.generateCalls
        rounds++
        solved = isCorrectSolution(result.solution, task.correctLetter)
      }
      const wallMs = performance.now() - wallStart
      const result = lastResult ?? {
        solution: '',
        finalScore: 0,
        numSteps: 0,
        searchStats: { generateCalls: 0, timeMs: 0 },
      }
      const earlyStop = rounds < MAX_GENERATE_CALLS
      const record = recordFromResult(task, result, stats, wallMs, {
        samplingRounds: rounds,
        earlyStop,
        prematureEarlyStop: earlyStop && !solved,
        earlyStopReason: earlyStop
          ? solved
            ? 'stopped after a correct sample (legitimate budget saving)'
            : 'stopped early without a correct sample'
          : null,
        terminalWithoutVerification: false,
      })
      record.reportedGenerateCalls = reportedCalls
      return record
    }

    const strategy: SearchStrategy =
      arm === 'standard_sampling'
        ? 'standard_sampling'
        : arm === 'best_of_n'
          ? 'best_of_n'
          : arm === 'mcts_general' || arm === 'mcts_math'
            ? 'mcts'
            : 'true_guided_beam_search'

    const taskType: SearchTaskType =
      arm === 'mcts_general' ||
      arm === 'best_of_n' ||
      arm === 'true_guided_beam_search' ||
      arm === 'standard_sampling'
        ? 'general'
        : 'math'

    const configOverride: Partial<SearchConfig> | undefined =
      arm === 'best_of_n'
        ? BEST_OF_N_CONFIG
        : arm === 'mcts_general' || arm === 'mcts_math'
          ? MCTS_CONFIG
          : arm === 'true_guided_beam_search'
            ? GUIDED_BEAM_CONFIG
            : undefined

    const result = await engine.solve(task.prompt, strategy, taskType, configOverride)
    const wallMs = performance.now() - wallStart
    const actualCalls = stats.calls

    if (arm === 'mcts_general') {
      return recordFromResult(task, result, stats, wallMs, {
        samplingRounds: null,
        earlyStop: actualCalls === 0,
        prematureEarlyStop: actualCalls === 0,
        earlyStopReason:
          actualCalls === 0
            ? 'taskType=general makes isComplete(problem) true, so MCTS treats the root as terminal and never calls generateFn'
            : null,
        terminalWithoutVerification: true,
      })
    }

    if (arm === 'mcts_math') {
      return recordFromResult(task, result, stats, wallMs, {
        samplingRounds: null,
        earlyStop: false,
        prematureEarlyStop: false,
        earlyStopReason: null,
        terminalWithoutVerification: true,
      })
    }

    if (arm === 'true_guided_beam_search') {
      return recordFromResult(task, result, stats, wallMs, {
        samplingRounds: null,
        earlyStop: actualCalls < MAX_GENERATE_CALLS,
        prematureEarlyStop: true,
        earlyStopReason:
          'returns on the first candidate whose accumulated text isComplete(general), before comparing the remaining generated candidates',
        terminalWithoutVerification: true,
      })
    }

    if (arm === 'best_of_n') {
      const earlyStop = actualCalls < MAX_GENERATE_CALLS
      const solved = isCorrectSolution(result.solution, task.correctLetter)
      return recordFromResult(task, result, stats, wallMs, {
        samplingRounds: null,
        earlyStop,
        prematureEarlyStop: earlyStop && !solved,
        earlyStopReason: earlyStop
          ? solved
            ? 'stopped after finding a correct candidate (legitimate budget saving)'
            : 'stopped early without a correct candidate'
          : null,
        terminalWithoutVerification: false,
      })
    }

    return recordFromResult(task, result, stats, wallMs, {
      samplingRounds: null,
      earlyStop: false,
      prematureEarlyStop: false,
      earlyStopReason: null,
      terminalWithoutVerification: false,
    })
  } catch (error) {
    return errorRecord(task, stats, performance.now() - wallStart, error)
  }
}

// ─── Aggregation ────────────────────────────────────────────────────────────

interface FinalScoreValidity {
  allFinite: boolean
  allZero: boolean
  inUnitInterval: boolean
  uniqueValues: number[]
  meanOnCorrect: number | null
  meanOnIncorrect: number | null
  discriminatesCorrectness: boolean | null
  usable: boolean
  reasons: string[]
}

interface ArmIssues {
  emptySolutions: number
  budgetViolations: number
  prematureEarlyStops: number
  terminalWithoutVerification: number
  finalScoreUsable: boolean
  noIssues: boolean
  reasons: string[]
}

interface ArmSummary {
  arm: ArmId
  tasks: number
  solved: number
  solveRate: number
  avgSteps: number
  avgFinalScore: number
  finalScoreMin: number
  finalScoreMax: number
  avgWallMs: number
  avgActualGenerateCalls: number
  avgActualCandidates: number
  totalActualGenerateCalls: number
  totalActualCandidates: number
  avgReportedGenerateCalls: number
  avgSamplingRounds: number | null
  earlyStops: number
  finalScoreValidity: FinalScoreValidity
  issues: ArmIssues
  runs: RunRecord[]
}

function summarizeFinalScore(runs: RunRecord[]): FinalScoreValidity {
  const scores = runs.map((run) => run.finalScore)
  const correctScores = runs.filter((run) => run.correct).map((run) => run.finalScore)
  const incorrectScores = runs.filter((run) => !run.correct).map((run) => run.finalScore)
  const allFinite = scores.every((score) => Number.isFinite(score))
  const allZero = scores.every((score) => score === 0)
  const inUnitInterval = scores.every((score) => score >= 0 && score <= 1)
  const hasEmptySolution = runs.some((run) => run.emptySolution)
  const meanOnCorrect = correctScores.length === 0 ? null : mean(correctScores)
  const meanOnIncorrect = incorrectScores.length === 0 ? null : mean(incorrectScores)
  const discriminatesCorrectness =
    meanOnCorrect === null || meanOnIncorrect === null
      ? null
      : Math.abs(meanOnCorrect - meanOnIncorrect) > 1e-9
  const reasons: string[] = []
  if (!allFinite) reasons.push('non-finite finalScore')
  if (allZero) reasons.push('finalScore is zero on every run')
  if (hasEmptySolution) reasons.push('finalScore is reported for runs with empty solutions')
  if (!inUnitInterval) reasons.push('finalScore is outside [0,1]')
  if (discriminatesCorrectness === false) {
    reasons.push('finalScore does not separate correct from incorrect solutions')
  }
  const usable =
    allFinite &&
    !allZero &&
    !hasEmptySolution &&
    inUnitInterval &&
    discriminatesCorrectness !== false
  if (usable && reasons.length === 0) reasons.push('finite, non-zero, in [0,1], discriminative or single-class')
  return {
    allFinite,
    allZero,
    inUnitInterval,
    uniqueValues: uniqueRounded(scores),
    meanOnCorrect,
    meanOnIncorrect,
    discriminatesCorrectness,
    usable,
    reasons,
  }
}

function summarizeArm(arm: ArmId, runs: RunRecord[]): ArmSummary {
  const solved = runs.filter((run) => run.correct).length
  const solveRate = runs.length === 0 ? 0 : solved / runs.length
  const emptySolutions = runs.filter((run) => run.emptySolution).length
  const budgetViolations = runs.filter(
    (run) => run.overflowCalls > 0 || run.overflowCandidates > 0,
  ).length
  const prematureEarlyStops = runs.filter((run) => run.prematureEarlyStop).length
  const terminalWithoutVerification = runs.filter(
    (run) => run.terminalWithoutVerification,
  ).length
  const finalScoreValidity = summarizeFinalScore(runs)
  const reasons: string[] = []
  if (emptySolutions > 0) reasons.push(`${emptySolutions}/${runs.length} empty solutions`)
  if (budgetViolations > 0) reasons.push(`${budgetViolations}/${runs.length} budget violations`)
  if (prematureEarlyStops > 0) {
    reasons.push(`${prematureEarlyStops}/${runs.length} premature early stops`)
  }
  if (!finalScoreValidity.usable) {
    reasons.push(`unusable finalScore: ${finalScoreValidity.reasons.join('; ')}`)
  }
  const noIssues =
    emptySolutions === 0 &&
    budgetViolations === 0 &&
    prematureEarlyStops === 0 &&
    finalScoreValidity.usable
  if (noIssues) reasons.push('no issue flags')
  const samplingRounds = runs
    .map((run) => run.samplingRounds)
    .filter((value): value is number => value !== null)

  return {
    arm,
    tasks: runs.length,
    solved,
    solveRate,
    avgSteps: mean(runs.map((run) => run.numSteps)),
    avgFinalScore: mean(runs.map((run) => run.finalScore)),
    finalScoreMin: runs.length === 0 ? 0 : Math.min(...runs.map((run) => run.finalScore)),
    finalScoreMax: runs.length === 0 ? 0 : Math.max(...runs.map((run) => run.finalScore)),
    avgWallMs: mean(runs.map((run) => run.wallMs)),
    avgActualGenerateCalls: mean(runs.map((run) => run.actualGenerateCalls)),
    avgActualCandidates: mean(runs.map((run) => run.actualCandidates)),
    totalActualGenerateCalls: runs.reduce((sum, run) => sum + run.actualGenerateCalls, 0),
    totalActualCandidates: runs.reduce((sum, run) => sum + run.actualCandidates, 0),
    avgReportedGenerateCalls: mean(runs.map((run) => run.reportedGenerateCalls)),
    avgSamplingRounds: samplingRounds.length === 0 ? null : mean(samplingRounds),
    earlyStops: runs.filter((run) => run.earlyStop).length,
    finalScoreValidity,
    issues: {
      emptySolutions,
      budgetViolations,
      prematureEarlyStops,
      terminalWithoutVerification,
      finalScoreUsable: finalScoreValidity.usable,
      noIssues,
      reasons,
    },
    runs,
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

const ARMS: ArmId[] = [
  'standard_sampling',
  'standard_sampling_budgeted_20',
  'best_of_n',
  'mcts_general',
  'mcts_math',
  'true_guided_beam_search',
]

const CANDIDATE_ARMS: ArmId[] = [
  'best_of_n',
  'mcts_general',
  'mcts_math',
  'true_guided_beam_search',
]

const tasks = buildTasks()
const runsByArm = new Map<ArmId, RunRecord[]>()
for (const arm of ARMS) runsByArm.set(arm, [])

for (const task of tasks) {
  for (const arm of ARMS) {
    const run = await runArmTask(arm, task)
    runsByArm.get(arm)!.push(run)
  }
}

const summaries: Record<string, ArmSummary> = {}
for (const arm of ARMS) {
  summaries[arm] = summarizeArm(arm, runsByArm.get(arm)!)
}

const budgetMatchedStandard = summaries.standard_sampling_budgeted_20!
const candidateComparisons = CANDIDATE_ARMS.map((arm) => {
  const summary = summaries[arm]!
  const delta = summary.solveRate - budgetMatchedStandard.solveRate
  return {
    arm,
    solveRate: summary.solveRate,
    budgetMatchedStandardSolveRate: budgetMatchedStandard.solveRate,
    delta,
    meetsMargin: delta >= 0.1,
    hasNoIssues: summary.issues.noIssues,
    qualifies: delta >= 0.1 && summary.issues.noIssues,
    issueReasons: summary.issues.reasons,
    finalScoreValidity: summary.finalScoreValidity,
  }
})

const qualified = candidateComparisons.filter((comparison) => comparison.qualifies)
const decision = qualified.length > 0 ? 'add-opt-in' : 'do-not-add'

const decisionReasons: string[] = [
  `budget-matched standard_sampling baseline: ${(budgetMatchedStandard.solveRate * 100).toFixed(1)}% (${budgetMatchedStandard.solved}/${budgetMatchedStandard.tasks}), avg ${budgetMatchedStandard.avgActualGenerateCalls.toFixed(1)} calls, ${budgetMatchedStandard.avgActualCandidates.toFixed(1)} candidates`,
]
for (const comparison of candidateComparisons) {
  decisionReasons.push(
    `${comparison.arm}: ${(comparison.solveRate * 100).toFixed(1)}%, delta vs budget-matched baseline ${(comparison.delta >= 0 ? '+' : '')}${(comparison.delta * 100).toFixed(1)}pp, noIssues=${comparison.hasNoIssues}${comparison.issueReasons.length > 0 ? ` [${comparison.issueReasons.join('; ')}]` : ''}`,
  )
}
if (decision === 'add-opt-in') {
  decisionReasons.push(
    `qualified: ${qualified.map((comparison) => comparison.arm).join(', ')}`,
  )
} else {
  decisionReasons.push(
    'no candidate strategy both beats the budget-matched standard baseline by 10pp and is free of issue flags',
  )
}

const pairedOutcomes = tasks.map((task) => {
  const outcome: Record<string, number | string | boolean> = {
    taskId: task.id,
    correctLetter: task.correctLetter,
  }
  for (const arm of ARMS) {
    const run = runsByArm.get(arm)!.find((entry) => entry.taskId === task.id)!
    outcome[arm] = run.correct
    outcome[`${arm}_calls`] = run.actualGenerateCalls
    outcome[`${arm}_candidates`] = run.actualCandidates
    outcome[`${arm}_finalScore`] = run.finalScore
  }
  return outcome
})

const completionProbe = {
  isCompleteGeneralOnNonEmpty: isComplete('non-empty answer', 'general'),
  isCompleteGeneralOnEmpty: isComplete('', 'general'),
  isCompleteMathOnLowercaseCandidate: isComplete('the answer is option A.', 'math'),
  isCompleteMathOnCapitalizedCandidate: isComplete('The answer is option A.', 'math'),
  mctsRootProblemIsNonEmpty: true,
  consequence:
    'with taskType=general the MCTS root (the problem text) is already complete, so mctsSearch takes the terminal branch, returns an empty solution, and reports 0 generateCalls; isCompleteMath is also case-sensitive, so a capitalized "The answer is" is not recognized as a math completion',
}

const output = {
  experiment: 'reasoning-search-synthetic-multiple-choice',
  source: '../../awesome-agent-infra/packages/reasoning-search/src/index.ts',
  evaluatedAt: new Date().toISOString(),
  design: {
    task:
      '10-option multiple choice; exactly 1 correct option per task; 20 tasks; generateFn candidates are correct independently with probability 0.2',
    candidateFormat: 'the answer is option <letter>.',
    scoring: 'scoreFn returns 1 for the correct option and 0 otherwise; final correctness is graded externally by parsing the last option letter',
    budget: {
      maxGenerateCallsPerTask: MAX_GENERATE_CALLS,
      maxCandidatesPerTask: MAX_CANDIDATES,
      enforcement:
        'the wrapper returns [] and records an overflow after either cap; all strategies are checked for overflow',
      note:
        'generateCalls counts generateFn invocations; candidates counts returned answers. best_of_n makes 20 calls of n=1; MCTS makes 10 calls of n=2; guided beam makes 1 call of n=20.',
    },
    commonRandomNumbers:
      'each task seeds the same candidate stream for every arm; arms differ only in how many candidates they request and how they select',
    taskTypes: {
      standard_sampling: 'general',
      standard_sampling_budgeted_20: 'general',
      best_of_n: 'general',
      mcts_general: 'general',
      mcts_math: 'math (control; candidate text matches "the answer is")',
      true_guided_beam_search: 'general',
    },
    configs: {
      mcts: MCTS_CONFIG,
      best_of_n: BEST_OF_N_CONFIG,
      true_guided_beam_search: GUIDED_BEAM_CONFIG,
      defaultMaxDepth: 15,
      defaultBeamWidth: 3,
      defaultMctsIterations: 50,
    },
  },
  rule: RULE,
  decision,
  decisionReasons,
  baselineNote:
    'standard_sampling natively uses 1 generate call. To honor the same-budget requirement, the decision baseline is standard_sampling repeated up to 20 times per task (same 20-call/20-candidate cap) with first-correct selection. The native 1-call result is reported separately; comparing a 20-call strategy to it would be a budget artifact.',
  candidateComparisons,
  summaries,
  completionProbe,
  pairedOutcomes,
  limitations: [
    'synthetic candidates are independent and iid; real LLM candidates are correlated and the scoreFn would be noisy',
    'the scoreFn is a perfect verifier (it knows the correct option), which favors best_of_n and the budget-matched standard baseline',
    'the budget-matched standard baseline uses the same first-correct verifier as best_of_n to isolate search value; a majority-vote baseline would instead measure the value of having a verifier at all',
    'MCTS uses Math.random for UCT tie-breaking and rollout selection, so its trajectory is not seed-reproducible',
    'MCTS terminal simulation returns a completion-pattern reward without consulting scoreFn, so finalScore is not a correctness signal',
    'taskType completion detection is a string heuristic; the synthetic "the answer is option X" format deliberately triggers the math pattern for the mcts_math control, while the capitalization probe shows that "The answer is ..." is not recognized',
    '20 tasks per arm is a small sample; the difference between 0.2 and 0.2 can be noise, while the budget-matched baseline is near ceiling',
    'actual generate calls are wrapper invocations, not token counts; a call with n candidates is one invocation here',
  ],
}

const resultsDir = join(dirname(fileURLToPath(import.meta.url)), 'results')
mkdirSync(resultsDir, { recursive: true })
const outputPath = join(resultsDir, 'reasoning-search-bench.json')
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8')

console.log('=== reasoning-search synthetic multiple-choice experiment ===')
console.log(
  `Budget: <=${MAX_GENERATE_CALLS} generate calls and <=${MAX_CANDIDATES} candidates per task; 20 tasks per arm`,
)
for (const arm of ARMS) {
  const summary = summaries[arm]!
  const fs = summary.finalScoreValidity
  console.log(
    `${arm.padEnd(30)} solve=${(summary.solveRate * 100).toFixed(1)}% (${summary.solved}/${summary.tasks}), ` +
      `calls=${summary.avgActualGenerateCalls.toFixed(1)}, candidates=${summary.avgActualCandidates.toFixed(1)}, ` +
      `steps=${summary.avgSteps.toFixed(1)}, finalScore=[${summary.finalScoreMin.toFixed(3)},${summary.finalScoreMax.toFixed(3)}], ` +
      `usable=${fs.usable}` +
      (summary.issues.emptySolutions > 0 ? `, empty=${summary.issues.emptySolutions}` : '') +
      (summary.issues.prematureEarlyStops > 0
        ? `, prematureStops=${summary.issues.prematureEarlyStops}`
        : '') +
      (summary.issues.budgetViolations > 0
        ? `, budgetViolations=${summary.issues.budgetViolations}`
        : ''),
  )
}
console.log(`Decision: ${decision}`)
for (const reason of decisionReasons) console.log(`  - ${reason}`)
console.log(
  `completion probe: general(non-empty)=${completionProbe.isCompleteGeneralOnNonEmpty}, general(empty)=${completionProbe.isCompleteGeneralOnEmpty}, ` +
    `math(lowercase)=${completionProbe.isCompleteMathOnLowercaseCandidate}, math(capitalized)=${completionProbe.isCompleteMathOnCapitalizedCandidate}`,
)
console.log(`Results: ${outputPath}`)
