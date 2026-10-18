/**
 * Experiment — can @fengrru/code-sandbox SecureExecutor serve as a security boundary?
 *
 * Seven malicious/privilege-escalation snippets are executed with a temporary
 * secret file and a temporary marker path. A normal console.log and an infinite
 * loop (timeout) are the positive controls. No network access, no real user
 * files, and no destructive commands are used.
 *
 * Decision rule: `add-as-sandbox` only if there are zero escapes/secret leaks,
 * normal code executes, and the timeout terminates. Otherwise `do-not-add`.
 * This bench is a gate, not an endorsement: dsh already owns approval/sandbox.
 *
 * Run: node --experimental-strip-types experiments/code-sandbox-security-bench.ts
 */

import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { SecureExecutor } from "../../awesome-agent-infra/packages/code-sandbox/src/index.ts"

const RESULTS_DIR = fileURLToPath(new URL("./results", import.meta.url))
const RESULT_FILE = join(RESULTS_DIR, "code-sandbox-security-bench.json")

interface ExecutionResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
  durationMs: number
  error?: string
}

interface Executor {
  execute(code: string, stdin?: string): Promise<ExecutionResult>
}

interface Probe {
  id: string
  label: string
  expectation: string
  code: string
}

interface ProbeRecord {
  id: string
  label: string
  expectation: string
  code: string
  executedSuccessfully: boolean
  exitCode: number
  timedOut: boolean
  durationMs: number
  error: string | null
  stdout: string
  stderr: string
  secretLeaked: boolean
  markerCreated: boolean
  escapeSucceeded: boolean
  contained: boolean
  staticGuardBlocked: boolean
  processObtained: boolean
}

const SECRET_VALUE = `DSH_SANDBOX_SECRET_${randomUUID().replace(/-/g, "").slice(0, 16)}`
const benchmarkRoot = mkdtempSync(join(tmpdir(), "agent-infra-code-sandbox-bench-"))
const secretPath = join(benchmarkRoot, "secret.txt")
const markerPath = join(benchmarkRoot, "marker.txt")
const previousSecret = process.env.SECRET

function cleanupBenchmark(): void {
  try {
    rmSync(benchmarkRoot, { recursive: true, force: true })
  } catch {
    // Best-effort cleanup; the path only contains this experiment's temp files.
  }
  if (previousSecret === undefined) delete process.env.SECRET
  else process.env.SECRET = previousSecret
}

// Guarantee cleanup even if a probe or the writer throws before the final block.
process.once("exit", cleanupBenchmark)

writeFileSync(secretPath, `${SECRET_VALUE}\n`, "utf8")
process.env.SECRET = SECRET_VALUE

const secretLiteral = JSON.stringify(secretPath)
const markerLiteral = JSON.stringify(markerPath)
const shellCommand = `echo pwned > "${markerPath}"`

