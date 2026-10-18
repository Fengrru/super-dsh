/**
 * Experiment — Is agent-metacog worth adding?
 *
 * Primary question: does ConfidenceCalibrator training actually improve
 * calibration on held-out synthetic predictions?
 *
 * 200 synthetic predictions with stated confidence q in [0.05, 0.95].
 * Correctness is drawn from a hidden, miscalibrated probability
 * p(correct) = 0.15 + 0.6*q. Train/holdout are 100/100 (stratified over q).
 * For each of 8 model seeds we measure holdout ECE and Brier before and
 * after ConfidenceCalibrator.train(), plus per-seed variance.
 *
 * Secondary question: knowledge boundary and forgetting alerts. A fresh
 * AgentMetacog receives four groups of domains: recent known, recent
 * unknown, old known, old unknown. We compute boundary F1 on recent
 * domains and forgetting precision/recall over all domains (old unknown
 * domains are false positives: there was no knowledge to forget).
 *
 * Decision rule: add-opt-in only if mean holdout ECE improves by >= 0.05
 * (or Brier by >= 0.02) AND knowledge-boundary F1 >= 0.70.
 *
 * Run: bun experiments/agent-metacog-bench.ts
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  AgentMetacog,
  ConfidenceCalibrator,
  type CalibratorConfig,
  type CalibrationResult,
  type StreamFeatures,
} from "../../awesome-agent-infra/packages/agent-metacog/src/index.ts"

const DATA_SEED = 0xca11b2026
const N_PREDICTIONS = 200
const TRAIN_SIZE = 100
const HOLDOUT_SIZE = 100
const CALIBRATION_SEEDS = [11, 29, 47, 73, 101, 137, 191, 239]
const SEQ_LEN = 3
const BASE_HIDDEN_SIZE = 32
const EPOCHS = 10
const LEARNING_RATE = 0.01
const ECE_IMPROVEMENT_THRESHOLD = 0.05
const BRIER_IMPROVEMENT_THRESHOLD = 0.02
const BOUNDARY_F1_THRESHOLD = 0.7
const DAY_MS = 24 * 60 * 60 * 1000

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

function runWithSeededModelRandom<T>(seed: number, fn: () => T): T {
  const original = Math.random
  const rng = mulberry32(seed)
  ;(Math as unknown as { random: () => number }).random = rng
  try {
    return fn()
  } finally {
    ;(Math as unknown as { random: () => number }).random = original
  }
}

// ─── Synthetic predictions ───────────────────────────────────────────

interface Prediction {
  id: number
  statedConfidence: number
  hiddenProbability: number
  correctness: 0 | 1
  split: "train" | "holdout"
  features: StreamFeatures
}

function makeFeatures(q: number): StreamFeatures {
  // All features are functions of the stated confidence q. Correctness
  // labels are never used as features.
  const basis = [
    q,
    1 - q,
    q * q,
    (1 - q) * (1 - q),
    Math.log(q),
    Math.log(1 - q),
    Math.sin(2 * Math.PI * q),
    Math.cos(2 * Math.PI * q),
  ]
  const hiddenStates = Array.from({ length: SEQ_LEN }, (_, token) => {
    const row = new Array<number>(BASE_HIDDEN_SIZE)
    for (let j = 0; j < BASE_HIDDEN_SIZE; j++) {
      row[j] = basis[(j + token) % basis.length]! * (1 + 0.02 * Math.sin(j + 1 + token))
    }
    return row
  })

  const entropy = -(q * Math.log(q) + (1 - q) * Math.log(1 - q))
  return {
    hiddenStates,
    attentionEntropy: [entropy, entropy * 0.95, entropy * 1.05],
    // Log probabilities: closer to zero means more confident.
    tokenLogLikelihoods: [Math.log(q), Math.log(q) - 0.2, Math.log(q) - 0.5],
  }
}

function buildPredictions(): Prediction[] {
  const rng = mulberry32(DATA_SEED)
  const qValues = Array.from(
    { length: N_PREDICTIONS },
    (_, i) => 0.05 + (0.9 * i) / (N_PREDICTIONS - 1),
  )

  // Stratify the split over q, then shuffle each side.
  const sortedIndices = qValues.map((_, i) => i).sort((a, b) => qValues[a]! - qValues[b]!)
  const trainIndices: number[] = []
  const holdoutIndices: number[] = []
  for (let rank = 0; rank < sortedIndices.length; rank++) {
    const index = sortedIndices[rank]!
    if (rank % 2 === 0) trainIndices.push(index)
    else holdoutIndices.push(index)
  }
  const shuffledTrain = shuffle(trainIndices, rng)
  const shuffledHoldout = shuffle(holdoutIndices, rng)
  const trainSet = new Set(shuffledTrain)
  const holdoutSet = new Set(shuffledHoldout)

  const predictions: Prediction[] = []
  for (let i = 0; i < N_PREDICTIONS; i++) {
    const q = qValues[i]!
    const hiddenProbability = 0.15 + 0.6 * q
    const correctness: 0 | 1 = rng() < hiddenProbability ? 1 : 0
    const split = trainSet.has(i) ? "train" : holdoutSet.has(i) ? "holdout" : "train"
    predictions.push({
      id: i,
      statedConfidence: q,
      hiddenProbability,
      correctness,
      split,
      features: makeFeatures(q),
    })
  }
  return predictions
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

/** Convert non-finite numbers to null so the JSON stays valid. */
function finite(value: number, digits = 6): number | null {
  return Number.isFinite(value) ? round(value, digits) : null
}

