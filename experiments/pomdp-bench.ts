/**
 * Experiment: is @fengrru/pomdp-planner worth adding as an opt-in planner?
 *
 * Environment: 3x3 gridworld. State is {x, y}; actions are up/down/left/right.
 * Goal is (2, 2). Moving into a boundary is a bump (the agent stays put).
 * Every action has 20% probability of executing a perpendicular move instead
 * (a simple stochastic-slide model). Rewards: +100 for entering the goal,
 * -1 for a normal step, -3 for a bump (step penalty + bump penalty).
 *
 * Policies:
 *   random  - uniform random action, seeded PRNG (implemented here).
 *   greedy  - shortest-path direction on the known deterministic grid,
 *             replanned after every observed position (implemented here).
 *   pomdp   - package POMDPPlanner.plan with the package's particle filter
 *             and QMDP rollout solver; no observations are supplied.
 *
 * The same 20 start positions are used by every policy in every repetition.
 * There are 5 repetitions of the 20 starts (100 POMDP plans), so success
 * variance can be estimated across repeated batches. The 20 starts are drawn
 * with replacement from the 8 non-goal cells because a 3x3 grid has only 8
 * non-goal cells.
 *
 * Decision rule (as requested):
 *   add-opt-in iff
 *     (pomdp.successRate >= greedy.successRate + 0.10 OR
 *      pomdp.successRate >= random.successRate + 0.20)
 *     AND pomdp.avgPlanMs < 500
 *     AND successVarianceAcrossRepetitions <= 0.15
 *   otherwise do-not-add.
 *
 * Run: bun experiments/pomdp-bench.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  POMDPPlanner,
  createState,
  type Action,
  type POMDPConfig,
  type POMDPState,
} from '../../awesome-agent-infra/packages/pomdp-planner/src/index.ts'

// ─── Configuration ──────────────────────────────────────────────────────────

const GRID_SIZE = 3
const GOAL = { x: 2, y: 2 } as const
const SLIP_PROBABILITY = 0.2
const MAX_STEPS = 20
const REPETITIONS = 5
const TRIALS_PER_REPETITION = 20
const MASTER_SEED = 0x5d5e2026

const THRESHOLDS = {
  greedyMargin: 0.1,
  randomMargin: 0.2,
  maxAvgPlanMs: 500,
  maxSuccessVariance: 0.15,
} as const

const RULE =
  'add-opt-in iff [pomdp.successRate >= greedy.successRate + 0.10 OR pomdp.successRate >= random.successRate + 0.20] AND pomdp.avgPlanMs < 500 AND successVarianceAcrossRepetitions <= 0.15; otherwise do-not-add'

const POMDP_CONFIG: Partial<POMDPConfig> = {
  numParticles: 100,
  numRollouts: 10,
  maxDepth: 5,
  discountFactor: 0.95,
  explorationBonus: 0.1,
  resampleThreshold: 0.5,
  timeoutMs: 30000,
  maxPlanSteps: MAX_STEPS,
  temperature: 0.5,
}

const ACTION_IDS = ['up', 'down', 'left', 'right'] as const
type ActionId = (typeof ACTION_IDS)[number]

const ACTIONS: Action[] = ACTION_IDS.map((id) => ({
  id,
  name: `Move ${id}`,
  description: `Move one cell ${id}`,
  cost: 1,
}))

const DELTAS: Record<ActionId, { dx: number; dy: number }> = {
  up: { dx: 0, dy: -1 },
  down: { dx: 0, dy: 1 },
  left: { dx: -1, dy: 0 },
  right: { dx: 1, dy: 0 },
}

// ─── Utilities ──────────────────────────────────────────────────────────────

interface GridPosition {
  x: number
  y: number
}

function gridVars(state: POMDPState): GridPosition {
  return state.variables as unknown as GridPosition
}

function positionKey(position: GridPosition): string {
  return `${position.x},${position.y}`
}

function inBounds(position: GridPosition): boolean {
  return position.x >= 0 && position.x < GRID_SIZE && position.y >= 0 && position.y < GRID_SIZE
}

function isGoalPosition(position: GridPosition): boolean {
  return position.x === GOAL.x && position.y === GOAL.y
}

function isGoalState(state: POMDPState): boolean {
  return isGoalPosition(gridVars(state))
}

/** Deterministic, seedable PRNG (mulberry32). */
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

function sampleVariance(values: number[]): number {
  if (values.length < 2) return 0
  const avg = mean(values)
  return values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1)
}

// ─── Environment ────────────────────────────────────────────────────────────

