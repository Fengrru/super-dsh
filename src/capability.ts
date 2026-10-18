/**
 * Short-lived HMAC-SHA256 capability tokens for external workers and tools.
 *
 * Tokens are deliberately bypassable only by the holder of `secret`; they are
 * not a replacement for dsh approval or sandboxing. Scope strings are either
 * exact (`tool:bash`, `llm:*`) or path-scoped (`fs:read:<path>` /
 * `fs:write:<path>`). Path checks resolve both sides with `path.resolve`,
 * canonicalize existing paths with `realpathSync.native` (so symlinks cannot
 * escape a grant), and compare on separator boundaries so `/project/src2`
 * never matches a `/project/src` grant.
 *
 * Format: base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload part)).
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export const DEFAULT_CAPABILITY_TTL_MS = 5 * 60 * 1000

export interface CapabilityPayload {
  v: 1
  scopes: string[]
  session?: string
  task?: string
  iat: number
  exp: number
}

export type CapabilityFailureReason =
  | 'malformed'
  | 'unsupported-version'
  | 'bad-signature'
  | 'expired'

export type CapabilityVerification =
  | { ok: true; payload: CapabilityPayload }
  | { ok: false; reason: CapabilityFailureReason }

export interface IssueCapabilityOptions {
  secret: string
  scopes: readonly string[]
  sessionId?: string
  taskId?: string
  /** Lifetime in milliseconds from `now`. Default: 5 minutes. */
  ttlMs?: number
  /** Issue time in epoch milliseconds. Default: Date.now(). */
  now?: number
}

export interface CapabilityRequest {
  scope: string
  path?: string
}

const BASE64URL = /^[A-Za-z0-9_-]+$/
const PATH_SCOPES = ['fs:read', 'fs:write'] as const

export function issueCapability(options: IssueCapabilityOptions): string {
  const secret = assertSecret(options.secret)
  const scopes = assertScopes(options.scopes)
  const now = options.now ?? Date.now()
  const issuedAt = assertTimestamp(now, 'now')
  const ttlMs = options.ttlMs ?? DEFAULT_CAPABILITY_TTL_MS
  if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs < 0) {
    throw new TypeError('issueCapability: ttlMs must be a non-negative finite number')
  }
  const expiresAt = issuedAt + Math.floor(ttlMs)
  if (!Number.isSafeInteger(expiresAt)) {
    throw new RangeError('issueCapability: ttlMs overflows the supported timestamp range')
  }

  const payload: CapabilityPayload = {
    v: 1,
    scopes,
    ...(options.sessionId === undefined ? {} : { session: assertLabel(options.sessionId, 'sessionId') }),
    ...(options.taskId === undefined ? {} : { task: assertLabel(options.taskId, 'taskId') }),
    iat: issuedAt,
    exp: expiresAt,
  }
  const encodedPayload = encodePart(JSON.stringify(payload))
  return `${encodedPayload}.${sign(encodedPayload, secret)}`
}