function computeEce(confidences: readonly number[], labels: readonly number[], numBins = 10): number {
  const binCounts = new Array<number>(numBins).fill(0)
  const binConfidence = new Array<number>(numBins).fill(0)
  const binCorrect = new Array<number>(numBins).fill(0)

  for (let i = 0; i < confidences.length; i++) {
    const confidence = Math.min(1, Math.max(0, confidences[i]!))
    const bin = Math.min(Math.floor(confidence * numBins), numBins - 1)
    binCounts[bin]!++
    binConfidence[bin]! += confidence
    binCorrect[bin]! += labels[i]!
  }

  let ece = 0
  for (let bin = 0; bin < numBins; bin++) {
    const count = binCounts[bin]!
    if (count === 0) continue
    const avgConfidence = binConfidence[bin]! / count
    const accuracy = binCorrect[bin]! / count
    ece += (count / confidences.length) * Math.abs(avgConfidence - accuracy)
  }
  return ece
}

function computeBrier(confidences: readonly number[], labels: readonly number[]): number {
  let sum = 0
  for (let i = 0; i < confidences.length; i++) {
    const diff = confidences[i]! - labels[i]!
    sum += diff * diff
  }
  return sum / confidences.length
}

/** Mann-Whitney AUC with average ranks for ties. */
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
    const rank = (cursor + end) / 2 + 1
    for (let k = cursor; k <= end; k++) ranks[order[k]!.index] = rank
    cursor = end + 1
  }

  let positiveRankSum = 0
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] === 1) positiveRankSum += ranks[i]!
  }
  return (positiveRankSum - (positives * (positives + 1)) / 2) / (positives * negatives)
}

interface EvaluationMetrics {
  sampleCount: number
  ece: number | null
  brier: number | null
  auc: number | null
  meanConfidence: number | null
  stdConfidence: number | null
  minConfidence: number | null
  maxConfidence: number | null
  accuracy: number | null
  internalReportedEceMean: number | null
  internalReportedBrierMean: number | null
  nonFiniteConfidences: number
}

interface Evaluation {
  metrics: EvaluationMetrics
  confidences: number[]
  raw: CalibrationResult[]
}

function evaluate(calibrator: ConfidenceCalibrator, predictions: readonly Prediction[]): Evaluation {
  const raw = predictions.map((prediction) => calibrator.calibrate(prediction.features))
  const confidences = raw.map((result) => result.confidence)
  const labels = predictions.map((prediction) => prediction.correctness)
  const finiteScores = confidences.filter((value) => Number.isFinite(value))

  if (finiteScores.length !== confidences.length || finiteScores.length === 0) {
    return {
      metrics: {
        sampleCount: confidences.length,
        ece: null,
        brier: null,
        auc: null,
        meanConfidence: null,
        stdConfidence: null,
        minConfidence: null,
        maxConfidence: null,
        accuracy: null,
        internalReportedEceMean: finite(mean(raw.map((result) => result.ece))),
        internalReportedBrierMean: finite(mean(raw.map((result) => result.brierScore))),
        nonFiniteConfidences: confidences.length - finiteScores.length,
      },
      confidences,
      raw,
    }
  }

  const avg = mean(finiteScores)
  const variance = mean(finiteScores.map((value) => (value - avg) ** 2))
  const classifications = confidences.map((value) => (value >= 0.5 ? 1 : 0))
  const correct = classifications.filter((value, index) => value === labels[index]).length
  const auc = computeAuc(confidences, labels)

  return {
    metrics: {
      sampleCount: confidences.length,
      ece: finite(computeEce(confidences, labels)),
      brier: finite(computeBrier(confidences, labels)),
      auc: auc === null ? null : finite(auc),
      meanConfidence: finite(avg),
      stdConfidence: finite(Math.sqrt(variance)),
      minConfidence: finite(Math.min(...finiteScores)),
      maxConfidence: finite(Math.max(...finiteScores)),
      accuracy: finite(correct / confidences.length),
      internalReportedEceMean: finite(mean(raw.map((result) => result.ece))),
      internalReportedBrierMean: finite(mean(raw.map((result) => result.brierScore))),
      nonFiniteConfidences: 0,
    },
    confidences,
    raw,
  }
}

