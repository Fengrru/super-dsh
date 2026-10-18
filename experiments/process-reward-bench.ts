/**
 * Experiment — Is process-reward worth adopting as a PRM?
 *
 * 100 synthetic five-step arithmetic reasoning trajectories (50 train /
 * 50 holdout). Each step is rendered with the same natural-language
 * template for both classes; good and bad steps differ only in the stated
 * running-total result. A step is good iff its stated result equals the
 * hidden true running total. No label is exposed in the text.
 *
 * We score every holdout step with ProcessRewardModel.scorePathHeuristic,
 * compute step-level AUC against the hidden step labels, then train
 * PRMTrainer on weak-supervision labels produced by
 * ProcessRewardModel.labelSteps and re-score the holdout set.
 *
 * Decision rule: add-opt-in only if holdout AUC >= 0.70 AND the trained
 * model's AUC improves by >= 0.05 over the untrained heuristic.
 *
 * Run: bun experiments/process-reward-bench.ts
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  ProcessRewardModel,
  PRMTrainer,
  type TaskType,
  type TrainingSample,
} from "../../awesome-agent-infra/packages/process-reward/src/index.ts"

const SEED = 0x5eed2026
const TOTAL_TRAJECTORIES = 100
const TRAIN_TRAJECTORIES = 50
const HOLDOUT_TRAJECTORIES = 50
const STEPS_PER_TRAJECTORY = 5
const AUC_THRESHOLD = 0.7
const AUC_IMPROVEMENT_THRESHOLD = 0.05

// ─── Deterministic RNG ───────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1))
}

function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = copy[i]!
    copy[i] = copy[j]!
    copy[j] = tmp
  }
  return copy
}

// ─── Synthetic trajectories ──────────────────────────────────────────

type Operation = "add" | "sub"

interface StepSpec {
  text: string
  good: boolean
  correctValue: number
  statedValue: number
  delta: number
  operation: Operation
}

interface Trajectory {
  id: number
  split: "train" | "holdout"
  steps: StepSpec[]
  finalCorrect: boolean
}

const ADD_TEMPLATES: Array<(delta: number, value: number) => string> = [
  (d, v) => `Adding ${d} to the running total brings it to ${v}.`,
  (d, v) => `The tally rises by ${d}, so the new running total is ${v}.`,
  (d, v) => `After increasing by ${d}, we arrive at a total of ${v}.`,
  (d, v) => `Taking on another ${d} moves the running total to ${v}.`,
]

const SUB_TEMPLATES: Array<(delta: number, value: number) => string> = [
  (d, v) => `Subtracting ${d} from the running total leaves ${v}.`,
  (d, v) => `The tally falls by ${d}, so the new running total is ${v}.`,
  (d, v) => `After decreasing by ${d}, we arrive at a total of ${v}.`,
  (d, v) => `Taking away ${d} moves the running total to ${v}.`,
]

function generateTrajectories(): Trajectory[] {
  const rng = mulberry32(SEED)
  const trajectories: Trajectory[] = []

  for (let id = 0; id < TOTAL_TRAJECTORIES; id++) {
    let running = randInt(rng, 20, 90)
    const trueValues: number[] = []
    const deltas: number[] = []
    const operations: Operation[] = []

    for (let i = 0; i < STEPS_PER_TRAJECTORY; i++) {
      const delta = randInt(rng, 2, 9)
      let operation: Operation = rng() < 0.55 ? "add" : "sub"
      if (operation === "sub" && running - delta < 1) operation = "add"
      running = operation === "add" ? running + delta : running - delta
      trueValues.push(running)
      deltas.push(delta)
      operations.push(operation)
    }

    const goodCount = randInt(rng, 2, 4)
    const goodPositions = new Set(
      shuffle(
        Array.from({ length: STEPS_PER_TRAJECTORY }, (_, i) => i),
        rng,
      ).slice(0, goodCount),
    )

    const steps: StepSpec[] = []
    for (let i = 0; i < STEPS_PER_TRAJECTORY; i++) {
      const good = goodPositions.has(i)
      const correctValue = trueValues[i]!
      let statedValue = correctValue

      if (!good) {
        const magnitude = randInt(rng, 1, 3)
        const sign = rng() < 0.5 ? -1 : 1
        statedValue = correctValue + sign * magnitude
        if (statedValue < 1) statedValue = correctValue + magnitude
        if (statedValue === correctValue) statedValue = correctValue + 1
      }

      const operation = operations[i]!
      const delta = deltas[i]!
      const templates = operation === "add" ? ADD_TEMPLATES : SUB_TEMPLATES
      const template = templates[randInt(rng, 0, templates.length - 1)]!

      steps.push({
        text: template(delta, statedValue),
        good,
        correctValue,
        statedValue,
        delta,
        operation,
      })
    }

    trajectories.push({
      id,
      split: id < TRAIN_TRAJECTORIES ? "train" : "holdout",
      steps,
      finalCorrect: steps[STEPS_PER_TRAJECTORY - 1]!.good,
    })
  }

  return trajectories
}

// ─── Metrics ─────────────────────────────────────────────────────────

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function round(value: number, digits = 6): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/**
 * Mann-Whitney AUC, with average ranks for ties.
 * Labels: 1 = positive (good step), 0 = negative.
 * Returns null when only one class is present.
 */
