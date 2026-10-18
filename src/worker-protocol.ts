/**
 * JSON-RPC 2.0 / NDJSON worker protocol and task state machine.
 *
 * This is a codec plus a deterministic state machine; it does not spawn
 * processes, open sockets, or integrate with dsh. A host (dsh or another
 * runner) owns transport and process lifecycle. Wire messages use the
 * execute/checkpoint/result/cancel vocabulary and snake_case fields so a
 * Python or Node worker can implement them without a schema translation.
 *
 * Frames are one JSON object per line. Decoding rejects empty lines, invalid
 * JSON, frames over 1 MiB, unknown methods, and messages missing required
 * fields. Encoding is deterministic (canonical JSON key order) and always
 * terminates the frame with exactly one newline.
 */

import { canonicalJson } from './shared.ts'

export const MAX_WORKER_LINE_BYTES = 1024 * 1024

export type WorkerRpcId = string | number
export type WorkerMethod = 'execute' | 'checkpoint' | 'result' | 'cancel'
export type WorkerResultStatus = 'completed' | 'failed' | 'cancelled'

export interface WorkerExecute {
  jsonrpc: '2.0'
  id: WorkerRpcId
  method: 'execute'
  params: {
    task_id: string
    session_id?: string
    intent?: unknown
    inputs?: unknown[]
    from_step?: number
    capabilities?: string[]
    timeout_ms?: number
    token_budget?: number
  }
}

export interface WorkerCheckpoint {
  jsonrpc: '2.0'
  id: WorkerRpcId
  method: 'checkpoint'
  params: {
    task_id: string
    step_index: number
    actions?: unknown[]
    artifacts?: unknown[]
    progress_percent?: number
  }
}

export interface WorkerResult {
  jsonrpc: '2.0'
  id: WorkerRpcId
  method: 'result'
  params: {
    task_id: string
    status: WorkerResultStatus
    result?: unknown
    error?: unknown
    artifacts?: unknown[]
    metrics?: {
      duration_ms?: number
      tokens_consumed?: number
      cost_cents?: number
      [key: string]: unknown
    }
  }
}

export interface WorkerCancel {
  jsonrpc: '2.0'
  id: WorkerRpcId
  method: 'cancel'
  params: {
    task_id: string
    reason?: string
    timeout_ms?: number
  }
}

export type WorkerMessage = WorkerExecute | WorkerCheckpoint | WorkerResult | WorkerCancel

export type WorkerDecodeResult =
  | { ok: true; value: WorkerMessage }
  | { ok: false; error: string }

/**
 * Encode one NDJSON frame. The message is validated first so an invalid frame
 * cannot be written by accident; the decoder applies the same validation.
 */
export function encodeWorkerMessage(message: WorkerMessage): string {
  const error = validateWorkerMessage(message)
  if (error !== undefined) throw new TypeError(`encodeWorkerMessage: ${error}`)
  return `${canonicalJson(message)}\n`
}

export function decodeWorkerLine(line: string): WorkerDecodeResult {
  if (typeof line !== 'string') {
    return { ok: false, error: 'worker line must be a string' }
  }
  const bytes = Buffer.byteLength(line, 'utf8')
  if (bytes > MAX_WORKER_LINE_BYTES) {
    return {
      ok: false,
      error: `worker line is too large: ${bytes} bytes (maximum ${MAX_WORKER_LINE_BYTES})`,
    }
  }
  if (line.trim().length === 0) {
    return { ok: false, error: 'empty worker line' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `invalid JSON: ${detail}` }
  }

  const error = validateWorkerMessage(parsed)
  if (error !== undefined) return { ok: false, error }
  return { ok: true, value: parsed as WorkerMessage }
}

export function validateWorkerMessage(value: unknown): string | undefined {
  const message = asRecord(value)
  if (message === undefined) return 'message must be a JSON object'
  if (message.jsonrpc !== '2.0') return 'missing or invalid "jsonrpc" (expected "2.0")'
  if (!isRpcId(message.id)) return 'missing or invalid "id"'
  if (typeof message.method !== 'string') return 'missing or invalid "method"'

  const params = asRecord(message.params)
  if (params === undefined) return `"params" must be an object for method "${message.method}"`
  if (!isNonEmptyString(params.task_id)) return 'missing field "task_id"'

  switch (message.method) {
    case 'execute':
      return validateExecute(params)
    case 'checkpoint':
      return validateCheckpoint(params)
    case 'result':
      return validateResult(params)
    case 'cancel':
      return validateCancel(params)
    default:
      return `unknown method "${message.method}"`
  }
}

export function isWorkerMessage(value: unknown): value is WorkerMessage {
  return validateWorkerMessage(value) === undefined
}