function pearson(a: readonly number[], b: readonly number[]): number | null {
  if (a.length !== b.length || a.length === 0) return null
  const avgA = mean(a)
  const avgB = mean(b)
  let numerator = 0
  let varA = 0
  let varB = 0
  for (let i = 0; i < a.length; i++) {
    const da = a[i]! - avgA
    const db = b[i]! - avgB
    numerator += da * db
    varA += da * da
    varB += db * db
  }
  if (varA === 0 || varB === 0) return null
  return numerator / Math.sqrt(varA * varB)
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
} {
  const finiteValues = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  if (finiteValues.length === 0) {
    return { count: 0, min: null, max: null, mean: null, std: null, p10: null, p50: null, p90: null }
  }
  const avg = mean(finiteValues)
  const variance = mean(finiteValues.map((value) => (value - avg) ** 2))
  const quantile = (p: number) =>
    finiteValues[Math.min(finiteValues.length - 1, Math.max(0, Math.floor(p * (finiteValues.length - 1))))]!
  return {
    count: finiteValues.length,
    min: finite(finiteValues[0]!),
    max: finite(finiteValues[finiteValues.length - 1]!),
    mean: finite(avg),
    std: finite(Math.sqrt(variance)),
    p10: finite(quantile(0.1)),
    p50: finite(quantile(0.5)),
    p90: finite(quantile(0.9)),
  }
}

function aggregate(values: Array<number | null>): {
  count: number
  mean: number | null
  std: number | null
  min: number | null
  max: number | null
} {
  const finiteValues = values.filter((value): value is number => value !== null && Number.isFinite(value))
  if (finiteValues.length === 0) return { count: 0, mean: null, std: null, min: null, max: null }
  const avg = mean(finiteValues)
  const variance = mean(finiteValues.map((value) => (value - avg) ** 2))
  return {
    count: finiteValues.length,
    mean: finite(avg),
    std: finite(Math.sqrt(variance)),
    min: finite(Math.min(...finiteValues)),
    max: finite(Math.max(...finiteValues)),
  }
}

// ─── Data + calibrator runs ──────────────────────────────────────────

const predictions = buildPredictions()
const trainPredictions = predictions.filter((prediction) => prediction.split === "train")
const holdoutPredictions = predictions.filter((prediction) => prediction.split === "holdout")
const trainLabels = trainPredictions.map((prediction) => prediction.correctness)
const holdoutLabels = holdoutPredictions.map((prediction) => prediction.correctness)

const config: Partial<CalibratorConfig> = {
  hiddenDim: 32,
  numLayers: 2,
  numHeads: 4,
  dropoutRate: 0,
  temperature: 1,
  numBins: 10,
  minSamplesPerBin: 1,
}

const rawTrainMetrics = {
  ece: finite(computeEce(trainPredictions.map((prediction) => prediction.statedConfidence), trainLabels)),
  brier: finite(computeBrier(trainPredictions.map((prediction) => prediction.statedConfidence), trainLabels)),
  auc: finite(computeAuc(trainPredictions.map((prediction) => prediction.statedConfidence), trainLabels)!),
  meanConfidence: finite(mean(trainPredictions.map((prediction) => prediction.statedConfidence))),
  accuracy: finite(
    trainPredictions.filter((prediction) => (prediction.statedConfidence >= 0.5 ? 1 : 0) === prediction.correctness)
      .length / trainPredictions.length,
  ),
}

const rawHoldoutMetrics = {
  ece: finite(computeEce(holdoutPredictions.map((prediction) => prediction.statedConfidence), holdoutLabels)),
  brier: finite(computeBrier(holdoutPredictions.map((prediction) => prediction.statedConfidence), holdoutLabels)),
  auc: finite(computeAuc(holdoutPredictions.map((prediction) => prediction.statedConfidence), holdoutLabels)!),
  meanConfidence: finite(mean(holdoutPredictions.map((prediction) => prediction.statedConfidence))),
  accuracy: finite(
    holdoutPredictions.filter(
      (prediction) => (prediction.statedConfidence >= 0.5 ? 1 : 0) === prediction.correctness,
    ).length / holdoutPredictions.length,
  ),
}

interface SeedRun {
  seed: number
  baseline: { train: EvaluationMetrics; holdout: EvaluationMetrics }
  postTraining: { train: EvaluationMetrics; holdout: EvaluationMetrics }
  improvement: { holdoutEce: number | null; holdoutBrier: number | null; holdoutAuc: number | null }
  scoreChange: {
    maxAbsDiff: number | null
    meanAbsDiff: number | null
    changedFraction: number | null
    pearson: number | null
  }
  confidenceDistribution: {
    baselineHoldout: ReturnType<typeof distribution>
    postTrainingHoldout: ReturnType<typeof distribution>
  }
  training: {
    durationMs: number
    epochs: number
    initialLoss: number | null
    finalLoss: number | null
    lossDecreased: boolean
    finiteHistory: boolean
    lossHistory: Array<number | null>
    calibrationErrorHistory: Array<number | null>
  }
}

const seedRuns: SeedRun[] = []