const probes: Probe[] = [
  {
    id: "E1",
    label: "fs.readFileSync(secret)",
    expectation: "require('fs') must be blocked; secret must not reach stdout/stderr.",
    code: [
      `const fs = require("fs")`,
      `const data = fs.readFileSync(${secretLiteral}, "utf8")`,
      `console.log("SECRET_LEAK:" + data.trim())`,
    ].join("\n"),
  },
  {
    id: "E2",
    label: "process.env.SECRET",
    expectation: "The spawned child receives only allowedEnvironment, so SECRET must be undefined.",
    code: `console.log("ENV_SECRET:" + process.env.SECRET)`,
  },
  {
    id: "E3",
    label: "child_process.execSync writes marker",
    expectation: "require('child_process') must be blocked; marker file must not be created.",
    code: [
      `const cp = require("child_process")`,
      `cp.execSync(${JSON.stringify(shellCommand)})`,
      `console.log("EXEC_DONE")`,
    ].join("\n"),
  },
  {
    id: "E4",
    label: "await import('node:fs') reads secret",
    expectation: "Dynamic import must be rejected statically before the child is spawned.",
    code: [
      `;(async () => {`,
      `  const fs = await import("node:fs")`,
      `  const data = fs.readFileSync(${secretLiteral}, "utf8")`,
      `  console.log("SECRET_LEAK:" + data.trim())`,
      `})().catch((error) => { console.error("IMPORT_ERROR:" + error.message); process.exitCode = 1 })`,
    ].join("\n"),
  },
  {
    id: "E5",
    label: "process.binding / process.mainModule escape",
    expectation: "process.binding is stubbed; process.mainModule.require must stay behind the Module hook.",
    code: [
      `const results = []`,
      `try {`,
      `  const binding = process.binding("fs")`,
      `  results.push("BINDING_OK:" + typeof binding)`,
      `} catch (error) { results.push("BINDING_ERR:" + error.message) }`,
      `try {`,
      `  const main = process.mainModule`,
      `  results.push("MAIN_MODULE:" + (main ? "present" : "absent"))`,
      `  if (main) {`,
      `    try {`,
      `      const fs = main.require("fs")`,
      `      const data = fs.readFileSync(${secretLiteral}, "utf8")`,
      `      results.push("SECRET_LEAK:" + data.trim())`,
      `    } catch (error) { results.push("MAIN_REQUIRE_ERR:" + error.message) }`,
      `  }`,
      `} catch (error) { results.push("MAIN_ERR:" + error.message) }`,
      `console.log(results.join(" | "))`,
    ].join("\n"),
  },
  {
    id: "E6",
    label: "this.constructor.constructor('return process')()",
    expectation: "The Function constructor must not yield a process object that can bypass the stubs.",
    code: [
      `try {`,
      `  const hostProcess = this.constructor.constructor("return process")()`,
      `  console.log("PROCESS_OBTAINED:" + (hostProcess === process ? "same" : "different"))`,
      `  console.log("ENV_SECRET:" + hostProcess.env.SECRET)`,
      `  try {`,
      `    hostProcess.binding("fs")`,
      `    console.log("BINDING_BYPASS")`,
      `  } catch (error) { console.log("BINDING_ERR:" + error.message) }`,
      `} catch (error) { console.log("ESCAPE_ERR:" + error.message) }`,
    ].join("\n"),
  },
  {
    id: "E7",
    label: "globalThis.process / require('module') combination",
    expectation:
      "require('module') must be blocked; if globalThis.process exposes getBuiltinModule, that would be a real fs escape.",
    code: [
      `const results = []`,
      `try {`,
      `  results.push("GLOBAL_PROCESS:" + (globalThis.process === process ? "same" : "different"))`,
      `  const gp = globalThis.process`,
      `  if (gp && typeof gp.getBuiltinModule === "function") {`,
      `    results.push("GET_BUILTIN_MODULE:available")`,
      `    try {`,
      `      const fs = gp.getBuiltinModule("fs")`,
      `      const data = fs.readFileSync(${secretLiteral}, "utf8")`,
      `      results.push("SECRET_LEAK:" + data.trim())`,
      `      fs.writeFileSync(${markerLiteral}, "pwned")`,
      `      results.push("MARKER_WRITTEN")`,
      `    } catch (error) { results.push("GET_BUILTIN_ERR:" + error.message) }`,
      `  } else { results.push("GET_BUILTIN_MODULE:absent") }`,
      `  try {`,
      `    const M = require("module")`,
      `    results.push("MODULE_REQUIRED:" + typeof M)`,
      `  } catch (error) { results.push("MODULE_REQUIRE_ERR:" + error.message) }`,
      `} catch (error) { results.push("OUTER_ERR:" + error.message) }`,
      `console.log(results.join(" | "))`,
    ].join("\n"),
  },
]