function computeAuc(scores: readonly number[], labels: readonly number[]): number | null {
  const positives = labels.filter((label) => label === 1).length
  const negatives = labels.length - positives
  if (positives === 0 || negatives === 0) return null

  const order = scores
    .map((score, index) => ({ score, index }))
    .sort((a, b) => a.score - b.score)
  const ranks = new Array<number>(scores.length)
  let cursor = 0

  while (cursor < order.length) {
    let end = cursor
    while (end + 1 < order.length && order[end + 1]!.score === order[cursor]!.score) end++
    const averageRank = (cursor + end) / 2 + 1
    for (let k = cursor; k <= end; k++) ranks[order[k]!.index] = averageRank
    cursor = end + 1
  }

  let positiveRankSum = 0
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] === 1) positiveRankSum += ranks[i]!
  }

  return (positiveRankSum - (positives * (positives + 1)) / 2) / (positives * negatives)
}

function classificationMetrics(
  scores: readonly number[],
  labels: readonly number[],
  threshold = 0.5,
): {
  threshold: number
  tp: number
  fp: number
  fn: number
  tn: number
  precision: number | null
  recall: number | null
  accuracy: number
  predictedPositiveRate: number
} {
  let tp = 0
  let fp = 0
  let fn = 0
  let tn = 0

  for (let i = 0; i < scores.length; i++) {
    const predicted = scores[i]! >= threshold
    const actual = labels[i] === 1
    if (predicted && actual) tp++
    else if (predicted && !actual) fp++
    else if (!predicted && actual) fn++
    else tn++
  }

  const precision = tp + fp > 0 ? tp / (tp + fp) : null
  const recall = tp + fn > 0 ? tp / (tp + fn) : null

  return {
    threshold,
    tp,
    fp,
    fn,
    tn,
    precision: precision === null ? null : round(precision),
    recall: recall === null ? null : round(recall),
    accuracy: round((tp + tn) / scores.length),
    predictedPositiveRate: round((tp + fp) / scores.length),
  }
}