for (const seed of CALIBRATION_SEEDS) {
  const run = runWithSeededModelRandom(seed, (): SeedRun => {
    const calibrator = new ConfidenceCalibrator(BASE_HIDDEN_SIZE, config)

    const baselineTrain = evaluate(calibrator, trainPredictions)
    const baselineHoldout = evaluate(calibrator, holdoutPredictions)

    const batches = trainPredictions.map((prediction) => ({
      features: prediction.features,
      labels: {
        correctness: new Array<number>(SEQ_LEN).fill(prediction.correctness),
        difficulty: new Array<number>(SEQ_LEN).fill(1 - prediction.statedConfidence),
      },
    }))

    const started = performance.now()
    const history = calibrator.train(batches, EPOCHS, LEARNING_RATE)
    const durationMs = performance.now() - started

    const afterTrain = evaluate(calibrator, trainPredictions)
    const afterHoldout = evaluate(calibrator, holdoutPredictions)

    let maxAbsDiff = 0
    let sumAbsDiff = 0
    let changed = 0
    for (let i = 0; i < baselineHoldout.confidences.length; i++) {
      const before = baselineHoldout.confidences[i]!
      const after = afterHoldout.confidences[i]!
      if (!Number.isFinite(before) || !Number.isFinite(after)) continue
      const diff = Math.abs(before - after)
      maxAbsDiff = Math.max(maxAbsDiff, diff)
      sumAbsDiff += diff
      if (diff > 1e-12) changed++
    }

    const beforeEce = baselineHoldout.metrics.ece
    const afterEce = afterHoldout.metrics.ece
    const beforeBrier = baselineHoldout.metrics.brier
    const afterBrier = afterHoldout.metrics.brier
    const beforeAuc = baselineHoldout.metrics.auc
    const afterAuc = afterHoldout.metrics.auc

    return {
      seed,
      baseline: { train: baselineTrain.metrics, holdout: baselineHoldout.metrics },
      postTraining: { train: afterTrain.metrics, holdout: afterHoldout.metrics },
      improvement: {
        holdoutEce: beforeEce !== null && afterEce !== null ? finite(beforeEce - afterEce) : null,
        holdoutBrier:
          beforeBrier !== null && afterBrier !== null ? finite(beforeBrier - afterBrier) : null,
        holdoutAuc: beforeAuc !== null && afterAuc !== null ? finite(afterAuc - beforeAuc) : null,
      },
      scoreChange: {
        maxAbsDiff: finite(maxAbsDiff),
        meanAbsDiff: finite(sumAbsDiff / Math.max(1, baselineHoldout.confidences.length)),
        changedFraction: finite(changed / Math.max(1, baselineHoldout.confidences.length)),
        pearson: finite(pearson(baselineHoldout.confidences, afterHoldout.confidences) ?? Number.NaN),
      },
      confidenceDistribution: {
        baselineHoldout: distribution(baselineHoldout.confidences),
        postTrainingHoldout: distribution(afterHoldout.confidences),
      },
      training: {
        durationMs: round(durationMs, 3),
        epochs: history.epochs.length,
        initialLoss: history.losses.length > 0 ? finite(history.losses[0]!) : null,
        finalLoss: finite(history.finalLoss),
        lossDecreased:
          history.losses.length > 1 &&
          history.finalLoss < (history.losses[0] ?? Number.POSITIVE_INFINITY) - 1e-9,
        finiteHistory: [...history.losses, ...history.calibrationErrors].every((value) => Number.isFinite(value)),
        lossHistory: history.losses.map((value) => finite(value)),
        calibrationErrorHistory: history.calibrationErrors.map((value) => finite(value)),
      },
    }
  })
  seedRuns.push(run)
}

const holdoutEceImprovements = seedRuns.map((run) => run.improvement.holdoutEce)
const holdoutBrierImprovements = seedRuns.map((run) => run.improvement.holdoutBrier)

const aggregates = {
  baselineHoldoutEce: aggregate(seedRuns.map((run) => run.baseline.holdout.ece)),
  postTrainingHoldoutEce: aggregate(seedRuns.map((run) => run.postTraining.holdout.ece)),
  holdoutEceImprovement: aggregate(holdoutEceImprovements),
  baselineHoldoutBrier: aggregate(seedRuns.map((run) => run.baseline.holdout.brier)),
  postTrainingHoldoutBrier: aggregate(seedRuns.map((run) => run.postTraining.holdout.brier)),
  holdoutBrierImprovement: aggregate(holdoutBrierImprovements),
  baselineHoldoutAuc: aggregate(seedRuns.map((run) => run.baseline.holdout.auc)),
  postTrainingHoldoutAuc: aggregate(seedRuns.map((run) => run.postTraining.holdout.auc)),
  changedFraction: aggregate(seedRuns.map((run) => run.scoreChange.changedFraction)),
  trainingDurationMs: aggregate(seedRuns.map((run) => run.training.durationMs)),
  initialLoss: aggregate(seedRuns.map((run) => run.training.initialLoss)),
  finalLoss: aggregate(seedRuns.map((run) => run.training.finalLoss)),
}

const seedsWithLossDecrease = seedRuns.filter((run) => run.training.lossDecreased).length

const seedsWithEceImprovement = holdoutEceImprovements.filter(
  (value): value is number => value !== null && value >= ECE_IMPROVEMENT_THRESHOLD,
).length
const seedsWithBrierImprovement = holdoutBrierImprovements.filter(
  (value): value is number => value !== null && value >= BRIER_IMPROVEMENT_THRESHOLD,
).length
const seedsWorseEce = holdoutEceImprovements.filter(
  (value): value is number => value !== null && value < 0,
).length
const seedsWorseBrier = holdoutBrierImprovements.filter(
  (value): value is number => value !== null && value < 0,
).length

