/**
 * Experiment — Best-of-N planning quality with an LLM judge.
 *
 * Question: is "sample N candidate plans, then have an LLM judge pick one"
 * worth adding to SuperDSH as an opt-in max-mode planner?
 *
 * For each of four coding tasks (A-D) this benchmark:
 *   1. baseline: 2 independent single-plan calls at temperature 0.3;
 *   2. treatment: 3 candidate plans at temperature 0.9, then one judge call
 *      at temperature 0.1 that picks the best candidate;
 *   3. scores every plan deterministically (no model in the scorer):
 *        0.40 * required-file coverage
 *      + 0.30 * required-concept coverage
 *      + 0.15 * verification mentions tests/lint/verify
 *      + 0.15 * validity (referenced paths are all in the allowed tree)
 *
 * The decision rule is written into the result JSON. A low judge top-1
 * accuracy vetoes the treatment even when the oracle candidate is better.
 *
 * Requires DEEPSEEK_API_KEY. Optionally DEEPSEEK_BASE_URL (defaults to
 * https://api.deepseek.com). Failures are recorded, never fabricated.
 *
 * Run: bun experiments/best-of-n-plan-bench.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const EXPERIMENT = 'best-of-n-plan-bench'
const MODEL = 'deepseek-chat'
const API_KEY = process.env.DEEPSEEK_API_KEY
const BASE_URL = (process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, '')
const ENDPOINT = `${BASE_URL}/chat/completions`
const MAX_TOKENS = 1200
const REQUEST_TIMEOUT_MS = 120_000
const RETRIES = 2
const BASELINE_TEMPERATURE = 0.3
const CANDIDATE_TEMPERATURE = 0.9
const JUDGE_TEMPERATURE = 0.1

const DECISION_RULE
  = 'add-opt-in only if (judgeAvg - baselineAvg >= 0.10) AND (judgeTop1Accuracy >= 0.75) '
  + 'AND (tokenMultiplier < 3), where tokenMultiplier = all treatment tokens / all baseline tokens '
  + '(3 candidates + 1 judge vs 2 baseline samples). Otherwise do-not-add. '
  + 'A low judge top-1 accuracy vetoes oracle gains because an unreliable judge cannot capture them.'

// ---------------------------------------------------------------------------
// Task definitions
// ---------------------------------------------------------------------------

interface ConceptSpec {
  name: string
  patterns: RegExp[]
}

interface KeyFile {
  path: string
  content: string
}

interface TaskSpec {
  id: string
  title: string
  requirements: string
  repoTree: string
  keyFiles: KeyFile[]
  requiredFiles: string[]
  allowedFiles: string[]
  concepts: ConceptSpec[]
}

const TASKS: TaskSpec[] = [
  {
    id: 'A',
    title: 'HTTP client retry with exponential backoff and jitter',
    requirements: `Add resilient retries to the HTTP client in this repository.
- Route requests through a retry loop in src/http.ts while preserving the existing request(url, options) API.
- Implement exponential backoff with full jitter in src/retry.ts. For retry number n (1-based), the delay must be a random value in [0, min(maxDelayMs, baseDelayMs * 2^(n-1))].
- Retry network failures, HTTP 429, and HTTP 5xx. Do not retry other 4xx responses.
- Honor a Retry-After header for 429/503 when present, but never sleep longer than maxDelayMs.
- Honor maxAttempts: the total number of attempts must never exceed it.
- Keep per-attempt timeouts working; explain how timeoutMs interacts with retries.
- Add tests for first-attempt success, retry then success, retry exhaustion, non-retryable 4xx, and delay bounds/jitter.`,
    repoTree: `repo/
  package.json
  tsconfig.json
  src/
    config.ts
    http.ts
    index.ts
    retry.ts
  tests/
    http.test.ts
    retry.test.ts`,
    keyFiles: [
      {
        path: 'src/http.ts',
        content: `export interface HttpOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
}

export async function request(url: string, options: HttpOptions = {}): Promise<Response> {
  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers: options.headers,
    body: options.body,
  })
  if (!response.ok) throw new Error('HTTP ' + response.status)
  return response
}`,
      },
      {
        path: 'src/retry.ts',
        content: `export interface RetryPolicy {
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}`,
      },
    ],
    requiredFiles: ['src/http.ts', 'src/retry.ts'],
    allowedFiles: [
      'package.json',
      'tsconfig.json',
      'src/config.ts',
      'src/http.ts',
      'src/index.ts',
      'src/retry.ts',
      'tests/http.test.ts',
      'tests/retry.test.ts',
    ],
    concepts: [
      {
        name: 'retry',
        patterns: [/\bretr(?:y|ies|ying|ied)\b/i, /\breattempt/i],
      },
      {
        name: 'backoff',
        patterns: [/\bback[-\s_]?off\b/i, /\bexponential[-\s]+(?:delay|backoff)\b/i],
      },
      {
        name: 'jitter',
        patterns: [/\bjitter\b/i, /\brandom(?:ized)?[-\s]+(?:delay|backoff)\b/i],
      },
      {
        name: 'max attempts',
        patterns: [
          /\bmax(?:imum)?[-\s_]?(?:attempts?|retries)\b/i,
          /\battempt[-\s_]?(?:limit|cap|count|budget)\b/i,
          /\bretry[-\s_]?(?:limit|cap|budget)\b/i,
        ],
      },
    ],
  },
  {
    id: 'B',
    title: 'Cursor pagination and limit validation for the list API',
    requirements: `Add cursor-based pagination and limit validation to the list API.
- Extend ListRequest in src/types.ts with an optional cursor and limit.
- In src/api/list.ts, listItems must return a stable page ordered by item id plus nextPage: string | null.
- limit must be an integer from 1 to 100 inclusive, defaulting to 50. Reject invalid limits (0, negative, >100, non-integer, non-number) with ApiError status 400 from src/api/errors.ts.
- The cursor must be opaque. Decode it defensively; a malformed cursor must produce ApiError status 400, never a 500.
- nextPage must be null on the last page, otherwise a cursor that round-trips to the next item.
- Add tests for the first page, second page, last page, invalid limits, and malformed cursors.`,
    repoTree: `repo/
  package.json
  tsconfig.json
  src/
    server.ts
    types.ts
    api/
      errors.ts
      list.ts
  tests/
    list.test.ts
    validation.test.ts`,
    keyFiles: [
      {
        path: 'src/api/list.ts',
        content: `import type { Item, ListRequest, ListResponse } from '../types.ts'

export interface ListDeps {
  listItems(): Promise<Item[]>
}

const DEFAULT_LIMIT = 50

export async function listItems(input: ListRequest, deps: ListDeps): Promise<ListResponse> {
  const limit = input.limit ?? DEFAULT_LIMIT
  const rows = await deps.listItems()
  return { items: rows.slice(0, limit) }
}`,
      },
      {
        path: 'src/types.ts',
        content: `export interface Item {
  id: string
  name: string
  createdAt: string
}

export interface ListRequest {
  limit?: number
}

export interface ListResponse {
  items: Item[]
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}`,
      },
    ],
    requiredFiles: ['src/api/list.ts', 'src/types.ts'],
    allowedFiles: [
      'package.json',
      'tsconfig.json',
      'src/server.ts',
      'src/types.ts',
      'src/api/errors.ts',
      'src/api/list.ts',
      'tests/list.test.ts',
      'tests/validation.test.ts',
    ],
    concepts: [
      {
        name: 'cursor',
        patterns: [/\bcursor/i, /\bpage[-\s_]?token\b/i, /\bpagination[-\s_]?token\b/i],
      },
      {
        name: 'limit',
        patterns: [/\blimit/i, /\bpage[-\s_]?size\b/i, /\bmax(?:imum)?[-\s_]?(?:results|items)\b/i, /\bclamp/i],
      },
      {
        name: 'nextPage',
        patterns: [/\bnext[-\s_]?page/i, /\bnext[-\s_]?cursor/i, /\bhas[-\s_]?more/i],
      },
    ],
  },
  {
    id: 'C',
    title: 'Fix auth token refresh: dedupe concurrent refreshes and handle expiry',
    requirements: `Fix token refresh in the authentication module.
- getAccessToken() in src/auth.ts currently refreshes separately for every concurrent caller.
- Deduplicate concurrent refreshes: while a refresh is in flight, all callers must await the same promise and receive the same new token.
- Treat a token as expired when Date.now() >= expiresAt - skewMs with skewMs = 30_000, so a token that will expire during the request is refreshed first.
- On refresh success, update the cached token and resolve every waiter. On failure, reject every waiter with the same error, clear the in-flight promise, and allow a later call to retry.
- Never deadlock: clear the in-flight state in a finally block.
- Preserve the public getAccessToken() signature and the existing test setup.
- Add or update tests in src/auth.test.ts for: 10 concurrent callers cause exactly one store.refresh call; an expired token refreshes; a token inside the 30-second skew refreshes; a fresh token does not refresh; a failed refresh clears state and a later attempt succeeds.`,
    repoTree: `repo/
  package.json
  tsconfig.json
  src/
    auth.ts
    auth.test.ts
    token-store.ts
    types.ts`,
    keyFiles: [
      {
        path: 'src/auth.ts',
        content: `import { store } from './token-store.ts'
import type { TokenSet } from './types.ts'

let cached: TokenSet | null = null

export async function getAccessToken(): Promise<string> {
  if (cached !== null && cached.expiresAt > Date.now()) {
    return cached.accessToken
  }
  const refreshed = await store.refresh(cached?.refreshToken ?? '')
  cached = {
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token ?? cached?.refreshToken ?? '',
    expiresAt: Date.now() + refreshed.expires_in * 1000,
  }
  return cached.accessToken
}`,
      },
      {
        path: 'src/auth.test.ts',
        content: `import { expect, mock, test } from 'bun:test'
import { getAccessToken } from './auth.ts'
import { store } from './token-store.ts'

test('concurrent callers share one refresh', async () => {
  // Currently fails: every concurrent getAccessToken() call invokes store.refresh.
  const refresh = mock(async () => ({
    access_token: 'new-token',
    refresh_token: 'new-refresh',
    expires_in: 3600,
  }))
  store.refresh = refresh

  const tokens = await Promise.all(Array.from({ length: 10 }, () => getAccessToken()))

  expect(tokens.every(token => token === 'new-token')).toBe(true)
  expect(refresh).toHaveBeenCalledTimes(1)
})`,
      },
    ],
    requiredFiles: ['src/auth.ts', 'src/auth.test.ts'],
    allowedFiles: [
      'package.json',
      'tsconfig.json',
      'src/auth.ts',
      'src/auth.test.ts',
      'src/token-store.ts',
      'src/types.ts',
    ],
    concepts: [
      {
        name: 'refresh',
        patterns: [/\brefresh/i, /\brenew/i],
      },
      {
        name: 'concurrent',
        patterns: [
          /\bconcurr/i,
          /\bin[-\s_]?flight\b/i,
          /\bdedup/i,
          /\bsingle[-\s_]?flight\b/i,
          /\bshared[-\s]+(?:promise|in[-\s_]?flight)/i,
          /\bmutex\b/i,
        ],
      },
      {
        name: 'expiry',
        patterns: [/\bexpir/i, /\bstale\b/i, /\bttl\b/i, /\bdeadline\b/i],
      },
    ],
  },
  {
    id: 'D',
    title: 'Structured JSON logging with request IDs',
    requirements: `Add structured JSON logging and request IDs to the server.
- Rewrite src/logger.ts so every record is one line of JSON with at least timestamp (ISO 8601), level, message, requestId, and any extra fields merged in. Do not use string concatenation for the record.
- Support debug/info/warn/error levels with a threshold from LOG_LEVEL (default info). Make the output sink injectable for tests; default to stdout.
- In src/request-context.ts, store the current request ID in AsyncLocalStorage. Use the incoming x-request-id header when present, otherwise generate one with crypto.randomUUID().
- In src/server.ts, run each request inside the request context, include the request ID in every log record, return it as the x-request-id response header, and include requestId in error response bodies.
- Add tests in tests/logger.test.ts and tests/server.test.ts for JSON shape / one line per record, level filtering, request ID propagation, honoring an incoming x-request-id, and returning a generated request ID.`,
    repoTree: `repo/
  package.json
  tsconfig.json
  src/
    logger.ts
    request-context.ts
    server.ts
  tests/
    logger.test.ts
    server.test.ts`,
    keyFiles: [
      {
        path: 'src/logger.ts',
        content: `export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export function log(level: LogLevel, message: string, fields: Record<string, unknown> = {}): void {
  console.log('[' + level + '] ' + message, fields)
}`,
      },
      {
        path: 'src/server.ts',
        content: `import { log } from './logger.ts'

export function handleRequest(req: Request): Response {
  log('info', 'request ' + req.method + ' ' + new URL(req.url).pathname)
  return new Response('ok')
}`,
      },
    ],
    requiredFiles: ['src/logger.ts', 'src/server.ts'],
    allowedFiles: [
      'package.json',
      'tsconfig.json',
      'src/logger.ts',
      'src/request-context.ts',
      'src/server.ts',
      'tests/logger.test.ts',
      'tests/server.test.ts',
    ],
    concepts: [
      {
        name: 'JSON',
        patterns: [/\bjson\b/i, /\bstructured[-\s]?log/i, /\bjsonl\b/i],
      },
      {
        name: 'requestId',
        patterns: [/\b(?:request|correlation|trace)[-\s_]?id\b/i],
      },
      {
        name: 'level',
        patterns: [/\blevels?\b/i, /\bseverity\b/i, /\bdebug[-\s_/]+info[-\s_/]+warn/i],
      },
    ],
  },
]

// ---------------------------------------------------------------------------
// Chat client
// ---------------------------------------------------------------------------

interface ChatMessage {
  role: 'system' | 'user'
  content: string
}

interface Usage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
}

interface ChatResult {
  content: string
  finishReason: string
  usage: Usage
  durationMs: number
  attempts: number
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeUsage(raw: unknown): Usage {
  const usage = isRecord(raw) ? raw : {}
  const promptTokens = asNumber(usage.prompt_tokens)
  const completionTokens = asNumber(usage.completion_tokens)
  return {
    promptTokens,
    completionTokens,
    totalTokens: asNumber(usage.total_tokens) || promptTokens + completionTokens,
    cacheHitTokens: asNumber(usage.prompt_cache_hit_tokens),
    cacheMissTokens: asNumber(usage.prompt_cache_miss_tokens),
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function compact(text: string, limit = 500): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, limit)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function chat(
  messages: ChatMessage[],
  options: { taskId: string; phase: 'baseline' | 'candidate' | 'judge'; temperature: number },
): Promise<ChatResult> {
  if (API_KEY === undefined || API_KEY.length === 0) {
    throw new Error('DEEPSEEK_API_KEY is not set')
  }

  const body = JSON.stringify({
    model: MODEL,
    messages,
    temperature: options.temperature,
    max_tokens: MAX_TOKENS,
    response_format: { type: 'json_object' },
  })
  const started = Date.now()
  let lastError: unknown

  for (let attempt = 1; attempt <= RETRIES + 1; attempt++) {
    try {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${API_KEY}`,
        },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      const text = await response.text()
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${compact(text)}`)
      }

      let payload: unknown
      try {
        payload = JSON.parse(text)
      } catch {
        throw new Error(`response is not JSON: ${compact(text, 200)}`)
      }
      if (!isRecord(payload)) throw new Error('response root is not an object')
      const choices = payload.choices
      const choice = Array.isArray(choices) ? choices[0] : undefined
      if (!isRecord(choice)) throw new Error('response is missing choices[0]')
      const message = choice.message
      const content = isRecord(message) ? message.content : undefined
      if (typeof content !== 'string') {
        throw new Error('response is missing choices[0].message.content')
      }

      return {
        content,
        finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : '',
        usage: normalizeUsage(payload.usage),
        durationMs: Date.now() - started,
        attempts: attempt,
      }
    } catch (error) {
      lastError = error
      if (attempt <= RETRIES) {
        const delay = 1000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250)
        console.warn(
          `[retry] task ${options.taskId} ${options.phase} attempt ${attempt}/${RETRIES + 1} failed: `
          + `${compact(errorMessage(error), 300)}; waiting ${delay}ms`,
        )
        await sleep(delay)
      }
    }
  }

  throw new Error(
    `[task ${options.taskId} / ${options.phase}] DeepSeek request failed after ${RETRIES + 1} attempts: `
    + compact(errorMessage(lastError), 600),
  )
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

function buildPlanMessages(task: TaskSpec): ChatMessage[] {
  const lines = [
    `TASK ${task.id}: ${task.title}`,
    '',
    'Repository tree:',
    task.repoTree,
    '',
    'Key file excerpts:',
  ]
  for (const file of task.keyFiles) {
    lines.push(`--- ${file.path} ---`, file.content, '')
  }
  lines.push(
    'Requirements:',
    task.requirements.trim(),
    '',
    'Allowed files (the only paths you may reference or modify):',
    ...task.allowedFiles.map(path => `- ${path}`),
    '',
    `Required files (each must appear in at least one step's files array): ${task.requiredFiles.join(', ')}`,
    '',
    'Output exactly one JSON object with this shape:',
    `{"steps":[{"title":"string","files":["${task.requiredFiles[0]}"],"verification":"string"}],"risks":["string"]}`,
    '',
    'Rules:',
    '- Output JSON only. No markdown, no code fences, no commentary before or after it.',
    '- Every step needs a concrete title, one or more allowed file paths, and a verification string.',
    '- Verification must say how to test or verify the step (mention tests, lint, typecheck, or a concrete command).',
    '- Cover every requirement, including the new tests.',
    '- Reference only paths from the allowed list. Do not invent files.',
  )
  return [
    {
      role: 'system',
      content: 'You are a senior software engineer writing a precise, low-risk implementation plan. '
        + 'You never invent repository files. You return only strict JSON.',
    },
    { role: 'user', content: lines.join('\n') },
  ]
}

function buildJudgeMessages(task: TaskSpec, candidates: PlanSample[]): ChatMessage[] {
  const lines = [
    `TASK ${task.id}: ${task.title}`,
    '',
    'Requirements:',
    task.requirements.trim(),
    '',
    'Repository tree:',
    task.repoTree,
    '',
    `Required files: ${task.requiredFiles.join(', ')}`,
    `Required concepts: ${task.concepts.map(concept => concept.name).join(', ')}`,
    'Allowed files:',
    ...task.allowedFiles.map(path => `- ${path}`),
    '',
    'Rubric (deterministic weights used after the fact; do NOT output scores):',
    '- Required-file coverage (40%): the plan explicitly changes every required file.',
    '- Required-concept coverage (30%): the plan explicitly addresses every required concept.',
    '- Verification (15%): verification fields mention tests, lint, typecheck, or verification and include the requested tests.',
    '- Validity (15%): every referenced path is in the allowed list; invented paths reduce validity in proportion to their number.',
    '- Coherence and feasibility matter as a tie-breaker: ordered steps, edge cases, and risks.',
    '',
    'Candidate plans:',
  ]
  for (const candidate of candidates) {
    lines.push(`[${candidate.index}]`)
    if (candidate.parsed === null) {
      lines.push(`INVALID JSON / SCHEMA ISSUES: ${candidate.schemaIssues.join('; ')}`)
      lines.push(candidate.content.trim())
    } else {
      if (!candidate.schemaValid) {
        lines.push(`SCHEMA ISSUES: ${candidate.schemaIssues.join('; ')}`)
      }
      lines.push(JSON.stringify(candidate.parsed, null, 2))
    }
    lines.push('')
  }
  lines.push(
    'Choose the single best candidate plan for this task and rubric.',
    'Return exactly one JSON object: {"winner":0,"reason":"string"} where winner is 0, 1, or 2.',
    'No markdown, no code fences, no commentary.',
  )
  return [
    {
      role: 'system',
      content: 'You are an independent evaluator of implementation plans. You follow the rubric exactly, '
        + 'compare all candidates, and return only strict JSON.',
    },
    { role: 'user', content: lines.join('\n') },
  ]
}

// ---------------------------------------------------------------------------
// Deterministic parsing and scoring
// ---------------------------------------------------------------------------

interface PlanStep {
  title: string
  files: string[]
  verification: string
}

interface NormalizedPlan {
  steps: PlanStep[]
  risks: string[]
}

interface ParsedPlan {
  plan: NormalizedPlan
  parsed: NormalizedPlan | null
  schemaValid: boolean
  schemaIssues: string[]
}

interface Scoring {
  score: number
  requiredFileCoverage: number
  conceptCoverage: number
  verification: number
  validity: number
  matchedFiles: string[]
  matchedConcepts: string[]
  declaredFiles: string[]
  referencedFiles: string[]
  invalidPaths: string[]
}

interface PlanSample {
  index: number
  temperature: number
  schemaValid: boolean
  parsed: NormalizedPlan | null
  schemaIssues: string[]
  content: string
  finishReason: string
  score: number
  subscores: Scoring
  usage: Usage
  durationMs: number
  attempts: number
}

const NON_FILE_TOKENS = new Set([
  'node.js',
  'next.js',
  'nuxt.js',
  'deno.js',
  'vue.js',
  'react.js',
  'express.js',
  'alpine.js',
  'solid.js',
])

const VERIFICATION_RE
  = /\b(?:tests?|testing|tested|vitest|jest|bun test|lint(?:er|ing)?|typecheck|tsc|verify|verification|verified)\b/i

function pathRegex(): RegExp {
  // Paths with a supported source/config extension, with or without directories.
  return /(?:\.{0,2}\/)?(?:[A-Za-z0-9_@.-]+\/)*[A-Za-z0-9_@.-]+\.(?:ts|tsx|js|mjs|cjs|json|md|yml|yaml|toml)\b/g
}

function normalizePath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/[),.;:`'"\]]+$/g, '')
}

function collectPaths(text: string): string[] {
  const matches = text.replace(/\\/g, '/').match(pathRegex()) ?? []
  const unique = new Set<string>()
  for (const match of matches) {
    const path = normalizePath(match)
    if (path.length === 0 || NON_FILE_TOKENS.has(path.toLowerCase())) continue
    unique.add(path)
  }
  return [...unique]
}

function stripPaths(text: string): string {
  return text.replace(/\\/g, '/').replace(pathRegex(), ' ')
}

function parseJsonObject(content: string): unknown {
  let text = content.trim()
  if (text.startsWith('```')) {
    text = text.replace(/^```[A-Za-z]*\s*/, '').replace(/```\s*$/, '').trim()
  }
  try {
    return JSON.parse(text)
  } catch {
    // Fall through to the embedded-object extraction.
  }
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first !== -1 && last > first) {
    try {
      return JSON.parse(text.slice(first, last + 1))
    } catch {
      // Fall through to the parse error.
    }
  }
  throw new Error('content does not contain a parseable JSON object')
}

function normalizePlan(value: unknown): { plan: NormalizedPlan; schemaValid: boolean; schemaIssues: string[] } {
  const issues: string[] = []
  if (!isRecord(value)) {
    return { plan: { steps: [], risks: [] }, schemaValid: false, schemaIssues: ['root is not an object'] }
  }

  const rawSteps = Array.isArray(value.steps) ? value.steps : []
  if (!Array.isArray(value.steps)) issues.push('steps is not an array')
  if (rawSteps.length === 0) issues.push('steps is empty')

  const steps: PlanStep[] = []
  rawSteps.forEach((raw, index) => {
    if (!isRecord(raw)) {
      issues.push(`steps[${index}] is not an object`)
      return
    }
    const title = typeof raw.title === 'string' ? raw.title.trim() : ''
    const verification = typeof raw.verification === 'string' ? raw.verification.trim() : ''
    let files: string[] = []
    if (!Array.isArray(raw.files)) {
      issues.push(`steps[${index}].files is not an array`)
    } else {
      const rawFiles = raw.files
      if (rawFiles.some(file => typeof file !== 'string')) {
        issues.push(`steps[${index}].files contains a non-string`)
      }
      files = rawFiles
        .filter((file): file is string => typeof file === 'string')
        .map(file => file.trim())
        .filter(file => file.length > 0)
      if (files.length === 0) issues.push(`steps[${index}].files is empty`)
    }
    if (title.length === 0) issues.push(`steps[${index}].title is empty`)
    if (verification.length === 0) issues.push(`steps[${index}].verification is empty`)
    steps.push({ title, files, verification })
  })

  let risks: string[] = []
  if (!Array.isArray(value.risks)) {
    issues.push('risks is not an array')
  } else {
    if (value.risks.some(risk => typeof risk !== 'string')) {
      issues.push('risks contains a non-string')
    }
    risks = value.risks
      .filter((risk): risk is string => typeof risk === 'string')
      .map(risk => risk.trim())
      .filter(risk => risk.length > 0)
  }

  return { plan: { steps, risks }, schemaValid: issues.length === 0, schemaIssues: issues }
}

function parsePlan(content: string): ParsedPlan {
  let value: unknown
  try {
    value = parseJsonObject(content)
  } catch (error) {
    return {
      plan: { steps: [], risks: [] },
      parsed: null,
      schemaValid: false,
      schemaIssues: [`JSON parse failed: ${errorMessage(error)}`],
    }
  }
  const normalized = normalizePlan(value)
  return {
    plan: normalized.plan,
    parsed: normalized.plan,
    schemaValid: normalized.schemaValid,
    schemaIssues: normalized.schemaIssues,
  }
}

function zeroScoring(): Scoring {
  return {
    score: 0,
    requiredFileCoverage: 0,
    conceptCoverage: 0,
    verification: 0,
    validity: 0,
    matchedFiles: [],
    matchedConcepts: [],
    declaredFiles: [],
    referencedFiles: [],
    invalidPaths: [],
  }
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function scorePlan(task: TaskSpec, plan: NormalizedPlan): Scoring {
  const declaredFiles: string[] = []
  const declared = new Set<string>()
  for (const step of plan.steps) {
    for (const entry of step.files) {
      for (const path of collectPaths(entry)) {
        if (!declared.has(path)) {
          declared.add(path)
          declaredFiles.push(path)
        }
      }
    }
  }

  const requiredFiles = task.requiredFiles.map(normalizePath)
  const matchedFiles = requiredFiles.filter(path => declared.has(path))
  const requiredFileCoverage = requiredFiles.length === 0
    ? 0
    : round(matchedFiles.length / requiredFiles.length)

  const conceptText = stripPaths([
    ...plan.steps.map(step => `${step.title}\n${step.verification}`),
    ...plan.risks,
  ].join('\n'))
  const matchedConcepts = task.concepts
    .filter(concept => concept.patterns.some(pattern => pattern.test(conceptText)))
    .map(concept => concept.name)
  const conceptCoverage = task.concepts.length === 0
    ? 0
    : round(matchedConcepts.length / task.concepts.length)

  const verificationText = plan.steps.map(step => step.verification).join('\n')
  const verification = VERIFICATION_RE.test(verificationText) ? 1 : 0

  const referenced = collectPaths([
    ...plan.steps.map(step => `${step.title}\n${step.files.join('\n')}\n${step.verification}`),
    ...plan.risks,
  ].join('\n'))
  const allowed = new Set(task.allowedFiles.map(normalizePath))
  const invalidPaths = referenced.filter(path => !allowed.has(path))
  const validity = referenced.length === 0
    ? 0
    : round((referenced.length - invalidPaths.length) / referenced.length)

  const score = round(
    0.4 * requiredFileCoverage
    + 0.3 * conceptCoverage
    + 0.15 * verification
    + 0.15 * validity,
  )

  return {
    score,
    requiredFileCoverage,
    conceptCoverage,
    verification,
    validity,
    matchedFiles,
    matchedConcepts,
    declaredFiles,
    referencedFiles: referenced,
    invalidPaths,
  }
}

async function runPlanSample(
  task: TaskSpec,
  index: number,
  phase: 'baseline' | 'candidate',
  temperature: number,
): Promise<PlanSample> {
  const result = await chat(buildPlanMessages(task), { taskId: task.id, phase, temperature })
  const parsed = parsePlan(result.content)
  const subscores = parsed.parsed === null ? zeroScoring() : scorePlan(task, parsed.plan)
  return {
    index,
    temperature,
    schemaValid: parsed.schemaValid,
    parsed: parsed.parsed,
    schemaIssues: parsed.schemaIssues,
    content: result.content,
    finishReason: result.finishReason,
    score: parsed.parsed === null ? 0 : subscores.score,
    subscores,
    usage: result.usage,
    durationMs: result.durationMs,
    attempts: result.attempts,
  }
}

interface JudgeRecord {
  winner: number | null
  reason: string
  valid: boolean
  issues: string[]
  selectedScore: number
  pickedOracleBest: boolean
  oracleTopIndices: number[]
  temperature: number
  content: string
  finishReason: string
  usage: Usage
  durationMs: number
  attempts: number
}

async function runJudge(task: TaskSpec, candidates: PlanSample[]): Promise<JudgeRecord> {
  const result = await chat(buildJudgeMessages(task, candidates), {
    taskId: task.id,
    phase: 'judge',
    temperature: JUDGE_TEMPERATURE,
  })
  const issues: string[] = []
  let winner: number | null = null
  let reason = ''
  try {
    const value = parseJsonObject(result.content)
    if (!isRecord(value)) throw new Error('judge output is not an object')
    const rawWinner = value.winner
    if (
      typeof rawWinner !== 'number'
      || !Number.isInteger(rawWinner)
      || rawWinner < 0
      || rawWinner >= candidates.length
    ) {
      throw new Error(`judge winner must be an integer in 0..${candidates.length - 1}`)
    }
    winner = rawWinner
    if (typeof value.reason === 'string') reason = value.reason.trim()
    else issues.push('judge reason is missing or not a string')
  } catch (error) {
    issues.push(errorMessage(error))
  }

  const valid = winner !== null
  const topScore = Math.max(...candidates.map(candidate => candidate.score))
  const oracleTopIndices = candidates
    .filter(candidate => candidate.score === topScore)
    .map(candidate => candidate.index)
  const pickedOracleBest = valid && oracleTopIndices.includes(winner as number)
  // An invalid judge response cannot select a plan: count it as a 0-score
  // selection and a top-1 miss. This is recorded explicitly and penalized.
  const selectedScore = valid ? candidates[winner as number].score : 0

  return {
    winner,
    reason,
    valid,
    issues,
    selectedScore,
    pickedOracleBest,
    oracleTopIndices,
    temperature: JUDGE_TEMPERATURE,
    content: result.content,
    finishReason: result.finishReason,
    usage: result.usage,
    durationMs: result.durationMs,
    attempts: result.attempts,
  }
}

// ---------------------------------------------------------------------------
// Experiment aggregation
// ---------------------------------------------------------------------------

interface ExperimentTaskResult {
  id: string
  title: string
  taskSpec: {
    requirements: string
    repoTree: string
    keyFiles: KeyFile[]
    requiredFiles: string[]
    allowedFiles: string[]
    concepts: Array<{ name: string; patterns: string[] }>
  }
  baseline: {
    samples: PlanSample[]
    avgScore: number
    maxScore: number
    calls: number
    apiAttempts: number
    tokens: Usage
    wallMs: number
  }
  treatment: {
    candidates: PlanSample[]
    oracleBest: {
      index: number
      score: number
      tiedIndices: number[]
    }
    judge: JudgeRecord
    calls: number
    apiAttempts: number
    tokens: Usage
    wallMs: number
  }
  judgeGain: number
  oracleGain: number
  tokenMultiplier: number | null
}

function sumUsage(items: Array<{ usage: Usage }>): Usage {
  return items.reduce<Usage>((total, item) => ({
    promptTokens: total.promptTokens + item.usage.promptTokens,
    completionTokens: total.completionTokens + item.usage.completionTokens,
    totalTokens: total.totalTokens + item.usage.totalTokens,
    cacheHitTokens: total.cacheHitTokens + item.usage.cacheHitTokens,
    cacheMissTokens: total.cacheMissTokens + item.usage.cacheMissTokens,
  }), {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
  })
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

async function runTask(task: TaskSpec): Promise<ExperimentTaskResult> {
  console.log(`[task ${task.id}] baseline: 2 samples at temperature ${BASELINE_TEMPERATURE}`)
  const baselineStarted = Date.now()
  const baselineSamples = await Promise.all(
    Array.from({ length: 2 }, (_, index) =>
      runPlanSample(task, index, 'baseline', BASELINE_TEMPERATURE)),
  )
  const baselineWallMs = Date.now() - baselineStarted
  const baselineTokens = sumUsage(baselineSamples)

  console.log(`[task ${task.id}] treatment: 3 candidates at temperature ${CANDIDATE_TEMPERATURE}`)
  const treatmentStarted = Date.now()
  const candidates = await Promise.all(
    Array.from({ length: 3 }, (_, index) =>
      runPlanSample(task, index, 'candidate', CANDIDATE_TEMPERATURE)),
  )

  const oracleScore = Math.max(...candidates.map(candidate => candidate.score))
  const tiedIndices = candidates
    .filter(candidate => candidate.score === oracleScore)
    .map(candidate => candidate.index)
  const oracleBest = {
    index: tiedIndices[0],
    score: oracleScore,
    tiedIndices,
  }

  console.log(`[task ${task.id}] judge: choosing one of 3 candidates at temperature ${JUDGE_TEMPERATURE}`)
  const judge = await runJudge(task, candidates)
  const treatmentWallMs = Date.now() - treatmentStarted
  const treatmentTokens = sumUsage([...candidates, judge])

  const baselineAvg = round(mean(baselineSamples.map(sample => sample.score)))
  const tokenMultiplier = baselineTokens.totalTokens > 0
    ? round(treatmentTokens.totalTokens / baselineTokens.totalTokens)
    : null

  return {
    id: task.id,
    title: task.title,
    taskSpec: {
      requirements: task.requirements.trim(),
      repoTree: task.repoTree,
      keyFiles: task.keyFiles,
      requiredFiles: task.requiredFiles,
      allowedFiles: task.allowedFiles,
      concepts: task.concepts.map(concept => ({
        name: concept.name,
        patterns: concept.patterns.map(pattern => pattern.source),
      })),
    },
    baseline: {
      samples: baselineSamples,
      avgScore: baselineAvg,
      maxScore: Math.max(...baselineSamples.map(sample => sample.score)),
      calls: baselineSamples.length,
      apiAttempts: baselineSamples.reduce((sum, sample) => sum + sample.attempts, 0),
      tokens: baselineTokens,
      wallMs: baselineWallMs,
    },
    treatment: {
      candidates,
      oracleBest,
      judge,
      calls: candidates.length + 1,
      apiAttempts: candidates.reduce((sum, sample) => sum + sample.attempts, 0) + judge.attempts,
      tokens: treatmentTokens,
      wallMs: treatmentWallMs,
    },
    judgeGain: round(judge.selectedScore - baselineAvg),
    oracleGain: round(oracleBest.score - baselineAvg),
    tokenMultiplier,
  }
}

interface ExperimentResult {
  experiment: string
  status: 'ok'
  generatedAt: string
  startedAt: string
  finishedAt: string
  durationMs: number
  model: string
  endpoint: string
  design: Record<string, unknown>
  tasks: ExperimentTaskResult[]
  summary: {
    taskCount: number
    baselineAvg: number
    baselineMaxAvg: number
    judgeAvg: number
    oracleAvg: number
    judgeTop1Accuracy: number
    tokenMultiplier: number | null
    judgeGain: number
    oracleGain: number
    totalLogicalCalls: number
    totalApiAttempts: number
    totalTokens: Usage
    wallMs: number
  }
  decision: 'add-opt-in' | 'do-not-add'
  decisionRule: string
  decisionChecks: {
    judgeGainAtLeast010: boolean
    judgeTop1AtLeast075: boolean
    tokenMultiplierBelow3: boolean
  }
  decisionNotes: string[]
}

function buildResult(tasks: ExperimentTaskResult[], startedAt: Date, started: number): ExperimentResult {
  const baselineAvg = round(mean(tasks.map(task => task.baseline.avgScore)))
  const baselineMaxAvg = round(mean(tasks.map(task => task.baseline.maxScore)))
  const judgeAvg = round(mean(tasks.map(task => task.treatment.judge.selectedScore)))
  const oracleAvg = round(mean(tasks.map(task => task.treatment.oracleBest.score)))
  const judgeTop1Accuracy = round(
    tasks.filter(task => task.treatment.judge.pickedOracleBest).length / tasks.length,
  )
  const baselineTokens = tasks.reduce((sum, task) => sum + task.baseline.tokens.totalTokens, 0)
  const treatmentTokens = tasks.reduce((sum, task) => sum + task.treatment.tokens.totalTokens, 0)
  const tokenMultiplier = baselineTokens > 0 ? round(treatmentTokens / baselineTokens) : null
  const judgeGain = round(judgeAvg - baselineAvg)
  const oracleGain = round(oracleAvg - baselineAvg)
  const totalApiAttempts = tasks.reduce(
    (sum, task) => sum + task.baseline.apiAttempts + task.treatment.apiAttempts,
    0,
  )
  const totalLogicalCalls = tasks.reduce(
    (sum, task) => sum + task.baseline.calls + task.treatment.calls,
    0,
  )
  const totalTokens: Usage = {
    promptTokens: tasks.reduce((sum, task) => sum + task.baseline.tokens.promptTokens + task.treatment.tokens.promptTokens, 0),
    completionTokens: tasks.reduce((sum, task) => sum + task.baseline.tokens.completionTokens + task.treatment.tokens.completionTokens, 0),
    totalTokens: baselineTokens + treatmentTokens,
    cacheHitTokens: tasks.reduce((sum, task) => sum + task.baseline.tokens.cacheHitTokens + task.treatment.tokens.cacheHitTokens, 0),
    cacheMissTokens: tasks.reduce((sum, task) => sum + task.baseline.tokens.cacheMissTokens + task.treatment.tokens.cacheMissTokens, 0),
  }

  const decisionChecks = {
    judgeGainAtLeast010: judgeGain >= 0.1,
    judgeTop1AtLeast075: judgeTop1Accuracy >= 0.75,
    tokenMultiplierBelow3: tokenMultiplier !== null && tokenMultiplier < 3,
  }
  const decision = Object.values(decisionChecks).every(Boolean) ? 'add-opt-in' : 'do-not-add'

  const decisionNotes: string[] = []
  if (!decisionChecks.judgeGainAtLeast010) {
    decisionNotes.push(`judgeAvg - baselineAvg = ${judgeGain.toFixed(4)}, below the 0.10 threshold`)
  }
  if (!decisionChecks.judgeTop1AtLeast075) {
    decisionNotes.push(
      `judge top-1 accuracy = ${(judgeTop1Accuracy * 100).toFixed(1)}%, below the 75% reliability threshold`,
    )
  }
  if (!decisionChecks.tokenMultiplierBelow3) {
    decisionNotes.push(
      `tokenMultiplier = ${tokenMultiplier === null ? 'unavailable' : tokenMultiplier.toFixed(4)}, not below 3`,
    )
  }
  if (oracleGain < 0.1) {
    decisionNotes.push(
      `oracle headroom is only ${oracleGain.toFixed(4)}; even a perfect judge could not reach +0.10`,
    )
  }
  if (tasks.some(task => !task.treatment.judge.valid)) {
    decisionNotes.push('at least one judge response was invalid; it was scored 0 and counted as a top-1 miss')
  }

  return {
    experiment: EXPERIMENT,
    status: 'ok',
    generatedAt: new Date().toISOString(),
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    model: MODEL,
    endpoint: ENDPOINT,
    design: {
      tasks: TASKS.map(task => task.id),
      baselineSamplesPerTask: 2,
      baselineTemperature: BASELINE_TEMPERATURE,
      candidatesPerTask: 3,
      candidateTemperature: CANDIDATE_TEMPERATURE,
      judgeTemperature: JUDGE_TEMPERATURE,
      maxTokens: MAX_TOKENS,
      responseFormat: 'json_object',
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      retriesOnFailure: RETRIES,
      scoring: {
        formula: '0.40 * requiredFileCoverage + 0.30 * requiredConceptCoverage + 0.15 * verification + 0.15 * validity',
        requiredFileCoverage: 'fraction of requiredFiles present in any step files array (normalized paths)',
        requiredConceptCoverage: 'fraction of concept groups with at least one keyword pattern hit in step titles, verification, or risks; file paths are stripped first',
        verification: '1 if any verification field mentions test/tests/lint/typecheck/verify, otherwise 0',
        validity: 'fraction of unique file paths referenced anywhere in the plan that are in allowedFiles; 0 if no paths are referenced',
        judgeFailurePenalty: 'an unparsable judge response scores 0 for the task and counts as a top-1 miss',
        tieRule: 'any candidate tied for the highest deterministic score counts as oracle top-1',
      },
      decisionThresholds: {
        judgeGainAtLeast: 0.1,
        judgeTop1AccuracyAtLeast: 0.75,
        tokenMultiplierBelow: 3,
      },
    },
    tasks,
    summary: {
      taskCount: tasks.length,
      baselineAvg,
      baselineMaxAvg,
      judgeAvg,
      oracleAvg,
      judgeTop1Accuracy,
      tokenMultiplier,
      judgeGain,
      oracleGain,
      totalLogicalCalls,
      totalApiAttempts,
      totalTokens,
      wallMs: Date.now() - started,
    },
    decision,
    decisionRule: DECISION_RULE,
    decisionChecks,
    decisionNotes,
  }
}

// ---------------------------------------------------------------------------
// Output and failure handling
// ---------------------------------------------------------------------------

function resultsPath(): string {
  return join(import.meta.dir, 'results', `${EXPERIMENT}.json`)
}

function writeResult(value: unknown): void {
  const dir = join(import.meta.dir, 'results')
  mkdirSync(dir, { recursive: true })
  writeFileSync(resultsPath(), `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function printTaskLine(task: ExperimentTaskResult): void {
  const judgeLabel = task.treatment.judge.valid
    ? task.treatment.judge.selectedScore.toFixed(4)
    : 'invalid(0)'
  console.log(
    `[task ${task.id}] baseline avg ${task.baseline.avgScore.toFixed(4)} `
    + `(max ${task.baseline.maxScore.toFixed(4)}) | oracle ${task.treatment.oracleBest.score.toFixed(4)} `
    + `| judge ${judgeLabel} | oracleTop1 ${task.treatment.judge.pickedOracleBest ? 'yes' : 'no'} `
    + `| tokens ${task.baseline.tokens.totalTokens}/${task.treatment.tokens.totalTokens} `
    + `| ${(task.baseline.wallMs + task.treatment.wallMs) / 1000}s`,
  )
}

function printSummary(result: ExperimentResult): void {
  console.log('')
  console.log(`Best-of-N plan quality benchmark (${result.model})`)
  console.log('task  baseAvg  baseMax  oracle   judge    judgeΔ   oracleΔ  top1  tokBase  tokTreat  multiplier')
  for (const task of result.tasks) {
    console.log(
      `${task.id.padEnd(4)}  ${task.baseline.avgScore.toFixed(4)}   `
      + `${task.baseline.maxScore.toFixed(4)}   `
      + `${task.treatment.oracleBest.score.toFixed(4)}   `
      + `${task.treatment.judge.selectedScore.toFixed(4)}   `
      + `${task.judgeGain.toFixed(4).padStart(7)}  `
      + `${task.oracleGain.toFixed(4).padStart(7)}  `
      + `${task.treatment.judge.pickedOracleBest ? 'yes ' : 'no  '}  `
      + `${String(task.baseline.tokens.totalTokens).padStart(7)}  `
      + `${String(task.treatment.tokens.totalTokens).padStart(8)}  `
      + `${task.tokenMultiplier === null ? 'n/a' : task.tokenMultiplier.toFixed(4)}`,
    )
  }
  console.log('')
  console.log(`baselineAvg        ${result.summary.baselineAvg.toFixed(4)}`)
  console.log(`baselineMaxAvg     ${result.summary.baselineMaxAvg.toFixed(4)}`)
  console.log(`oracleAvg          ${result.summary.oracleAvg.toFixed(4)}`)
  console.log(`judgeAvg           ${result.summary.judgeAvg.toFixed(4)}`)
  console.log(`judgeTop1Accuracy  ${formatPercent(result.summary.judgeTop1Accuracy)}`)
  console.log(`tokenMultiplier    ${result.summary.tokenMultiplier === null ? 'n/a' : result.summary.tokenMultiplier.toFixed(4)}`)
  console.log(`calls              ${result.summary.totalLogicalCalls} logical, ${result.summary.totalApiAttempts} API attempts`)
  console.log(`tokens             ${result.summary.totalTokens.totalTokens}`)
  console.log(`wall time          ${(result.summary.wallMs / 1000).toFixed(1)}s`)
  console.log(`decision           ${result.decision}`)
  console.log(`rule               ${result.decisionRule}`)
  if (result.decisionNotes.length > 0) {
    console.log('notes')
    for (const note of result.decisionNotes) console.log(`- ${note}`)
  }
  console.log(`wrote ${resultsPath()}`)
}

async function main(): Promise<void> {
  const startedAt = new Date()
  const started = Date.now()

  if (API_KEY === undefined || API_KEY.length === 0) {
    const failure = {
      experiment: EXPERIMENT,
      status: 'failed',
      generatedAt: new Date().toISOString(),
      model: MODEL,
      endpoint: ENDPOINT,
      error: {
        message: 'DEEPSEEK_API_KEY is not set; no API calls were made',
        phase: 'preflight',
        taskId: null,
        completedTaskIds: [],
      },
      durationMs: Date.now() - started,
    }
    writeResult(failure)
    console.error('FAILED: DEEPSEEK_API_KEY is not set. Wrote a failure record; no results were fabricated.')
    process.exitCode = 1
    return
  }

  const tasks: ExperimentTaskResult[] = []
  try {
    for (const task of TASKS) {
      console.log('')
      console.log(`[task ${task.id}] ${task.title}`)
      const result = await runTask(task)
      tasks.push(result)
      printTaskLine(result)
    }

    const result = buildResult(tasks, startedAt, started)
    writeResult(result)
    printSummary(result)
  } catch (error) {
    const failure = {
      experiment: EXPERIMENT,
      status: 'failed',
      generatedAt: new Date().toISOString(),
      model: MODEL,
      endpoint: ENDPOINT,
      error: {
        message: errorMessage(error),
        phase: 'run',
        taskId: tasks.length < TASKS.length ? TASKS[tasks.length].id : null,
        completedTaskIds: tasks.map(task => task.id),
      },
      durationMs: Date.now() - started,
    }
    writeResult(failure)
    console.error(`FAILED: ${errorMessage(error)}`)
    console.error('Wrote a failure record; no results were fabricated.')
    process.exitCode = 1
  }
}

await main()