function distribution(values: readonly number[]): {
  count: number
  min: number | null
  max: number | null
  mean: number | null
  std: number | null
  p10: number | null
  p50: number | null
  p90: number | null
  uniqueValues: number
  topValues: Array<{ value: number; count: number }>
} {
  if (values.length === 0) {
    return {
      count: 0,
      min: null,
      max: null,
      mean: null,
      std: null,
      p10: null,
      p50: null,
      p90: null,
      uniqueValues: 0,
      topValues: [],
    }
  }

  const sorted = [...values].sort((a, b) => a - b)
  const avg = mean(sorted)
  const variance = mean(sorted.map((value) => (value - avg) ** 2))
  const quantile = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))]!

  const counts = new Map<number, number>()
  for (const value of sorted) counts.set(value, (counts.get(value) ?? 0) + 1)
  const topValues = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([value, count]) => ({ value: round(value), count }))

  return {
    count: sorted.length,
    min: round(sorted[0]!),
    max: round(sorted[sorted.length - 1]!),
    mean: round(avg),
    std: round(Math.sqrt(variance)),
    p10: round(quantile(0.1)),
    p50: round(quantile(0.5)),
    p90: round(quantile(0.9)),
    uniqueValues: counts.size,
    topValues,
  }
}

function summarizeScores(
  model: ProcessRewardModel,
  trajectories: readonly Trajectory[],
  taskType: TaskType,
): number[] {
  const scores: number[] = []
  for (const trajectory of trajectories) {
    const pathScores = model.scorePathHeuristic(
      trajectory.steps.map((step) => step.text),
      taskType,
    )
    for (const stepScore of pathScores) scores.push(stepScore.score)
  }
  return scores
}

function summarizeLabels(trajectories: readonly Trajectory[]): number[] {
  return trajectories.flatMap((trajectory) => trajectory.steps.map((step) => (step.good ? 1 : 0)))
}

// ─── Main experiment ─────────────────────────────────────────────────

interface Evaluation {
  auc: number | null
  classification: ReturnType<typeof classificationMetrics>
  distribution: ReturnType<typeof distribution>
}

function evaluate(scores: number[], labels: number[]): Evaluation {
  return {
    auc: computeAuc(scores, labels) === null ? null : round(computeAuc(scores, labels)!),
    classification: classificationMetrics(scores, labels),
    distribution: distribution(scores),
  }
}

const trajectories = generateTrajectories()
const train = trajectories.filter((trajectory) => trajectory.split === "train")
const holdout = trajectories.filter((trajectory) => trajectory.split === "holdout")

const holdoutLabels = summarizeLabels(holdout)
const model = new ProcessRewardModel()
const untrainedScores = summarizeScores(model, holdout, "general")
const untrainedMathScores = summarizeScores(model, holdout, "math")
const untrained = evaluate(untrainedScores, holdoutLabels)
const untrainedMath = evaluate(untrainedMathScores, holdoutLabels)

const finalStepScores = holdout.map(
  (trajectory) =>
    model.scorePathHeuristic(
      trajectory.steps.map((step) => step.text),
      "general",
    )[STEPS_PER_TRAJECTORY - 1]!.score,
)
const finalStepLabels = holdout.map((trajectory) => (trajectory.finalCorrect ? 1 : 0))
const finalStepAuc = computeAuc(finalStepScores, finalStepLabels)

// Weak-supervision labels from the real API. No generateFn/verifyFn is
// supplied, so labelSteps falls back to heuristic + outcome.
const labeler = new ProcessRewardModel()
const weakSamples: TrainingSample[] = []
const weakLabelCounts = new Map<number, number>()
let weakConfidenceSum = 0

for (const trajectory of train) {
  const texts = trajectory.steps.map((step) => step.text)
  const { labels, confidences } = await labeler.labelSteps(texts, trajectory.finalCorrect, "general")
  for (let i = 0; i < texts.length; i++) {
    weakSamples.push({
      state: texts.slice(0, i).join("\n") || "Start",
      action: texts[i]!,
      label: labels[i]!,
      confidence: confidences[i]!,
    })
    weakLabelCounts.set(labels[i]!, (weakLabelCounts.get(labels[i]!) ?? 0) + 1)
    weakConfidenceSum += confidences[i]!
  }
}