function clip(text: string, limit = 4000): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}...[truncated]`
}

function redact(text: string): string {
  return clip(
    text
      .split(SECRET_VALUE)
      .join("[REDACTED_SECRET]")
      .split(benchmarkRoot)
      .join("<TEMP>"),
  )
}

async function runProbe(executor: Executor, probe: Probe): Promise<ProbeRecord> {
  const result = await executor.execute(probe.code)
  const combinedOutput = `${result.stdout}\n${result.stderr}`
  const secretLeaked = combinedOutput.includes(SECRET_VALUE)
  const markerCreated = existsSync(markerPath)

  if (markerCreated) {
    rmSync(markerPath, { force: true })
  }

  const executedSuccessfully = result.exitCode === 0 && !result.timedOut && !result.error
  const staticGuardBlocked = `${combinedOutput}\n${result.error ?? ""}`.includes(
    "dynamic import() is not allowed in sandbox",
  )
  const processObtained = result.stdout.includes("PROCESS_OBTAINED:same")

  return {
    id: probe.id,
    label: probe.label,
    expectation: probe.expectation,
    code: redact(probe.code),
    executedSuccessfully,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    error: result.error ? redact(result.error) : null,
    stdout: redact(result.stdout),
    stderr: redact(result.stderr),
    secretLeaked,
    markerCreated,
    escapeSucceeded: secretLeaked || markerCreated,
    contained: !secretLeaked && !markerCreated,
    staticGuardBlocked,
    processObtained,
  }
}

const securityExecutor = new SecureExecutor({ timeoutMs: 3000 })
const timeoutExecutor = new SecureExecutor({ timeoutMs: 750 })

const securityRecords: ProbeRecord[] = []
for (const probe of probes) {
  securityRecords.push(await runProbe(securityExecutor, probe))
}

const normalResult = await securityExecutor.execute(`console.log("ok")`)
const normalCodeExecuted =
  normalResult.exitCode === 0 &&
  !normalResult.timedOut &&
  !normalResult.error &&
  normalResult.stdout.trim() === "ok"

const timeoutResult = await timeoutExecutor.execute(`while (true) {}`)
const timeoutTerminated = timeoutResult.timedOut === true && timeoutResult.exitCode !== 0

const breaches = securityRecords.filter((record) => record.secretLeaked || record.markerCreated)
const processPrimitives = securityRecords.filter((record) => record.processObtained)
const dynamicImportRecord = securityRecords.find((record) => record.id === "E4")!
const staticGuardWorked = dynamicImportRecord.staticGuardBlocked

const gatePassed = breaches.length === 0 && normalCodeExecuted && timeoutTerminated
const decision = gatePassed ? "add-as-sandbox" : "do-not-add"

const result = {
  experiment: "code-sandbox-security-bench",
  generatedAt: new Date().toISOString(),
  package: {
    source: "../../awesome-agent-infra/packages/code-sandbox/src/index.ts",
    version: "0.2.0",
    executor: "SecureExecutor",
    constructorUsed: "new SecureExecutor({ timeoutMs })",
    packageDisclaimer:
      "SecureExecutor's own docstring calls this a defense-in-depth mitigation, NOT a true isolation boundary; it recommends OS-level isolation for adversarial code.",
  },
  runtime: {
    node: process.version,
    platform: process.platform,
  },
  secretHandling: {
    secretFile: "temporary file under the experiment temp directory",
    envSecret: "parent process SECRET; the child only receives allowedEnvironment",
    secretValuePersisted: false,
    note: "The synthetic secret is redacted from stored stdout/stderr; only leak booleans are persisted.",
  },
  probes: securityRecords,
  positiveControls: {
    normal: {
      code: 'console.log("ok")',
      executed: normalCodeExecuted,
      exitCode: normalResult.exitCode,
      stdout: normalResult.stdout,
      timedOut: normalResult.timedOut,
      durationMs: normalResult.durationMs,
      error: normalResult.error ?? null,
    },
    timeout: {
      code: "while (true) {}",
      timeoutMs: 750,
      terminated: timeoutTerminated,
      timedOut: timeoutResult.timedOut,
      exitCode: timeoutResult.exitCode,
      durationMs: timeoutResult.durationMs,
      error: timeoutResult.error ?? null,
    },
  },
  summary: {
    requiredProbes: probes.length,
    executedSuccessfully: securityRecords.filter((record) => record.executedSuccessfully).length,
    secretLeaks: securityRecords.filter((record) => record.secretLeaked).length,
    markerFilesCreated: securityRecords.filter((record) => record.markerCreated).length,
    escapes: breaches.length,
    escapedProbeIds: breaches.map((record) => record.id),
    processPrimitivesObtained: processPrimitives.length,
    processPrimitiveProbeIds: processPrimitives.map((record) => record.id),
    staticDynamicImportBlocked: staticGuardWorked,
    normalCodeExecuted,
    timeoutTerminated,
    gatePassed,
    decision,
    decisionRule:
      "add-as-sandbox only if 0 escapes/secret leaks, normal code executes, and the infinite loop is terminated by timeout; otherwise do-not-add.",
  },
  decision: {
    value: decision,
    gatePassed,
    rule:
      "add-as-sandbox only if 0 escapes/secret leaks, normal code executes, and the infinite loop is terminated by timeout; otherwise do-not-add.",
    observed: {
      escapes: breaches.length,
      escapedProbeIds: breaches.map((record) => record.id),
      secretLeaks: securityRecords.filter((record) => record.secretLeaked).length,
      markerFilesCreated: securityRecords.filter((record) => record.markerCreated).length,
      normalCodeExecuted,
      timeoutTerminated,
    },
    rationale: gatePassed
      ? "All security probes were contained, normal code executed, and the timeout terminated the infinite loop."
      : `Gate failed: ${breaches.length} escape(s) (${breaches.map((record) => record.id).join(", ")}); a probe read the temporary secret and/or wrote the marker file.`,
  },
  findings: [
    "E1 (fs) and E3 (child_process) fail at the Module.require hook; E4 (dynamic import) is rejected statically before the child is spawned.",
    "E2 shows environment filtering works: the child sees process.env.SECRET as undefined.",
    "E5 shows process.mainModule is present, but main.require('fs') still hits the blocked-module hook and process.binding is stubbed.",
    "E6 obtains the host process object through the Function constructor; the object is reachable even though dangerous methods are stubbed.",
    "E7 is a real escape: globalThis.process.getBuiltinModule('fs') bypasses the Module._load require hook, reads the temporary secret, and writes the marker file.",
    "The timeout and environment filtering work, but in-process module hooks are bypassable; a determined in-process JavaScript adversary can reach Node built-ins.",
  ],
  existingDshControls: {
    approval: true,
    sandbox: true,
    evidence: [
      "super-dsh/SECURITY.md: SuperDSH runs inside the dsh process with the same privileges as the harness; it is not a sandbox, an authorization layer, or a substitute for dsh's approval and sandbox policies.",
      "super-dsh/docs/analysis/README.md: dsh already has approval/sandbox capabilities and they are more mature than most packages.",
    ],
    gate:
      "Even if this bench passed, adoption is gated by dsh's existing approval/sandbox. This experiment only tests whether code-sandbox adds a trustworthy boundary; it does not justify replacing dsh controls.",
  },
  securityConstraints: {
    tempDirectoryOnly: true,
    networkUsed: false,
    realUserFilesRead: false,
    destructiveCommandsUsed: false,
    tempCleaned: false,
    note: "Secret and marker files live only under a fresh OS temp directory; the marker is deleted after each probe; the directory is removed after the run.",
  },
}

cleanupBenchmark()
process.removeListener("exit", cleanupBenchmark)
const tempCleaned = !existsSync(benchmarkRoot)
result.securityConstraints.tempCleaned = tempCleaned

mkdirSync(RESULTS_DIR, { recursive: true })
writeFileSync(RESULT_FILE, `${JSON.stringify(result, null, 2)}\n`, "utf8")

console.log("=== code-sandbox-security-bench ===")
console.log(`probes: ${probes.length}; executed successfully: ${result.summary.executedSuccessfully}`)
for (const record of securityRecords) {
  console.log(
    `${record.id} ${record.label}: executed=${record.executedSuccessfully} ` +
      `secretLeaked=${record.secretLeaked} markerCreated=${record.markerCreated} ` +
      `processObtained=${record.processObtained} timedOut=${record.timedOut} ` +
      `error=${record.error ?? "none"}`,
  )
}
console.log(
  `positive controls: normal=${normalCodeExecuted} timeoutTerminated=${timeoutTerminated} ` +
    `(loop ${timeoutResult.durationMs}ms)`,
)
console.log(`escapes: ${breaches.length} (${breaches.map((record) => record.id).join(", ") || "none"})`)
console.log(`decision: ${decision}`)
console.log(`result: ${RESULT_FILE}`)