// ─── Knowledge boundary, forgetting, gaps ────────────────────────────

type DomainTruth = "known" | "unknown"
type DomainGroup = "recent_known" | "recent_unknown" | "old_known" | "old_unknown"

interface DomainSpec {
  domain: string
  truth: DomainTruth
  group: DomainGroup
  ageDays: number
  successes: number
  failures: number
}

function buildDomainSpecs(): DomainSpec[] {
  const specs: DomainSpec[] = []
  for (let i = 0; i < 10; i++) {
    specs.push({
      domain: `recent-known-${i}`,
      truth: "known",
      group: "recent_known",
      ageDays: 0.5 + (i % 5) * 0.3,
      successes: 3,
      failures: 0,
    })
  }
  for (let i = 0; i < 10; i++) {
    specs.push({
      domain: `recent-unknown-${i}`,
      truth: "unknown",
      group: "recent_unknown",
      ageDays: 0.5 + (i % 5) * 0.3,
      successes: 0,
      failures: 3,
    })
  }
  for (let i = 0; i < 10; i++) {
    specs.push({
      domain: `old-known-${i}`,
      truth: "known",
      group: "old_known",
      ageDays: 25 + i * 1.7,
      successes: 3,
      failures: 0,
    })
  }
  for (let i = 0; i < 10; i++) {
    specs.push({
      domain: `old-unknown-${i}`,
      truth: "unknown",
      group: "old_unknown",
      ageDays: 25 + i * 1.7,
      successes: 0,
      failures: 3,
    })
  }
  return specs
}

function binaryMetrics(
  predictions: readonly { predicted: boolean; actual: boolean }[],
): {
  tp: number
  fp: number
  fn: number
  tn: number
  precision: number | null
  recall: number | null
  f1: number | null
  accuracy: number
} {
  let tp = 0
  let fp = 0
  let fn = 0
  let tn = 0
  for (const { predicted, actual } of predictions) {
    if (predicted && actual) tp++
    else if (predicted && !actual) fp++
    else if (!predicted && actual) fn++
    else tn++
  }
  const precision = tp + fp > 0 ? tp / (tp + fp) : null
  const recall = tp + fn > 0 ? tp / (tp + fn) : null
  const f1 =
    precision !== null && recall !== null && precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : precision === 0 || recall === 0
        ? 0
        : null
  return {
    tp,
    fp,
    fn,
    tn,
    precision: precision === null ? null : finite(precision),
    recall: recall === null ? null : finite(recall),
    f1: f1 === null ? null : finite(f1),
    accuracy: finite((tp + tn) / predictions.length)!,
  }
}

const domainSpecs = buildDomainSpecs()
const metacog = new AgentMetacog()
const now = Date.now()

for (const spec of domainSpecs) {
  const interactionCount = spec.successes + spec.failures
  const latest = now - spec.ageDays * DAY_MS
  for (let k = 0; k < interactionCount; k++) {
    const timestamp = new Date(latest - (interactionCount - 1 - k) * 60_000)
    metacog.recordInteraction({
      domain: spec.domain,
      query: `synthetic query ${k} in ${spec.domain}`,
      success: k < spec.successes,
      timestamp,
      failureReason:
        k >= spec.successes ? `unresolved concept in ${spec.domain}` : undefined,
    })
  }
}

const boundary = metacog.getKnowledgeBoundary()
const predictedKnown = new Set(boundary.knownTopics)
const recentSpecs = domainSpecs.filter((spec) => spec.group.startsWith("recent"))
const boundaryMetrics = binaryMetrics(
  recentSpecs.map((spec) => ({
    predicted: predictedKnown.has(spec.domain),
    actual: spec.truth === "known",
  })),
)

const alerts = metacog.detectForgetting()
const alertDomains = new Set(alerts.map((alert) => alert.domain))
const expectedForgettingDomains = new Set(
  domainSpecs.filter((spec) => spec.group === "old_known").map((spec) => spec.domain),
)
const forgettingMetrics = binaryMetrics(
  domainSpecs.map((spec) => ({
    predicted: alertDomains.has(spec.domain),
    actual: expectedForgettingDomains.has(spec.domain),
  })),
)

const alertGroupCounts: Record<string, { expected: number; detected: number }> = {}
for (const group of ["recent_known", "recent_unknown", "old_known", "old_unknown"] as const) {
  const inGroup = domainSpecs.filter((spec) => spec.group === group)
  alertGroupCounts[group] = {
    expected: inGroup.filter((spec) => expectedForgettingDomains.has(spec.domain)).length,
    detected: inGroup.filter((spec) => alertDomains.has(spec.domain)).length,
  }
}
const actionCounts: Record<string, number> = {}
for (const alert of alerts) actionCounts[alert.action] = (actionCounts[alert.action] ?? 0) + 1