export function verifyCapability(
  token: string,
  secret: string,
  now: number = Date.now(),
): CapabilityVerification {
  const key = assertSecret(secret)
  const currentTime = assertTimestamp(now, 'now')
  if (typeof token !== 'string') return { ok: false, reason: 'malformed' }

  const parts = token.split('.')
  if (parts.length !== 2) return { ok: false, reason: 'malformed' }
  const [encodedPayload, encodedSignature] = parts
  if (
    encodedPayload === undefined
    || encodedSignature === undefined
    || !BASE64URL.test(encodedPayload)
    || !BASE64URL.test(encodedSignature)
  ) {
    return { ok: false, reason: 'malformed' }
  }

  // Verify before parsing so tampering is reported as a signature failure and
  // unauthenticated payloads never drive control flow.
  const expected = Buffer.from(sign(encodedPayload, key), 'base64url')
  const actual = Buffer.from(encodedSignature, 'base64url')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return { ok: false, reason: 'bad-signature' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'))
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  const record = asRecord(parsed)
  if (record === undefined) return { ok: false, reason: 'malformed' }
  if (record.v !== 1) {
    return {
      ok: false,
      reason: typeof record.v === 'number' ? 'unsupported-version' : 'malformed',
    }
  }

  const payload = capabilityPayloadOf(record)
  if (payload === undefined) return { ok: false, reason: 'malformed' }
  if (currentTime >= payload.exp) return { ok: false, reason: 'expired' }
  return { ok: true, payload }
}

/**
 * Check a payload against a request without re-verifying its signature.
 * Callers must verify the token first; this function only evaluates scopes.
 */
export function capabilityPermits(payload: CapabilityPayload, request: CapabilityRequest): boolean {
  if (payload === null || typeof payload !== 'object' || !Array.isArray(payload.scopes)) return false
  if (request === null || typeof request !== 'object') return false
  const scope = request.scope
  if (typeof scope !== 'string' || scope.length === 0) return false
  if (request.path !== undefined && (typeof request.path !== 'string' || request.path.length === 0)) {
    return false
  }

  const requestPathScope = splitPathScope(scope)
  const requestBase = requestPathScope?.base ?? scope
  const requestTarget = request.path ?? requestPathScope?.path
  const canonicalRequest = requestTarget === undefined ? undefined : canonicalPath(requestTarget)

  for (const granted of payload.scopes) {
    if (typeof granted !== 'string' || granted.length === 0) continue

    if (granted === scope) {
      const grantedPathScope = splitPathScope(granted)
      if (grantedPathScope === undefined) return true
      if (canonicalRequest === undefined) return true
      if (isWithin(canonicalPath(grantedPathScope.path), canonicalRequest)) return true
      continue
    }

    const grantedPathScope = splitPathScope(granted)
    if (grantedPathScope === undefined) {
      // A broad base grant (for example `fs:read`) covers a path-scoped request.
      if (granted === requestBase) return true
      continue
    }
    if (grantedPathScope.base !== requestBase || canonicalRequest === undefined) continue
    if (isWithin(canonicalPath(grantedPathScope.path), canonicalRequest)) return true
  }

  return false
}

function capabilityPayloadOf(record: Record<string, unknown>): CapabilityPayload | undefined {
  if (!Array.isArray(record.scopes)) return undefined
  const scopes: string[] = []
  for (const scope of record.scopes) {
    if (typeof scope !== 'string' || scope.length === 0) return undefined
    scopes.push(scope)
  }
  if (!Number.isSafeInteger(record.iat) || !Number.isSafeInteger(record.exp)) return undefined
  const iat = record.iat as number
  const exp = record.exp as number
  if (iat < 0 || exp < iat) return undefined
  if (record.session !== undefined && (typeof record.session !== 'string' || record.session.length === 0)) {
    return undefined
  }
  if (record.task !== undefined && (typeof record.task !== 'string' || record.task.length === 0)) {
    return undefined
  }

  return {
    v: 1,
    scopes,
    ...(record.session === undefined ? {} : { session: record.session as string }),
    ...(record.task === undefined ? {} : { task: record.task as string }),
    iat,
    exp,
  }
}

function splitPathScope(scope: string): { base: string; path: string } | undefined {
  for (const base of PATH_SCOPES) {
    const prefix = `${base}:`
    if (!scope.startsWith(prefix)) continue
    const path = scope.slice(prefix.length)
    return path.length === 0 ? undefined : { base, path }
  }
  return undefined
}

function canonicalPath(path: string): string {
  const absolute = resolve(path)
  try {
    return realpathSync.native(absolute)
  } catch {
    return absolute
  }
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === ''
    || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function sign(encodedPayload: string, secret: string): string {
  return createHmac('sha256', secret).update(encodedPayload).digest('base64url')
}

function encodePart(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url')
}

function assertSecret(secret: string): string {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new TypeError('capability: secret must be a non-empty string')
  }
  return secret
}

function assertScopes(scopes: readonly string[]): string[] {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new TypeError('issueCapability: scopes must be a non-empty array of strings')
  }
  const unique: string[] = []
  const seen = new Set<string>()
  for (const scope of scopes) {
    if (typeof scope !== 'string' || scope.length === 0) {
      throw new TypeError('issueCapability: every scope must be a non-empty string')
    }
    if (seen.has(scope)) continue
    seen.add(scope)
    unique.push(scope)
  }
  return unique
}

function assertLabel(value: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`issueCapability: ${field} must be a non-empty string`)
  }
  return value
}

function assertTimestamp(value: number, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`capability: ${field} must be a non-negative finite number`)
  }
  const floored = Math.floor(value)
  if (!Number.isSafeInteger(floored)) {
    throw new RangeError(`capability: ${field} is outside the supported timestamp range`)
  }
  return floored
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