const weakLabelDistribution = [...weakLabelCounts.entries()]
  .sort((a, b) => a[0] - b[0])
  .map(([value, count]) => ({ value: round(value), count }))

const trainerConfig = {
  numEpochs: 10,
  batchSize: 8,
  learningRate: 0.05,
  earlyStopPatience: 0,
  warmupSteps: 0,
  lrSchedule: "cosine" as const,
}

const trainer = new PRMTrainer(trainerConfig)
const weakTrainStarted = performance.now()
const weakTraining = trainer.train(weakSamples)
const weakTrainingMs = performance.now() - weakTrainStarted

// Oracle-label run: even with perfect step labels, check whether the
// trainer exposes any way to apply what it learned.
const oracleSamples: TrainingSample[] = train.flatMap((trajectory) =>
  trajectory.steps.map((step, i) => ({
    state:
      trajectory.steps
        .slice(0, i)
        .map((entry) => entry.text)
        .join("\n") || "Start",
    action: step.text,
    label: step.good ? 1 : 0,
    confidence: 1,
  })),
)
const oracleTrainer = new PRMTrainer(trainerConfig)
const oracleTrainStarted = performance.now()
const oracleTraining = oracleTrainer.train(oracleSamples)
const oracleTrainingMs = performance.now() - oracleTrainStarted

// Re-score holdout with a fresh model: PRMTrainer has no inference API and
// ProcessRewardModel has no way to accept trainer state.
const postTrainingModel = new ProcessRewardModel()
const trainedScores = summarizeScores(postTrainingModel, holdout, "general")
const trained = evaluate(trainedScores, holdoutLabels)

let maxAbsDiff = 0
let changedScores = 0
let sumAbsDiff = 0
for (let i = 0; i < untrainedScores.length; i++) {
  const diff = Math.abs(untrainedScores[i]! - trainedScores[i]!)
  maxAbsDiff = Math.max(maxAbsDiff, diff)
  sumAbsDiff += diff
  if (diff > 1e-12) changedScores++
}

const trainerPrototypeMethods = Object.getOwnPropertyNames(PRMTrainer.prototype).filter(
  (name) => name !== "constructor",
)
const inferenceMethods = trainerPrototypeMethods.filter((name) => /predict|infer|score|forward/i.test(name))
const untrainedAuc = untrained.auc
const trainedAuc = trained.auc
const aucImprovement =
  untrainedAuc !== null && trainedAuc !== null ? round(trainedAuc - untrainedAuc) : null

const goodCountHistogram: Record<string, number> = {}
for (const trajectory of trajectories) {
  const key = String(trajectory.steps.filter((step) => step.good).length)
  goodCountHistogram[key] = (goodCountHistogram[key] ?? 0) + 1
}

const passAuc = untrainedAuc !== null && untrainedAuc >= AUC_THRESHOLD
const passImprovement = aucImprovement !== null && aucImprovement >= AUC_IMPROVEMENT_THRESHOLD
const verdict = passAuc && passImprovement ? "add-opt-in" : "do-not-add"

const reasons: string[] = []
if (!passAuc) {
  reasons.push(
    `untrained holdout step AUC is ${untrainedAuc === null ? "undefined" : untrainedAuc.toFixed(4)} (< ${AUC_THRESHOLD})`,
  )
}
if (!passImprovement) {
  reasons.push(
    `trained-minus-untrained AUC is ${aucImprovement === null ? "undefined" : aucImprovement.toFixed(4)} (< ${AUC_IMPROVEMENT_THRESHOLD})`,
  )
}
if (changedScores === 0) {
  reasons.push("holdout scores are identical before and after trainer.train(): no trained state is consumed by the scorer")
}
if (inferenceMethods.length === 0) {
  reasons.push(
    `PRMTrainer exposes no inference method (prototype: ${trainerPrototypeMethods.join(", ")}); train() only returns loss history`,
  )
}
if (weakLabelCounts.size <= 2) {
  reasons.push(
    `weak-supervision labels collapse to ${weakLabelCounts.size} distinct values (trajectory outcome, not per-step quality)`,
  )
}