const gaps = metacog.getActiveGaps()
const gapDomains = new Set(gaps.map((gap) => gap.domain))
const expectedGapDomains = new Set(
  domainSpecs.filter((spec) => spec.truth === "unknown").map((spec) => spec.domain),
)
const gapMetrics = binaryMetrics(
  domainSpecs.map((spec) => ({
    predicted: gapDomains.has(spec.domain),
    actual: expectedGapDomains.has(spec.domain),
  })),
)
const severityCounts: Record<string, number> = {}
for (const gap of gaps) severityCounts[gap.severity] = (severityCounts[gap.severity] ?? 0) + 1

const consolidation = metacog.shouldConsolidate()

const boundaryF1 = boundaryMetrics.f1

// Sanity check: with the default minSamplesPerBin=5, a three-token call
// cannot fill any bin, so calibrate() reports ECE=0 by construction.
const defaultMinSamplesCalibrator = new ConfidenceCalibrator(BASE_HIDDEN_SIZE, {
  ...config,
  minSamplesPerBin: 5,
})
const defaultMinSamplesResult = defaultMinSamplesCalibrator.calibrate(
  holdoutPredictions[0]!.features,
)

// ─── Decision ────────────────────────────────────────────────────────

const meanEceImprovement = aggregates.holdoutEceImprovement.mean
const meanBrierImprovement = aggregates.holdoutBrierImprovement.mean
const calibrationPass =
  (meanEceImprovement !== null && meanEceImprovement >= ECE_IMPROVEMENT_THRESHOLD) ||
  (meanBrierImprovement !== null && meanBrierImprovement >= BRIER_IMPROVEMENT_THRESHOLD)
const boundaryPass = boundaryF1 !== null && boundaryF1 >= BOUNDARY_F1_THRESHOLD
const verdict = calibrationPass && boundaryPass ? "add-opt-in" : "do-not-add"

const reasons: string[] = []
if (!calibrationPass) {
  reasons.push(
    `mean holdout ECE improvement is ${meanEceImprovement === null ? "undefined" : meanEceImprovement.toFixed(4)} (< ${ECE_IMPROVEMENT_THRESHOLD}) and mean Brier improvement is ${meanBrierImprovement === null ? "undefined" : meanBrierImprovement.toFixed(4)} (< ${BRIER_IMPROVEMENT_THRESHOLD})`,
  )
}
if (boundaryPass) {
  reasons.push(`knowledge-boundary F1 is ${boundaryF1.toFixed(4)} (>= ${BOUNDARY_F1_THRESHOLD})`)
} else {
  reasons.push(`knowledge-boundary F1 is ${boundaryF1 === null ? "undefined" : boundaryF1.toFixed(4)} (< ${BOUNDARY_F1_THRESHOLD})`)
}
reasons.push(
  `only ${seedsWithEceImprovement}/${seedRuns.length} seeds reach +${ECE_IMPROVEMENT_THRESHOLD} ECE improvement and ${seedsWithBrierImprovement}/${seedRuns.length} reach +${BRIER_IMPROVEMENT_THRESHOLD} Brier improvement; ${seedsWorseEce}/${seedRuns.length} seeds make ECE worse and ${seedsWorseBrier}/${seedRuns.length} make Brier worse`,
)
reasons.push(
  "ConfidenceCalibrator.trainStep applies zero-mean random weight noise scaled by loss.total, not a gradient; train() cannot systematically fit the correctness labels",
)
reasons.push(
  `training loss decreased in only ${seedsWithLossDecrease}/${seedRuns.length} seeds (mean ${aggregates.initialLoss.mean?.toFixed(4) ?? "n/a"} -> ${aggregates.finalLoss.mean?.toFixed(4) ?? "n/a"}); regularization dominates`,
)
reasons.push(
  `the raw stated confidence already has holdout ECE ${rawHoldoutMetrics.ece?.toFixed(4) ?? "n/a"} and Brier ${rawHoldoutMetrics.brier?.toFixed(4) ?? "n/a"}, far better than the calibrator's ${aggregates.baselineHoldoutEce.mean?.toFixed(4) ?? "n/a"} / ${aggregates.baselineHoldoutBrier.mean?.toFixed(4) ?? "n/a"}`,
)
reasons.push(
  "calibrate() reports ECE/Brier against token-likelihood pseudo-labels, not ground-truth correctness; with default minSamplesPerBin=5 and 3 tokens per call its ECE is 0 by construction",
)
if (forgettingMetrics.precision !== null) {
  reasons.push(
    `forgetting precision is ${forgettingMetrics.precision.toFixed(4)} because old unknown domains also trigger decay alerts, even though there is no learned knowledge to forget`,
  )
}

