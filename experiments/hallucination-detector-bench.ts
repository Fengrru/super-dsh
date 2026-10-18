/**
 * Experiment — can @fengrru/hallucination-detector judge factual truth?
 *
 * 30 hand-labelled claims (15 true, 15 false but fluent) are fed to
 * HallucinationDetector.detect() with no external evidence. The detector's
 * hallucination flags are compared with the manual fact labels (precision,
 * recall, F1). Five additional self-contradictory passages probe whether the
 * internal-consistency path catches negation.
 *
 * Decision rule: `add-opt-in` only when F1 >= 0.70; otherwise `do-not-add`.
 *
 * The sibling package is a Bun workspace that is not installed in this
 * checkout. Its private @fengrru/internal-tfidf dependency is resolved to the
 * workspace source with Node's synchronous module hooks. No network/model calls.
 *
 * Run: node --experimental-strip-types experiments/hallucination-detector-bench.ts
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { registerHooks } from "node:module"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const DETECTOR_SOURCE = fileURLToPath(
  new URL("../../awesome-agent-infra/packages/hallucination-detector/src/index.ts", import.meta.url),
)
const INTERNAL_TFIDF_SOURCE = fileURLToPath(
  new URL("../../awesome-agent-infra/packages/internal-tfidf/src/index.ts", import.meta.url),
)
const RESULTS_DIR = fileURLToPath(new URL("./results", import.meta.url))
const RESULT_FILE = join(RESULTS_DIR, "hallucination-detector-bench.json")

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@fengrru/internal-tfidf") {
      return { url: pathToFileURL(INTERNAL_TFIDF_SOURCE).href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

interface FactClaim {
  text: string
  startIndex: number
  endIndex: number
  confidence: number
  source: string
}

interface ClusterResult {
  clusterId: number
  claims: FactClaim[]
  centroid: number[]
  coherence: number
}

interface HallucinationReport {
  claims: FactClaim[]
  clusters: ClusterResult[]
  hallucinations: FactClaim[]
  overallScore: number
  details: string
}

interface Detector {
  detect(
    text: string,
    options?: { referenceFacts?: string[]; knowledgeBase?: string[] },
  ): HallucinationReport
  computeSimilarity(a: string, b: string): number
}

type DetectorConstructor = new (config?: Record<string, unknown>) => Detector

const detectorModule = (await import(pathToFileURL(DETECTOR_SOURCE).href)) as {
  HallucinationDetector: DetectorConstructor
}
const detector = new detectorModule.HallucinationDetector()

type Label = "true" | "false"

interface ClaimCase {
  id: string
  pair: string
  label: Label
  category: string
  text: string
}

const claims: ClaimCase[] = [
  // Paris pair
  { id: "T01", pair: "paris", label: "true", category: "location", text: "The Eiffel Tower is located in Paris, France." },
  { id: "F01", pair: "paris", label: "false", category: "location", text: "The Eiffel Tower is located in Berlin, Germany." },
  // Pacific pair
  { id: "T02", pair: "pacific", label: "true", category: "quantity", text: "The Pacific Ocean is the largest ocean on Earth." },
  { id: "F02", pair: "pacific", label: "false", category: "quantity", text: "The Pacific Ocean is the smallest ocean on Earth." },
  // Everest pair
  { id: "T03", pair: "everest", label: "true", category: "location", text: "Mount Everest is the highest mountain above sea level." },
  { id: "F03", pair: "everest", label: "false", category: "location", text: "Mount Everest is the highest mountain in Australia." },
  // Gold pair
  { id: "T04", pair: "gold", label: "true", category: "entity", text: "The chemical symbol for gold is Au." },
  { id: "F04", pair: "gold", label: "false", category: "entity", text: "The chemical symbol for gold is Ag." },
  // Boiling pair
  { id: "T05", pair: "boiling", label: "true", category: "quantity", text: "Water boils at 100 degrees Celsius at sea level." },
  { id: "F05", pair: "boiling", label: "false", category: "quantity", text: "Water boils at 50 degrees Celsius at sea level." },
  // Great Wall pair
  { id: "T06", pair: "great-wall", label: "true", category: "location", text: "The Great Wall of China is located in China." },
  { id: "F06", pair: "great-wall", label: "false", category: "location", text: "The Great Wall of China is located in India." },
  // Tokyo pair
  { id: "T07", pair: "tokyo", label: "true", category: "location", text: "The capital of Japan is Tokyo." },
  { id: "F07", pair: "tokyo", label: "false", category: "location", text: "The capital of Japan is Kyoto." },
  // Einstein pair
  { id: "T08", pair: "einstein", label: "true", category: "person", text: "Albert Einstein developed the theory of relativity." },
  { id: "F08", pair: "einstein", label: "false", category: "person", text: "Albert Einstein developed the theory of evolution." },
  // Amazon pair
  { id: "T09", pair: "amazon", label: "true", category: "location", text: "The Amazon River flows through Brazil." },
  { id: "F09", pair: "amazon", label: "false", category: "location", text: "The Amazon River flows through Egypt." },
  // Heart pair
  { id: "T10", pair: "heart", label: "true", category: "quantity", text: "The human heart has four chambers." },
  { id: "F10", pair: "heart", label: "false", category: "quantity", text: "The human heart has three chambers." },
  // Moon pair
  { id: "T11", pair: "moon", label: "true", category: "entity", text: "The Moon orbits the Earth." },
  { id: "F11", pair: "moon", label: "false", category: "entity", text: "The Moon orbits Mars." },
  // Nobel pair
  { id: "T12", pair: "nobel", label: "true", category: "person", text: "The Nobel Prize was established by Alfred Nobel." },
  { id: "F12", pair: "nobel", label: "false", category: "person", text: "The Nobel Prize was established by Isaac Newton." },
  // French Revolution pair
  { id: "T13", pair: "revolution", label: "true", category: "date", text: "The French Revolution began in 1789." },
  { id: "F13", pair: "revolution", label: "false", category: "date", text: "The French Revolution began in 1912." },
  // Python pair
  { id: "T14", pair: "python", label: "true", category: "person", text: "Python is a programming language created by Guido van Rossum." },
  { id: "F14", pair: "python", label: "false", category: "person", text: "Python is a programming language created by James Gosling." },
  // Sahara pair
  { id: "T15", pair: "sahara", label: "true", category: "location", text: "The Sahara Desert is located in Africa." },
  { id: "F15", pair: "sahara", label: "false", category: "location", text: "The Sahara Desert is located in Australia." },
]

interface Metrics {
  actualPositives: number
  predictedPositives: number
  truePositives: number
  falsePositives: number
  falseNegatives: number
  trueNegatives: number
  precision: number
  recall: number
  f1: number
  precisionDefined: boolean
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000
}

function evaluate(predictions: Array<{ claim: ClaimCase; detected: boolean }>): Metrics {
  let truePositives = 0
  let falsePositives = 0
  let falseNegatives = 0
  let trueNegatives = 0

  for (const { claim, detected } of predictions) {
    if (claim.label === "false" && detected) truePositives++
    else if (claim.label === "true" && detected) falsePositives++
    else if (claim.label === "false" && !detected) falseNegatives++
    else trueNegatives++
  }

  const precision = ratio(truePositives, truePositives + falsePositives)
  const recall = ratio(truePositives, truePositives + falseNegatives)
  const f1 = ratio(2 * precision * recall, precision + recall)

  return {
    actualPositives: truePositives + falseNegatives,
    predictedPositives: truePositives + falsePositives,
    truePositives,
    falsePositives,
    falseNegatives,
    trueNegatives,
    precision: round(precision),
    recall: round(recall),
    f1: round(f1),
    precisionDefined: truePositives + falsePositives > 0,
  }
}

function corpusEvaluation() {
  const started = Date.now()
  const corpusText = claims.map((claim) => claim.text).join("\n")
  const report = detector.detect(corpusText)
  const durationMs = Date.now() - started

  const flaggedTexts = new Set(report.hallucinations.map((claim) => claim.text))
  const extractedByText = new Map(report.claims.map((claim) => [claim.text, claim]))

  const details = claims.map((claim) => {
    const extracted = extractedByText.get(claim.text)
    const cluster = report.clusters.find((candidate) =>
      candidate.claims.some((clusterClaim) => clusterClaim.text === claim.text),
    )
    const coherence = cluster ? cluster.coherence : 0
    const confidence = extracted?.confidence ?? 0
    return {
      id: claim.id,
      pair: claim.pair,
      label: claim.label,
      category: claim.category,
      text: claim.text,
      detected: flaggedTexts.has(claim.text),
      extracted: Boolean(extracted),
      confidence: round(confidence),
      clusterId: cluster ? cluster.clusterId : null,
      clusterCoherence: round(coherence),
      derivedScore: round(confidence * 0.4 + coherence * 0.6),
    }
  })

  const predictions = details.map((detail) => {
    const claim = claims.find((candidate) => candidate.id === detail.id)!
    return { claim, detected: detail.detected }
  })

  const pairs = [...new Set(claims.map((claim) => claim.pair))].map((pair) => {
    const pairClaims = claims.filter((claim) => claim.pair === pair)
    const trueClaim = pairClaims.find((claim) => claim.label === "true")!
    const falseClaim = pairClaims.find((claim) => claim.label === "false")!
    const trueDetail = details.find((detail) => detail.id === trueClaim.id)!
    const falseDetail = details.find((detail) => detail.id === falseClaim.id)!
    return {
      pair,
      trueId: trueClaim.id,
      falseId: falseClaim.id,
      trueDetected: trueDetail.detected,
      falseDetected: falseDetail.detected,
      symmetricOutcome: trueDetail.detected === falseDetail.detected,
      falseOnlyDetected: !trueDetail.detected && falseDetail.detected,
    }
  })

  return {
    mode: "corpus",
    description: "One detect() call over all 30 claims joined by newlines.",
    durationMs,
    extractedClaimCount: report.claims.length,
    clusterCount: report.clusters.length,
    overallScore: round(report.overallScore),
    details: report.details,
    metrics: evaluate(predictions),
    claims: details,
    clusters: report.clusters.map((cluster) => ({
      clusterId: cluster.clusterId,
      size: cluster.claims.length,
      coherence: round(cluster.coherence),
      claimIds: cluster.claims.map(
        (clusterClaim) => claims.find((claim) => claim.text === clusterClaim.text)?.id ?? "unknown",
      ),
    })),
    pairAnalysis: {
      pairsTested: pairs.length,
      symmetricOutcomes: pairs.filter((pair) => pair.symmetricOutcome).length,
      falseOnlyDetected: pairs.filter((pair) => pair.falseOnlyDetected).length,
      pairs,
      note: "A fact-aware detector should flag the false member of a pair while leaving the true member unflagged (falseOnlyDetected). Symmetric outcomes mean the flag carries no factuality signal.",
    },
    falsePositives: details.filter((detail) => detail.label === "true" && detail.detected),
    falseNegatives: details.filter((detail) => detail.label === "false" && !detail.detected),
  }
}

function perClaimEvaluation() {
  const started = Date.now()
  const predictions = claims.map((claim) => {
    const report = detector.detect(claim.text)
    return {
      claim,
      detected: report.hallucinations.length > 0,
      hallucinationCount: report.hallucinations.length,
      extractedClaimCount: report.claims.length,
    }
  })
  const durationMs = Date.now() - started

  return {
    mode: "per-claim",
    description: "One detect() call per claim in isolation (no cross-claim context).",
    durationMs,
    metrics: evaluate(predictions.map(({ claim, detected }) => ({ claim, detected }))),
    detectedClaims: predictions
      .filter((entry) => entry.detected)
      .map((entry) => ({ id: entry.claim.id, label: entry.claim.label, text: entry.claim.text })),
    note: "A single claim forms a one-member cluster with coherence 1, so the internal-consistency score cannot flag it.",
  }
}

interface ContradictionProbe {
  id: string
  sentences: [string, string]
}

const contradictionProbes: ContradictionProbe[] = [
  {
    id: "C1",
    sentences: [
      "The Eiffel Tower is located in Paris.",
      "The Eiffel Tower is not located in Paris.",
    ],
  },
  {
    id: "C2",
    sentences: [
      "Water boils at 100 degrees Celsius at sea level.",
      "Water does not boil at 100 degrees Celsius at sea level.",
    ],
  },
  {
    id: "C3",
    sentences: ["The Moon orbits the Earth.", "The Moon does not orbit the Earth."],
  },
  {
    id: "C4",
    sentences: ["The capital of Japan is Tokyo.", "The capital of Japan is not Tokyo."],
  },
  {
    id: "C5",
    sentences: [
      "Albert Einstein developed the theory of relativity.",
      "Albert Einstein did not develop the theory of relativity.",
    ],
  },
]

function contradictionEvaluation() {
  const started = Date.now()
  const probes = contradictionProbes.map((probe) => {
    const text = probe.sentences.join("\n")
    const report = detector.detect(text)
    return {
      id: probe.id,
      text,
      similarity: round(detector.computeSimilarity(probe.sentences[0], probe.sentences[1])),
      extractedClaimCount: report.claims.length,
      flaggedCount: report.hallucinations.length,
      detected: report.hallucinations.length > 0,
      flaggedTexts: report.hallucinations.map((claim) => claim.text),
    }
  })

  return {
    description: "Five two-sentence passages that explicitly contradict themselves; ground truth is 'should be detected'.",
    durationMs: Date.now() - started,
    detectedCount: probes.filter((probe) => probe.detected).length,
    detectionRate: round(ratio(probes.filter((probe) => probe.detected).length, probes.length)),
    probes,
  }
}

function noClusterCapDiagnostic() {
  const diagnosticDetector = new detectorModule.HallucinationDetector({
    maxClusters: 100,
    minClusterSize: 1,
  })
  const corpusText = claims.map((claim) => claim.text).join("\n")
  const report = diagnosticDetector.detect(corpusText)
  const flaggedTexts = new Set(report.hallucinations.map((claim) => claim.text))
  const predictions = claims.map((claim) => ({ claim, detected: flaggedTexts.has(claim.text) }))

  return {
    description:
      "Same corpus and default threshold, but every claim keeps its cluster (maxClusters=100, minClusterSize=1). This isolates the factuality signal from the default maxClusters=5 truncation.",
    config: { maxClusters: 100, minClusterSize: 1 },
    extractedClaimCount: report.claims.length,
    clusterCount: report.clusters.length,
    flaggedCount: report.hallucinations.length,
    metrics: evaluate(predictions),
    falsePositiveIds: predictions.filter((p) => p.claim.label === "true" && p.detected).map((p) => p.claim.id),
    falseNegativeIds: predictions.filter((p) => p.claim.label === "false" && !p.detected).map((p) => p.claim.id),
  }
}

const corpus = corpusEvaluation()
const perClaim = perClaimEvaluation()
const noCap = noClusterCapDiagnostic()
const contradictions = contradictionEvaluation()

const decision = corpus.metrics.f1 >= 0.7 ? "add-opt-in" : "do-not-add"

const result = {
  experiment: "hallucination-detector-bench",
  generatedAt: new Date().toISOString(),
  package: {
    source: "../../awesome-agent-infra/packages/hallucination-detector/src/index.ts",
    version: "0.1.1",
    detector: "HallucinationDetector",
    api: {
      detect:
        "detect(text, options?: { referenceFacts?: string[]; knowledgeBase?: string[] }): HallucinationReport",
      optionalExternalEvidenceParams: ["referenceFacts", "knowledgeBase"],
      externalEvidenceUsed: false,
      internalConsistencyOnly:
        "Without caller-supplied referenceFacts/knowledgeBase, scoring is claim confidence + TF-IDF/Jaccard cluster coherence. The detector has no world knowledge and performs no fact lookup.",
      negationHandling:
        "Similarity is lexical (TF-IDF cosine + Jaccard); contradictory sentences that share words are treated as similar, not contradictory.",
    },
  },
  dataset: {
    totalClaims: claims.length,
    trueClaims: claims.filter((claim) => claim.label === "true").length,
    falseClaims: claims.filter((claim) => claim.label === "false").length,
    contradictionProbes: contradictionProbes.length,
    note: "False claims are fluent, single-claim self-consistent statements with one wrong location, date, person, quantity, or entity. Ground truth comes from manual fact labels, not from the detector.",
  },
  methodology: {
    primaryEvaluation: "corpus",
    secondaryEvaluation: "per-claim",
    decisionRule: "F1 >= 0.70 => add-opt-in; otherwise do-not-add",
    evaluationBoundary:
      "No external evidence is supplied. The experiment measures intrinsic factual judgment, not the optional caller-supplied knowledgeBase path.",
  },
  primary: corpus,
  secondary: perClaim,
  diagnostics: {
    noClusterCap: noCap,
  },
  contradictionProbes: contradictions,
  decision: {
    value: decision,
    threshold: 0.7,
    observedF1: corpus.metrics.f1,
    rationale:
      decision === "add-opt-in"
        ? "The detector reached the F1 gate on this benchmark."
        : `Corpus F1 ${corpus.metrics.f1.toFixed(4)} is below the 0.70 gate. ${corpus.pairAnalysis.symmetricOutcomes}/${corpus.pairAnalysis.pairsTested} true/false pairs received the same verdict, so the observed flags do not discriminate facts; without external evidence the detector is not a factual judge.`,
  },
}

mkdirSync(RESULTS_DIR, { recursive: true })
writeFileSync(RESULT_FILE, `${JSON.stringify(result, null, 2)}\n`, "utf8")

const m = corpus.metrics
const p = perClaim.metrics
console.log("=== hallucination-detector-bench ===")
console.log(`claims: ${claims.length} (true=${result.dataset.trueClaims}, false=${result.dataset.falseClaims})`)
console.log(
  `primary corpus: TP=${m.truePositives} FP=${m.falsePositives} FN=${m.falseNegatives} TN=${m.trueNegatives} ` +
    `precision=${m.precision} recall=${m.recall} F1=${m.f1}`,
)
console.log(`false positives (true claims flagged): ${corpus.falsePositives.length}`)
console.log(`false negatives (false claims missed): ${corpus.falseNegatives.length}`)
console.log(
  `pair analysis: ${corpus.pairAnalysis.symmetricOutcomes}/${corpus.pairAnalysis.pairsTested} symmetric; ` +
    `false-member-only flagged: ${corpus.pairAnalysis.falseOnlyDetected}`,
)
console.log(
  `per-claim isolated: TP=${p.truePositives} FP=${p.falsePositives} FN=${p.falseNegatives} F1=${p.f1}`,
)
console.log(
  `no-cluster-cap diagnostic: TP=${noCap.metrics.truePositives} FP=${noCap.metrics.falsePositives} ` +
    `FN=${noCap.metrics.falseNegatives} F1=${noCap.metrics.f1}`,
)
console.log(
  `self-contradiction probes detected: ${contradictions.detectedCount}/${contradictionProbes.length}`,
)
console.log(`decision: ${decision} (F1 threshold 0.70, observed ${m.f1})`)
console.log(`result: ${RESULT_FILE}`)