const result = {
  experiment: "process-reward-bench",
  package: "@fengrru/process-reward",
  generatedAt: new Date().toISOString(),
  gitCommit: null,
  config: {
    seed: SEED,
    trajectories: TOTAL_TRAJECTORIES,
    stepsPerTrajectory: STEPS_PER_TRAJECTORY,
    trainTrajectories: TRAIN_TRAJECTORIES,
    holdoutTrajectories: HOLDOUT_TRAJECTORIES,
    taskTypePrimary: "general",
    taskTypeSecondary: "math",
    scoreMethod: "ProcessRewardModel.scorePathHeuristic",
    trainingLabelMethod: "ProcessRewardModel.labelSteps (hybrid -> weak supervision; no generateFn/verifyFn)",
    trainerConfig,
    aucThreshold: AUC_THRESHOLD,
    aucImprovementThreshold: AUC_IMPROVEMENT_THRESHOLD,
  },
  design: {
    hiddenRule:
      "A step is good iff the running-total result stated in its natural-language sentence equals the hidden true arithmetic running total. Good and bad variants use the same template, delta and operation; only the stated result differs by 1-3. No label appears in the text.",
    groundTruth: "step.good (per step) and finalCorrect (last step) / trajectory",
    split: "first 50 generated trajectories train, last 50 holdout; labels are not used to build features",
    noLabelLeakage: true,
  },
  dataset: {
    totalSteps: trajectories.length * STEPS_PER_TRAJECTORY,
    trainSteps: train.length * STEPS_PER_TRAJECTORY,
    holdoutSteps: holdout.length * STEPS_PER_TRAJECTORY,
    holdoutGoodSteps: holdoutLabels.filter((label) => label === 1).length,
    holdoutBadSteps: holdoutLabels.filter((label) => label === 0).length,
    holdoutFinalCorrect: holdout.filter((trajectory) => trajectory.finalCorrect).length,
    holdoutFinalIncorrect: holdout.filter((trajectory) => !trajectory.finalCorrect).length,
    goodStepsPerTrajectoryHistogram: goodCountHistogram,
  },
  untrained: {
    holdoutGeneral: untrained,
    holdoutMath: untrainedMath,
    finalStepAuc: finalStepAuc === null ? null : round(finalStepAuc),
    finalStepAucNote:
      "AUC of the last-step heuristic score against trajectory finalCorrect. All general heuristic scores tie, so this is 0.5.",
  },
  training: {
    available: true,
    weakSupervision: {
      trainSamples: weakSamples.length,
      labelDistribution: weakLabelDistribution,
      meanConfidence: round(weakConfidenceSum / weakSamples.length),
      durationMs: round(weakTrainingMs, 3),
      epochs: weakTraining.history.length,
      lossHistory: weakTraining.history.map((loss) => round(loss)),
      initialLoss: round(weakTraining.history[0] ?? 0),
      finalLoss: round(weakTraining.finalLoss),
      lossDecreased:
        weakTraining.history.length > 1 &&
        weakTraining.finalLoss < (weakTraining.history[0] ?? Number.POSITIVE_INFINITY) - 1e-9,
    },
    oracleStepLabels: {
      purpose: "Upper-bound check: even with perfect per-step labels, the trainer exposes no model for holdout inference.",
      trainSamples: oracleSamples.length,
      durationMs: round(oracleTrainingMs, 3),
      epochs: oracleTraining.history.length,
      initialLoss: round(oracleTraining.history[0] ?? 0),
      finalLoss: round(oracleTraining.finalLoss),
      lossDecreased:
        oracleTraining.history.length > 1 &&
        oracleTraining.finalLoss < (oracleTraining.history[0] ?? Number.POSITIVE_INFINITY) - 1e-9,
    },
    trainerPrototypeMethods,
    trainerExposesInference: inferenceMethods.length > 0,
  },
  trained: {
    holdoutGeneral: trained,
    scoreChange: {
      maxAbsDiff: round(maxAbsDiff),
      meanAbsDiff: round(sumAbsDiff / untrainedScores.length),
      changedScores,
      totalScores: untrainedScores.length,
      identical: changedScores === 0,
    },
    aucImprovement,
  },
  decision: {
    rule: `add-opt-in iff holdout AUC >= ${AUC_THRESHOLD} AND (trained AUC - untrained AUC) >= ${AUC_IMPROVEMENT_THRESHOLD}`,
    untrainedHoldoutAuc: untrainedAuc,
    trainedHoldoutAuc: trainedAuc,
    aucImprovement,
    passAuc,
    passImprovement,
    verdict,
    reasons,
  },
  limitations: [
    "Synthetic arithmetic trajectories only; no LLM-generated reasoning and no Monte Carlo rollouts/real verifier.",
    "scorePathHeuristic('general') is length/structure-based and ignores numeric correctness; the math heuristic also cannot verify the hidden arithmetic rule.",
    "PRMTrainer.train() fits scalar predictions initialized as label*0.5+0.25, indexed by training sample; it returns only { history, finalLoss } and exposes no predict/infer method. There is no learned weight vector to apply to holdout.",
    "ProcessRewardModel cannot load trainer state; re-scoring the holdout set after training is byte-identical.",
    "With tied heuristic scores, labelSteps weak supervision produces only two label values driven by trajectory outcome; it provides no per-step quality signal.",
    "All heuristic scores tie at 0.65, so AUC is exactly 0.5 by the average-rank convention and precision/recall at a 0.5 threshold predict every step positive.",
    "The oracle-label trainer run confirms the limitation is structural (no inference path), not merely a weak-label issue.",
    "Registered scorers and the score cache exist in ProcessRewardModel but are not used by scorePathHeuristic; they do not constitute a trainable PRM.",
  ],
}