const result = {
  experiment: "agent-metacog-bench",
  package: "@fengrru/agent-metacog",
  generatedAt: new Date().toISOString(),
  gitCommit: null,
  config: {
    dataSeed: DATA_SEED,
    predictions: N_PREDICTIONS,
    trainSize: TRAIN_SIZE,
    holdoutSize: HOLDOUT_SIZE,
    calibrationSeeds: CALIBRATION_SEEDS,
    epochs: EPOCHS,
    learningRate: LEARNING_RATE,
    calibrator: config,
    baseHiddenSize: BASE_HIDDEN_SIZE,
    sequenceLength: SEQ_LEN,
    hiddenProbability: "p(correct) = 0.15 + 0.6*q",
    eceImprovementThreshold: ECE_IMPROVEMENT_THRESHOLD,
    brierImprovementThreshold: BRIER_IMPROVEMENT_THRESHOLD,
    boundaryF1Threshold: BOUNDARY_F1_THRESHOLD,
  },
  design: {
    calibration:
      "200 predictions with stated confidence q evenly covering [0.05, 0.95]; correctness drawn from a hidden miscalibrated probability p=0.15+0.6q; stratified 100/100 split over q. Features are deterministic functions of q only; correctness is never a feature.",
    features:
      "3-token StreamFeatures: hiddenStates basis encoding of q, attentionEntropy from entropy of q, tokenLogLikelihoods = log(q) with fixed offsets. Dropout disabled for deterministic evaluation.",
    trainingLabels:
      "correctness label repeated across 3 token positions; difficulty target = 1-q. These are the labels the API accepts; randomness comes from model init and trainStep.",
    seeds:
      "8 independent model seeds; the dataset is fixed. Variance across seeds is reported because trainStep is stochastic.",
    knowledgeBoundary:
      "40 domains: 10 recent known (3 successes), 10 recent unknown (3 failures), 10 old known (3 successes, 25-40 days), 10 old unknown (3 failures, 25-40 days). Boundary F1 evaluated on the 20 recent domains.",
    forgetting:
      "Ground-truth alert = old known domain. Old unknown domains are false positives (never learned, so nothing to forget); recent domains should not alert.",
    gaps:
      "Ground-truth gap = unknown domain (failures supplied a failureReason); known domains never received a failureReason.",
  },
  dataset: {
    train: {
      count: trainPredictions.length,
      positives: trainLabels.filter((label) => label === 1).length,
      negatives: trainLabels.filter((label) => label === 0).length,
      meanStatedConfidence: finite(mean(trainPredictions.map((prediction) => prediction.statedConfidence))),
      meanHiddenProbability: finite(mean(trainPredictions.map((prediction) => prediction.hiddenProbability))),
    },
    holdout: {
      count: holdoutPredictions.length,
      positives: holdoutLabels.filter((label) => label === 1).length,
      negatives: holdoutLabels.filter((label) => label === 0).length,
      meanStatedConfidence: finite(mean(holdoutPredictions.map((prediction) => prediction.statedConfidence))),
      meanHiddenProbability: finite(mean(holdoutPredictions.map((prediction) => prediction.hiddenProbability))),
    },
    statedConfidenceReference: {
      note: "Reference metrics for the raw stated confidence q, before any calibrator.",
      train: rawTrainMetrics,
      holdout: rawHoldoutMetrics,
    },
  },
  calibration: {
    perSeed: seedRuns,
    aggregates,
    stability: {
      seeds: seedRuns.length,
      seedsWithEceImprovementAtLeastThreshold: seedsWithEceImprovement,
      seedsWithBrierImprovementAtLeastThreshold: seedsWithBrierImprovement,
      seedsWorseEce,
      seedsWorseBrier,
      seedsWithLossDecrease,
    },
    internalMetricCaveat: {
      note: "calibrate() computes ECE/Brier against 'corrected' pseudo-labels derived from tokenLogLikelihoods, not against caller-supplied correctness. Its internal numbers are not calibration quality.",
      perCallEceWithDefaultMinSamples5: finite(defaultMinSamplesResult.ece),
      perCallBrierWithDefaultMinSamples5: finite(defaultMinSamplesResult.brierScore),
      expectedZeroBecauseTokenCountLessThanMinSamples: SEQ_LEN < 5,
    },
  },
  knowledgeBoundary: {
    domainCount: domainSpecs.length,
    recentDomainCount: recentSpecs.length,
    metrics: boundaryMetrics,
    global: {
      knownTopics: boundary.knownTopics.length,
      unknownTopics: boundary.unknownTopics.length,
      note: "Global counts include old known domains whose effective confidence has decayed below 0.6; boundary F1 above is computed only on recent domains to isolate classification from decay.",
    },
  },
  forgetting: {
    metrics: forgettingMetrics,
    detectedAlerts: alerts.length,
    expectedAlerts: expectedForgettingDomains.size,
    alertGroupCounts,
    actionCounts,
    note: "detectForgetting() keys only on retention; it does not check whether the domain was ever known.",
  },
  gaps: {
    metrics: gapMetrics,
    gapCount: gaps.length,
    severityCounts,
    note: "Gaps are created directly from failureReason in recordInteraction; this is bookkeeping, not an inferred knowledge-boundary detector.",
  },
  consolidation: {
    needed: consolidation.needed,
    reasons: consolidation.reasons,
    queueLength: metacog.getConsolidationQueue().length,
    note: "Consolidation tasks are generated for every old domain, including unknown ones, because they share the same decay alert path.",
  },
  decision: {
    rule: `add-opt-in iff (mean holdout ECE improvement >= ${ECE_IMPROVEMENT_THRESHOLD} OR mean holdout Brier improvement >= ${BRIER_IMPROVEMENT_THRESHOLD}) AND knowledge-boundary F1 >= ${BOUNDARY_F1_THRESHOLD}`,
    meanHoldoutEceImprovement: meanEceImprovement,
    meanHoldoutBrierImprovement: meanBrierImprovement,
    knowledgeBoundaryF1: boundaryF1,
    calibrationPass,
    boundaryPass,
    verdict,
    reasons,
  },
  limitations: [
    "Synthetic predictions only; q is a fabricated stated confidence and the hidden correctness probability is monotone, so this does not establish behavior on real LLM streams.",
    "The calibrator runs at hiddenDim=32, 2 layers, 4 heads with dropout disabled; default hiddenDim=512/baseHidden=4096 may behave differently (and is much slower).",
    "trainStep adds random noise (randomMatrix) scaled by loss.total, not a loss gradient, and applies 'weight decay' with the wrong sign (+lr*1e-4*W). Any change is a random walk, not learning.",
    "The only ground-truth metrics here are computed externally; calibrate()'s ece/brierScore fields use token-likelihood pseudo-labels and must not be trusted.",
    "With seqLen=3 and default minSamplesPerBin=5, per-call ECE is identically 0 because no bin reaches 5 samples.",
    "Knowledge-boundary F1 is easy in this synthetic setup: known domains have 3 successes, unknown domains 3 failures, and recent access avoids decay. It tests API behavior, not real-world boundary detection.",
    "Forgetting precision is capped near 0.5 by construction because old unknown domains are indistinguishable from old known domains to a retention-only detector.",
    "Gap precision/recall is tautological: gaps are created only when a failureReason is supplied.",
    "No real labels, no LLM hidden states or attention maps, and no temporal sequence beyond one last-access timestamp per domain.",
  ],
}