interface MoveOutcome {
  position: GridPosition
  executed: ActionId
  slipped: boolean
  bumped: boolean
}

/**
 * Execute an action with a 20% chance of a perpendicular slide.
 * A move that leaves the grid is a bump: the agent stays in place.
 */
function sampleMove(
  position: GridPosition,
  actionId: ActionId,
  rng: () => number,
): MoveOutcome {
  let executed: ActionId = actionId
  const slipped = rng() < SLIP_PROBABILITY
  if (slipped) {
    const perpendicular: ActionId[] =
      actionId === 'up' || actionId === 'down' ? ['left', 'right'] : ['up', 'down']
    executed = perpendicular[rng() < 0.5 ? 0 : 1]!
  }

  const { dx, dy } = DELTAS[executed]
  const candidate = { x: position.x + dx, y: position.y + dy }
  if (!inBounds(candidate)) {
    return { position: { ...position }, executed, slipped, bumped: true }
  }
  return { position: candidate, executed, slipped, bumped: false }
}

/** Transition used by the package (the package supplies no RNG, so Math.random). */
function pomdpTransition(state: POMDPState, action: Action): POMDPState {
  const position = gridVars(state)
  const outcome = sampleMove(position, action.id as ActionId, () => Math.random())
  return createState(
    { x: outcome.position.x, y: outcome.position.y },
    state.step + 1,
    state.id,
    state.score,
  )
}

function gridReward(
  state: POMDPState,
  _action: Action,
  nextState: POMDPState,
): number {
  if (isGoalState(nextState)) return 100
  const before = gridVars(state)
  const after = gridVars(nextState)
  const bumped = before.x === after.x && before.y === after.y
  return bumped ? -3 : -1
}

function goalCondition(state: POMDPState): boolean {
  return isGoalState(state)
}

function greedyAction(position: GridPosition): ActionId {
  // Manhattan-shortest-path direction on the known, obstacle-free grid.
  if (position.x < GOAL.x) return 'right'
  if (position.x > GOAL.x) return 'left'
  if (position.y < GOAL.y) return 'down'
  if (position.y > GOAL.y) return 'up'
  return 'up'
}

function randomAction(rng: () => number): ActionId {
  return ACTION_IDS[Math.floor(rng() * ACTION_IDS.length)]!
}

// ─── Start positions ────────────────────────────────────────────────────────

function buildStartPositions(): GridPosition[] {
  const nonGoal: GridPosition[] = []
  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      if (!isGoalPosition({ x, y })) nonGoal.push({ x, y })
    }
  }

  const rng = mulberry32(MASTER_SEED)
  const starts: GridPosition[] = []
  while (starts.length < TRIALS_PER_REPETITION) {
    const pool = nonGoal.slice()
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1))
      const tmp = pool[i]!
      pool[i] = pool[j]!
      pool[j] = tmp
    }
    for (const position of pool) {
      if (starts.length >= TRIALS_PER_REPETITION) break
      starts.push(position)
    }
  }
  return starts
}

const STARTS = buildStartPositions()

// ─── Trial runners ──────────────────────────────────────────────────────────

interface RunResult {
  policy: 'pomdp' | 'greedy' | 'random'
  repetition: number
  trial: number
  start: GridPosition
  success: boolean
  steps: number
  converged?: boolean
  planDurationMs?: number
  wallDurationMs: number
  totalCost?: number
  expectedReward?: number
  finalPosition: GridPosition
  actionPath?: string[]
  packageMetadata?: Record<string, unknown>
  error?: string
}