const resultsDir = join(import.meta.dir, "results")
mkdirSync(resultsDir, { recursive: true })
const resultsPath = join(resultsDir, "process-reward-bench.json")
writeFileSync(resultsPath, `${JSON.stringify(result, null, 2)}\n`, "utf8")

console.log("process-reward PRM benchmark")
console.log(
  `  dataset: ${TOTAL_TRAJECTORIES} trajectories x ${STEPS_PER_TRAJECTORY} steps (train ${TRAIN_TRAJECTORIES} / holdout ${HOLDOUT_TRAJECTORIES})`,
)
console.log(
  `  holdout steps: ${result.dataset.holdoutSteps} (good ${result.dataset.holdoutGoodSteps}, bad ${result.dataset.holdoutBadSteps})`,
)
console.log(
  `  untrained heuristic AUC (general): ${untrainedAuc === null ? "n/a" : untrainedAuc.toFixed(4)}; math: ${untrainedMath.auc === null ? "n/a" : untrainedMath.auc.toFixed(4)}`,
)
console.log(
  `  trained heuristic AUC (general): ${trainedAuc === null ? "n/a" : trainedAuc.toFixed(4)}; improvement: ${aucImprovement === null ? "n/a" : aucImprovement.toFixed(4)}`,
)
console.log(
  `  scores identical before/after: ${result.trained.scoreChange.identical} (${changedScores}/${untrainedScores.length} changed)`,
)
console.log(
  `  trainer: ${weakSamples.length} samples, ${weakTraining.history.length} epochs, ${round(weakTrainingMs, 1)} ms, loss ${round(weakTraining.history[0] ?? 0)} -> ${round(weakTraining.finalLoss)}`,
)
console.log(`  decision: ${verdict}`)
for (const reason of reasons) console.log(`    - ${reason}`)
console.log(`  wrote ${resultsPath}`)