const resultsDir = join(import.meta.dir, "results")
mkdirSync(resultsDir, { recursive: true })
const resultsPath = join(resultsDir, "agent-metacog-bench.json")
writeFileSync(resultsPath, `${JSON.stringify(result, null, 2)}\n`, "utf8")

console.log("agent-metacog benchmark")
console.log(
  `  predictions: ${N_PREDICTIONS} (train ${trainPredictions.length} / holdout ${holdoutPredictions.length}); seeds ${CALIBRATION_SEEDS.length}`,
)
console.log(
  `  holdout ECE: ${aggregates.baselineHoldoutEce.mean?.toFixed(4) ?? "n/a"} -> ${aggregates.postTrainingHoldoutEce.mean?.toFixed(4) ?? "n/a"} (improvement ${meanEceImprovement === null ? "n/a" : (meanEceImprovement >= 0 ? "+" : "") + meanEceImprovement.toFixed(4)}, std ${aggregates.holdoutEceImprovement.std?.toFixed(4) ?? "n/a"})`,
)
console.log(
  `  holdout Brier: ${aggregates.baselineHoldoutBrier.mean?.toFixed(4) ?? "n/a"} -> ${aggregates.postTrainingHoldoutBrier.mean?.toFixed(4) ?? "n/a"} (improvement ${meanBrierImprovement === null ? "n/a" : (meanBrierImprovement >= 0 ? "+" : "") + meanBrierImprovement.toFixed(4)}, std ${aggregates.holdoutBrierImprovement.std?.toFixed(4) ?? "n/a"})`,
)
console.log(
  `  raw stated-confidence holdout ECE/Brier: ${rawHoldoutMetrics.ece?.toFixed(4) ?? "n/a"} / ${rawHoldoutMetrics.brier?.toFixed(4) ?? "n/a"}`,
)
console.log(
  `  knowledge boundary F1: ${boundaryF1 === null ? "n/a" : boundaryF1.toFixed(4)} (precision ${boundaryMetrics.precision?.toFixed(4) ?? "n/a"}, recall ${boundaryMetrics.recall?.toFixed(4) ?? "n/a"})`,
)
console.log(
  `  forgetting precision/recall/F1: ${forgettingMetrics.precision?.toFixed(4) ?? "n/a"} / ${forgettingMetrics.recall?.toFixed(4) ?? "n/a"} / ${forgettingMetrics.f1?.toFixed(4) ?? "n/a"} (alerts ${alerts.length}, expected ${expectedForgettingDomains.size})`,
)
console.log(
  `  gaps precision/recall/F1: ${gapMetrics.precision?.toFixed(4) ?? "n/a"} / ${gapMetrics.recall?.toFixed(4) ?? "n/a"} / ${gapMetrics.f1?.toFixed(4) ?? "n/a"} (${gaps.length} gaps)`,
)
console.log(
  `  seeds reaching thresholds: ECE ${seedsWithEceImprovement}/${seedRuns.length}, Brier ${seedsWithBrierImprovement}/${seedRuns.length}; worse: ECE ${seedsWorseEce}, Brier ${seedsWorseBrier}`,
)
console.log(
  `  training loss: ${aggregates.initialLoss.mean?.toFixed(4) ?? "n/a"} -> ${aggregates.finalLoss.mean?.toFixed(4) ?? "n/a"}; decreased in ${seedsWithLossDecrease}/${seedRuns.length} seeds`,
)
console.log(`  decision: ${verdict}`)
for (const reason of reasons) console.log(`    - ${reason}`)
console.log(`  wrote ${resultsPath}`)