function validateExecute(params: Record<string, unknown>): string | undefined {
  if (params.session_id !== undefined && !isNonEmptyString(params.session_id)) {
    return 'invalid field "session_id"'
  }
  if (params.inputs !== undefined && !Array.isArray(params.inputs)) {
    return 'invalid field "inputs" (expected an array)'
  }
  if (params.from_step !== undefined && !isNonNegativeInteger(params.from_step)) {
    return 'invalid field "from_step" (expected a non-negative integer)'
  }
  if (params.capabilities !== undefined) {
    if (!Array.isArray(params.capabilities) || !params.capabilities.every(isNonEmptyString)) {
      return 'invalid field "capabilities" (expected an array of strings)'
    }
  }
  if (params.timeout_ms !== undefined && !isNonNegativeNumber(params.timeout_ms)) {
    return 'invalid field "timeout_ms" (expected a non-negative number)'
  }
  if (params.token_budget !== undefined && !isNonNegativeNumber(params.token_budget)) {
    return 'invalid field "token_budget" (expected a non-negative number)'
  }
  return undefined
}

function validateCheckpoint(params: Record<string, unknown>): string | undefined {
  if (!isNonNegativeInteger(params.step_index)) {
    return 'missing or invalid field "step_index" (expected a non-negative integer)'
  }
  if (params.actions !== undefined && !Array.isArray(params.actions)) {
    return 'invalid field "actions" (expected an array)'
  }
  if (params.artifacts !== undefined && !Array.isArray(params.artifacts)) {
    return 'invalid field "artifacts" (expected an array)'
  }
  if (params.progress_percent !== undefined) {
    if (!isNonNegativeNumber(params.progress_percent) || params.progress_percent > 100) {
      return 'invalid field "progress_percent" (expected a number between 0 and 100)'
    }
  }
  return undefined
}

function validateResult(params: Record<string, unknown>): string | undefined {
  if (!isResultStatus(params.status)) {
    return 'missing or invalid field "status" (expected completed, failed, or cancelled)'
  }
  if (params.artifacts !== undefined && !Array.isArray(params.artifacts)) {
    return 'invalid field "artifacts" (expected an array)'
  }
  if (params.metrics !== undefined && asRecord(params.metrics) === undefined) {
    return 'invalid field "metrics" (expected an object)'
  }
  if (params.error !== undefined && typeof params.error !== 'string' && asRecord(params.error) === undefined) {
    return 'invalid field "error" (expected a string or object)'
  }
  return undefined
}