function runPOMDP(
  start: GridPosition,
  repetition: number,
  trial: number,
): RunResult {
  const wallStart = performance.now()
  try {
    const planner = new POMDPPlanner(ACTIONS, POMDP_CONFIG)
    const result = planner.plan(
      createState({ x: start.x, y: start.y }, 0, undefined, 0, 'start'),
      goalCondition,
      pomdpTransition,
      gridReward,
      { maxSteps: MAX_STEPS },
    )
    const wallDurationMs = performance.now() - wallStart
    return {
      policy: 'pomdp',
      repetition,
      trial,
      start: { ...start },
      success: isGoalState(result.finalState),
      steps: result.steps.length,
      converged: result.converged,
      planDurationMs: result.planDurationMs,
      wallDurationMs,
      totalCost: result.totalCost,
      expectedReward: result.expectedReward,
      finalPosition: gridVars(result.finalState),
      actionPath: result.steps.map((step) => step.action.id),
      packageMetadata: result.metadata as unknown as Record<string, unknown>,
    }
  } catch (error) {
    return {
      policy: 'pomdp',
      repetition,
      trial,
      start: { ...start },
      success: false,
      steps: 0,
      wallDurationMs: performance.now() - wallStart,
      finalPosition: { ...start },
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function runBaseline(
  policy: 'greedy' | 'random',
  start: GridPosition,
  repetition: number,
  trial: number,
): RunResult {
  const rng = mulberry32(seedFor(MASTER_SEED, repetition, trial, policy === 'greedy' ? 1 : 2))
  let position = { ...start }
  let steps = 0
  let success = isGoalPosition(position)
  const wallStart = performance.now()

  while (!success && steps < MAX_STEPS) {
    const actionId = policy === 'greedy' ? greedyAction(position) : randomAction(rng)
    const outcome = sampleMove(position, actionId, rng)
    position = outcome.position
    steps++
    success = isGoalPosition(position)
  }

  return {
    policy,
    repetition,
    trial,
    start: { ...start },
    success,
    steps,
    wallDurationMs: performance.now() - wallStart,
    finalPosition: position,
  }
}

// ─── Aggregation ────────────────────────────────────────────────────────────

interface Aggregate {
  runs: number
  successes: number
  successRate: number
  avgSteps: number
  avgStepsOnSuccess: number | null
  avgPlanMs: number | null
  avgWallMs: number
  successVarianceAcrossTrials: number
  errors: number
}

function aggregate(runs: RunResult[], policy: 'pomdp' | 'greedy' | 'random'): Aggregate {
  const successes = runs.filter((run) => run.success).length
  const successRate = runs.length === 0 ? 0 : successes / runs.length
  const successfulSteps = runs.filter((run) => run.success).map((run) => run.steps)
  const planTimes =
    policy === 'pomdp'
      ? runs
          .map((run) => run.planDurationMs)
          .filter((value): value is number => typeof value === 'number')
      : []

  return {
    runs: runs.length,
    successes,
    successRate,
    avgSteps: mean(runs.map((run) => run.steps)),
    avgStepsOnSuccess: successfulSteps.length === 0 ? null : mean(successfulSteps),
    avgPlanMs: policy === 'pomdp' ? mean(planTimes) : null,
    avgWallMs: mean(runs.map((run) => run.wallDurationMs)),
    successVarianceAcrossTrials: successRate * (1 - successRate),
    errors: runs.filter((run) => run.error !== undefined).length,
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

const allRuns: RunResult[] = []
const repetitions: Array<{
  repetition: number
  starts: GridPosition[]
  pomdp: Aggregate
  greedy: Aggregate
  random: Aggregate
  pomdpSuccessRate: number
  greedySuccessRate: number
  randomSuccessRate: number
  runs: Record<'pomdp' | 'greedy' | 'random', RunResult[]>
}> = []

for (let repetition = 0; repetition < REPETITIONS; repetition++) {
  const pomdpRuns: RunResult[] = []
  const greedyRuns: RunResult[] = []
  const randomRuns: RunResult[] = []

  for (let trial = 0; trial < TRIALS_PER_REPETITION; trial++) {
    const start = STARTS[trial]!
    const pomdpRun = runPOMDP(start, repetition, trial)
    const greedyRun = runBaseline('greedy', start, repetition, trial)
    const randomRun = runBaseline('random', start, repetition, trial)
    pomdpRuns.push(pomdpRun)
    greedyRuns.push(greedyRun)
    randomRuns.push(randomRun)
    allRuns.push(pomdpRun, greedyRun, randomRun)
  }

  const pomdp = aggregate(pomdpRuns, 'pomdp')
  const greedy = aggregate(greedyRuns, 'greedy')
  const random = aggregate(randomRuns, 'random')
  repetitions.push({
    repetition,
    starts: STARTS.map((start) => ({ ...start })),
    pomdp,
    greedy,
    random,
    pomdpSuccessRate: pomdp.successRate,
    greedySuccessRate: greedy.successRate,
    randomSuccessRate: random.successRate,
    runs: { pomdp: pomdpRuns, greedy: greedyRuns, random: randomRuns },
  })
}

const pomdpRunsAll = allRuns.filter((run) => run.policy === 'pomdp')
const greedyRunsAll = allRuns.filter((run) => run.policy === 'greedy')
const randomRunsAll = allRuns.filter((run) => run.policy === 'random')

const pomdp = aggregate(pomdpRunsAll, 'pomdp')
const greedy = aggregate(greedyRunsAll, 'greedy')
const random = aggregate(randomRunsAll, 'random')

const repetitionRates = {
  pomdp: repetitions.map((entry) => entry.pomdp.successRate),
  greedy: repetitions.map((entry) => entry.greedy.successRate),
  random: repetitions.map((entry) => entry.random.successRate),
}

const successVarianceAcrossRepetitions = {
  pomdp: sampleVariance(repetitionRates.pomdp),
  greedy: sampleVariance(repetitionRates.greedy),
  random: sampleVariance(repetitionRates.random),
}

const marginVsGreedy = pomdp.successRate - greedy.successRate
const marginVsRandom = pomdp.successRate - random.successRate
const beatsGreedy = pomdp.successRate >= greedy.successRate + THRESHOLDS.greedyMargin
const beatsRandom = pomdp.successRate >= random.successRate + THRESHOLDS.randomMargin
const timeOk = (pomdp.avgPlanMs ?? Number.POSITIVE_INFINITY) < THRESHOLDS.maxAvgPlanMs
const varianceOk =
  successVarianceAcrossRepetitions.pomdp <= THRESHOLDS.maxSuccessVariance

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))
  return sorted[index]!
}

const pomdpPlanTimes = pomdpRunsAll
  .map((run) => run.planDurationMs)
  .filter((value): value is number => typeof value === 'number')
  .sort((a, b) => a - b)
const planTimeStats = {
  count: pomdpPlanTimes.length,
  avgMs: mean(pomdpPlanTimes),
  minMs: pomdpPlanTimes[0] ?? 0,
  p50Ms: quantile(pomdpPlanTimes, 0.5),
  p90Ms: quantile(pomdpPlanTimes, 0.9),
  p99Ms: quantile(pomdpPlanTimes, 0.99),
  maxMs: pomdpPlanTimes[pomdpPlanTimes.length - 1] ?? 0,
  runsAtOrAbove500Ms: pomdpPlanTimes.filter((value) => value >= 500).length,
  fractionAtOrAbove500Ms:
    pomdpPlanTimes.length === 0
      ? 0
      : pomdpPlanTimes.filter((value) => value >= 500).length / pomdpPlanTimes.length,
  perRepetitionAvgMs: repetitions.map((entry) => entry.pomdp.avgPlanMs ?? 0),
}
const decision =
  (beatsGreedy || beatsRandom) && timeOk && varianceOk ? 'add-opt-in' : 'do-not-add'

const decisionReasons: string[] = []
if (!beatsGreedy && !beatsRandom) {
  decisionReasons.push(
    `success margin vs greedy is ${marginVsGreedy.toFixed(3)} (needs >= ${THRESHOLDS.greedyMargin}) and vs random is ${marginVsRandom.toFixed(3)} (needs >= ${THRESHOLDS.randomMargin})`,
  )
}
if (!timeOk) {
  decisionReasons.push(
    `avg plan time is ${(pomdp.avgPlanMs ?? 0).toFixed(1)}ms (needs < ${THRESHOLDS.maxAvgPlanMs}ms)`,
  )
}
if (!varianceOk) {
  decisionReasons.push(
    `success variance across repetitions is ${successVarianceAcrossRepetitions.pomdp.toFixed(4)} (needs <= ${THRESHOLDS.maxSuccessVariance})`,
  )
}
if (decision === 'add-opt-in') {
  decisionReasons.push('all requested thresholds were met')
}

const decisionInterpretation = beatsGreedy
  ? 'POMDP beats the greedy baseline by at least 0.10 in success rate.'
  : beatsRandom
    ? `POMDP does not beat the greedy baseline by 0.10 (delta ${marginVsGreedy.toFixed(3)}); the add-opt-in decision is driven by the random-policy branch (delta ${marginVsRandom.toFixed(3)}) plus the time and variance checks.`
    : 'No success-rate branch, time check, or variance check was sufficient for add-opt-in.'

const output = {
  experiment: 'pomdp-planner-gridworld',
  source: '../../awesome-agent-infra/packages/pomdp-planner/src/index.ts',
  evaluatedAt: new Date().toISOString(),
  design: {
    environment:
      '3x3 gridworld; state {x,y}; actions up/down/left/right; goal (2,2); boundary bumps; 20% perpendicular slide',
    reward: {
      goal: 100,
      normalStep: -1,
      bump: -3,
      note: 'bump reward includes the step penalty: -1 step and -2 bump penalty',
    },
    stochasticity: {
      slipProbability: SLIP_PROBABILITY,
      rule: 'a slipped action executes one of the two perpendicular directions with equal probability; out-of-bounds remains in place',
    },
    policies: {
      random: 'uniform random action, seeded mulberry32',
      greedy:
        'Manhattan shortest-path direction on the known deterministic grid, replanned after every observed position',
      pomdp:
        'package POMDPPlanner.plan with ParticleFilter and QMDPSolver; no observations are supplied, so the belief is only predicted, never corrected',
    },
    trials: {
      repetitions: REPETITIONS,
      trialsPerRepetition: TRIALS_PER_REPETITION,
      totalRunsPerPolicy: REPETITIONS * TRIALS_PER_REPETITION,
      starts:
        'the same 20 start cells (drawn with replacement from the 8 non-goal cells) are used by all policies in every repetition',
    },
    packageConfig: POMDP_CONFIG,
  },
  rule: RULE,
  thresholds: THRESHOLDS,
  decision,
  decisionReasons,
  decisionInterpretation,
  aggregates: {
    pomdp,
    greedy,
    random,
  },
  planTimeStats,
  comparison: {
    marginVsGreedy,
    marginVsRandom,
    beatsGreedyByMargin: beatsGreedy,
    beatsRandomByMargin: beatsRandom,
    avgPlanTimeOk: timeOk,
    successVarianceOk: varianceOk,
  },
  successVariance: {
    acrossRepetitionSuccessRates: successVarianceAcrossRepetitions,
    repetitionSuccessRates: repetitionRates,
    note:
      'sample variance (n-1 denominator) of the 5 per-repetition success rates; trial-level Bernoulli variance p*(1-p) is also included in each aggregate',
  },
  repetitions,
  limitations: [
    'the package uses Math.random internally, so POMDP planning is not seed-reproducible; only the baselines use a seeded PRNG',
    'POMDPPlanner is called without observations, so the particle filter never corrects its belief; particles are only propagated through the stochastic transition',
    'the rollout policy inside QMDPSolver is greedy on immediate reward with 10% random exploration; it is an approximation, not an exact POMDP solve',
    'the state is effectively observed by the planner via the sampled nextState, which is optimistic relative to a true partially observable setting',
    'the 3x3 grid is small and all 20 starts must reuse the 8 non-goal cells',
    'success variance is estimated from only 5 repetition rates, so it is coarse',
    'planDurationMs is measured by the package with Date.now (millisecond resolution)',
    'the package uses Math.random internally, so average plan time is not reproducible across executions; the average can hide a heavy tail (individual plans in this class of run can exceed 500ms even when the mean is below it)',
  ],
}

const resultsDir = join(dirname(fileURLToPath(import.meta.url)), 'results')
mkdirSync(resultsDir, { recursive: true })
const outputPath = join(resultsDir, 'pomdp-bench.json')
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8')

console.log('=== POMDP gridworld experiment ===')
console.log(
  `POMDP : success=${(pomdp.successRate * 100).toFixed(1)}% (${pomdp.successes}/${pomdp.runs}), ` +
    `avgSteps=${pomdp.avgSteps.toFixed(2)}, avgPlan=${(pomdp.avgPlanMs ?? 0).toFixed(1)}ms, ` +
    `varianceAcrossReps=${successVarianceAcrossRepetitions.pomdp.toFixed(4)}`,
)
console.log(
  `Greedy: success=${(greedy.successRate * 100).toFixed(1)}% (${greedy.successes}/${greedy.runs}), ` +
    `avgSteps=${greedy.avgSteps.toFixed(2)}`,
)
console.log(
  `Random: success=${(random.successRate * 100).toFixed(1)}% (${random.successes}/${random.runs}), ` +
    `avgSteps=${random.avgSteps.toFixed(2)}`,
)
console.log(
  `Margins: vsGreedy=${marginVsGreedy.toFixed(3)} (need >= 0.10), ` +
    `vsRandom=${marginVsRandom.toFixed(3)} (need >= 0.20)`,
)
console.log(
  `Time: ${(pomdp.avgPlanMs ?? 0).toFixed(1)}ms (need < 500ms); ` +
    `variance=${successVarianceAcrossRepetitions.pomdp.toFixed(4)} (need <= 0.15)`,
)
console.log(
  `Plan-time distribution: p50=${planTimeStats.p50Ms}ms, p90=${planTimeStats.p90Ms}ms, ` +
    `p99=${planTimeStats.p99Ms}ms, max=${planTimeStats.maxMs}ms, ` +
    `>=500ms=${planTimeStats.runsAtOrAbove500Ms}/${planTimeStats.count}`,
)
console.log(`Decision: ${decision}`)
console.log(`Interpretation: ${decisionInterpretation}`)
for (const reason of decisionReasons) console.log(`  - ${reason}`)
console.log(`Results: ${outputPath}`)