function validateCancel(params: Record<string, unknown>): string | undefined {
  if (params.reason !== undefined && typeof params.reason !== 'string') {
    return 'invalid field "reason" (expected a string)'
  }
  if (params.timeout_ms !== undefined && !isNonNegativeNumber(params.timeout_ms)) {
    return 'invalid field "timeout_ms" (expected a non-negative number)'
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Task state machine
// ---------------------------------------------------------------------------

export type WorkerTaskStatus =
  | 'queued'
  | 'running'
  | 'checkpointing'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface WorkerTaskStateOptions {
  /** Stable task label. Default: "task". */
  taskId?: string
  /** Lifetime measured from construction, in milliseconds. */
  deadlineMs?: number
  /** Injectable clock for deterministic deadline tests. Default: Date.now. */
  now?: () => number
}

export interface WorkerCheckpointRecord {
  step: number
  at: number
}

export interface WorkerTaskSnapshot {
  taskId: string
  status: WorkerTaskStatus
  step: number
  checkpoints: WorkerCheckpointRecord[]
  deadlineAt?: number
  result?: unknown
  error?: unknown
  cancelReason?: string
}

export function isTerminalWorkerStatus(status: WorkerTaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

/**
 * queued -> running -> checkpointing -> completed | failed | cancelled
 *
 * `running` and `checkpointing` both accept further checkpoints, completion,
 * failure, and cancellation. `fail` and `cancel` are also allowed from
 * `queued` so a queued task can be rejected or withdrawn. Terminal states are
 * final. Deadlines are checked when starting, checkpointing, or completing; an
 * expired task becomes `failed` with a `deadline_exceeded` error.
 */
export class WorkerTaskState {
  private readonly _taskId: string
  private readonly _now: () => number
  private readonly _deadlineAt: number | undefined
  private readonly _checkpoints: WorkerCheckpointRecord[] = []
  private _status: WorkerTaskStatus = 'queued'
  private _step = 0
  private _result: unknown
  private _error: unknown
  private _cancelReason: string | undefined

  constructor(options?: WorkerTaskStateOptions)
  constructor(taskId: string, options?: Omit<WorkerTaskStateOptions, 'taskId'>)
  constructor(
    taskIdOrOptions: string | WorkerTaskStateOptions = {},
    maybeOptions: Omit<WorkerTaskStateOptions, 'taskId'> = {},
  ) {
    const options = typeof taskIdOrOptions === 'string'
      ? { ...maybeOptions, taskId: taskIdOrOptions }
      : taskIdOrOptions
    if (options.taskId !== undefined && !isNonEmptyString(options.taskId)) {
      throw new TypeError('WorkerTaskState: taskId must be a non-empty string')
    }
    if (options.now !== undefined && typeof options.now !== 'function') {
      throw new TypeError('WorkerTaskState: now must be a function returning epoch milliseconds')
    }
    if (
      options.deadlineMs !== undefined
      && (!isNonNegativeNumber(options.deadlineMs) || !Number.isFinite(options.deadlineMs))
    ) {
      throw new TypeError('WorkerTaskState: deadlineMs must be a non-negative finite number')
    }

    this._taskId = options.taskId ?? 'task'
    this._now = options.now ?? Date.now
    if (options.deadlineMs !== undefined) {
      const deadlineAt = this.clockNow() + Math.floor(options.deadlineMs)
      if (!Number.isSafeInteger(deadlineAt)) {
        throw new RangeError('WorkerTaskState: deadlineMs overflows the supported timestamp range')
      }
      this._deadlineAt = deadlineAt
    }
  }

  get taskId(): string {
    return this._taskId
  }

  get status(): WorkerTaskStatus {
    return this._status
  }

  get step(): number {
    return this._step
  }

  get checkpoints(): WorkerCheckpointRecord[] {
    return this._checkpoints.map(record => ({ ...record }))
  }

  get deadlineAt(): number | undefined {
    return this._deadlineAt
  }

  /**
   * Lazily expire the task. Returns true when this call moved an active task to
   * `failed` because its deadline passed.
   */
  checkDeadline(): boolean {
    if (this._deadlineAt === undefined || isTerminalWorkerStatus(this._status)) return false
    if (this.clockNow() > this._deadlineAt) {
      this._status = 'failed'
      this._error = {
        code: 'deadline_exceeded',
        message: `worker task "${this._taskId}" exceeded its deadline`,
      }
      return true
    }
    return false
  }

  start(): WorkerTaskSnapshot {
    this.assertStatus(['queued'], 'start')
    this.assertDeadline()
    this._status = 'running'
    return this.snapshot()
  }

  checkpoint(step: number): WorkerTaskSnapshot {
    this.assertStatus(['running', 'checkpointing'], 'checkpoint')
    this.assertDeadline()
    if (!isNonNegativeInteger(step)) {
      throw new TypeError('WorkerTaskState.checkpoint: step must be a non-negative integer')
    }
    if (step <= this._step) {
      throw new Error(
        `worker task "${this._taskId}": stale checkpoint step ${step}; expected a step greater than ${this._step}`,
      )
    }
    const at = this.clockNow()
    this._status = 'checkpointing'
    this._step = step
    this._checkpoints.push({ step, at })
    return this.snapshot()
  }

  complete(result?: unknown): WorkerTaskSnapshot {
    this.assertStatus(['running', 'checkpointing'], 'complete')
    this.assertDeadline()
    this._status = 'completed'
    this._result = result
    return this.snapshot()
  }

  fail(error: unknown): WorkerTaskSnapshot {
    this.assertStatus(['queued', 'running', 'checkpointing'], 'fail')
    this._status = 'failed'
    this._error = error
    return this.snapshot()
  }

  cancel(reason?: string): WorkerTaskSnapshot {
    this.assertStatus(['queued', 'running', 'checkpointing'], 'cancel')
    if (reason !== undefined && typeof reason !== 'string') {
      throw new TypeError('WorkerTaskState.cancel: reason must be a string')
    }
    this._status = 'cancelled'
    this._cancelReason = reason
    return this.snapshot()
  }

  snapshot(): WorkerTaskSnapshot {
    return {
      taskId: this._taskId,
      status: this._status,
      step: this._step,
      checkpoints: this._checkpoints.map(record => ({ ...record })),
      ...(this._deadlineAt === undefined ? {} : { deadlineAt: this._deadlineAt }),
      ...(this._result === undefined ? {} : { result: this._result }),
      ...(this._error === undefined ? {} : { error: this._error }),
      ...(this._cancelReason === undefined ? {} : { cancelReason: this._cancelReason }),
    }
  }

  toJSON(): WorkerTaskSnapshot {
    return this.snapshot()
  }

  private assertStatus(allowed: readonly WorkerTaskStatus[], action: string): void {
    if (allowed.includes(this._status)) return
    throw new Error(
      `worker task "${this._taskId}": cannot ${action} from ${this._status}`
      + ' (illegal transition)',
    )
  }

  private assertDeadline(): void {
    if (this.checkDeadline()) {
      throw new Error(`worker task "${this._taskId}": deadline exceeded`)
    }
  }

  private clockNow(): number {
    const value = this._now()
    if (!isNonNegativeNumber(value) || !Number.isFinite(value)) {
      throw new TypeError('WorkerTaskState: now() must return a non-negative finite number')
    }
    return Math.floor(value)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRpcId(value: unknown): value is WorkerRpcId {
  return (typeof value === 'string' && value.length > 0)
    || (typeof value === 'number' && Number.isFinite(value))
}

function isResultStatus(value: unknown): value is WorkerResultStatus {
  return value === 'completed' || value === 'failed' || value === 'cancelled'
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
