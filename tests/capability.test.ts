/**
 * HMAC capability token tests. No network, no model calls. The only real
 * filesystem work is a temporary directory used to prove symlink/resolve
 * behavior.
 *
 * Run: bun test tests/capability.test.ts
 */

import { describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  capabilityPermits,
  issueCapability,
  verifyCapability,
  type CapabilityPayload,
  type IssueCapabilityOptions,
} from '../src/capability.ts'

const SECRET = 'super-dsh-test-secret-32-bytes-long!'
const NOW = 1_700_000_000_000

function issue(scopes: string[], overrides: Partial<IssueCapabilityOptions> = {}): string {
  return issueCapability({
    secret: SECRET,
    scopes,
    now: NOW,
    ttlMs: 60_000,
    ...overrides,
  })
}

function payloadOf(token: string): CapabilityPayload {
  const verified = verifyCapability(token, SECRET, NOW)
  expect(verified.ok).toBe(true)
  if (!verified.ok) throw new Error('expected a valid capability')
  return verified.payload
}

function signedToken(payload: Record<string, unknown>, secret = SECRET): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url')
  return `${encoded}.${signature}`
}

function symlinkType(): 'junction' | 'dir' {
  return process.platform === 'win32' ? 'junction' : 'dir'
}

describe('issueCapability / verifyCapability', () => {
  test('issues a verifiable token with the required payload shape', () => {
    const token = issueCapability({
      secret: SECRET,
      scopes: ['fs:read:/project/src', 'tool:bash', 'fs:read:/project/src'],
      sessionId: 'session-1',
      taskId: 'task-1',
      ttlMs: 30_000,
      now: NOW,
    })

    expect(token.split('.')).toHaveLength(2)
    const verified = verifyCapability(token, SECRET, NOW + 1)
    expect(verified).toEqual({
      ok: true,
      payload: {
        v: 1,
        scopes: ['fs:read:/project/src', 'tool:bash'],
        session: 'session-1',
        task: 'task-1',
        iat: NOW,
        exp: NOW + 30_000,
      },
    })
  })

  test('rejects expired tokens on the exact expiry boundary', () => {
    const token = issueCapability({ secret: SECRET, scopes: ['tool:bash'], ttlMs: 1_000, now: NOW })

    expect(verifyCapability(token, SECRET, NOW + 999)).toMatchObject({ ok: true })
    expect(verifyCapability(token, SECRET, NOW + 1_000)).toEqual({ ok: false, reason: 'expired' })
    expect(verifyCapability(token, SECRET, NOW + 5_000)).toEqual({ ok: false, reason: 'expired' })
  })

  test('rejects tampered payloads and signatures', () => {
    const token = issue(['tool:bash'])
    const [encodedPayload, signature] = token.split('.') as [string, string]
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'))
    payload.scopes = ['tool:write']
    const tamperedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')

    expect(verifyCapability(`${tamperedPayload}.${signature}`, SECRET, NOW))
      .toEqual({ ok: false, reason: 'bad-signature' })

    const flipped = signature.startsWith('A') ? `B${signature.slice(1)}` : `A${signature.slice(1)}`
    expect(verifyCapability(`${encodedPayload}.${flipped}`, SECRET, NOW))
      .toEqual({ ok: false, reason: 'bad-signature' })
  })

  test('rejects the wrong secret and malformed tokens', () => {
    const token = issue(['tool:bash'])

    expect(verifyCapability(token, 'another-secret', NOW)).toEqual({ ok: false, reason: 'bad-signature' })
    expect(verifyCapability('', SECRET, NOW)).toEqual({ ok: false, reason: 'malformed' })
    expect(verifyCapability('not-a-token', SECRET, NOW)).toEqual({ ok: false, reason: 'malformed' })
    expect(verifyCapability('a.b.c', SECRET, NOW)).toEqual({ ok: false, reason: 'malformed' })
    expect(verifyCapability('!!!.???', SECRET, NOW)).toEqual({ ok: false, reason: 'malformed' })
    expect(verifyCapability('.', SECRET, NOW)).toEqual({ ok: false, reason: 'malformed' })
    // Structurally base64url but cryptographically invalid.
    expect(verifyCapability('a.b', SECRET, NOW)).toEqual({ ok: false, reason: 'bad-signature' })
  })

  test('rejects an unsupported signed version', () => {
    const token = signedToken({
      v: 2,
      scopes: ['tool:bash'],
      iat: NOW,
      exp: NOW + 60_000,
    })

    expect(verifyCapability(token, SECRET, NOW)).toEqual({ ok: false, reason: 'unsupported-version' })

    const missingVersion = signedToken({ scopes: ['tool:bash'], iat: NOW, exp: NOW + 60_000 })
    expect(verifyCapability(missingVersion, SECRET, NOW)).toEqual({ ok: false, reason: 'malformed' })
  })

  test('validates issue input', () => {
    expect(() => issueCapability({ secret: '', scopes: ['tool:bash'], now: NOW }))
      .toThrow(/secret/)
    expect(() => issueCapability({ secret: SECRET, scopes: [], now: NOW }))
      .toThrow(/scopes/)
    expect(() => issueCapability({ secret: SECRET, scopes: ['tool:bash'], now: NOW, ttlMs: -1 }))
      .toThrow(/ttlMs/)
  })
})

describe('capabilityPermits', () => {
  test('matches exact non-path scopes and rejects other scopes', () => {
    const payload = payloadOf(issue(['tool:bash', 'llm:*']))

    expect(capabilityPermits(payload, { scope: 'tool:bash' })).toBe(true)
    expect(capabilityPermits(payload, { scope: 'tool:write' })).toBe(false)
    expect(capabilityPermits(payload, { scope: 'llm:*' })).toBe(true)
    expect(capabilityPermits(payload, { scope: 'llm:other' })).toBe(false)
  })

  test('enforces path boundaries instead of prefix matching', () => {
    const payload = payloadOf(issue(['fs:read:/project/src']))

    expect(capabilityPermits(payload, { scope: 'fs:read', path: '/project/src' })).toBe(true)
    expect(capabilityPermits(payload, { scope: 'fs:read', path: '/project/src/app.ts' })).toBe(true)
    expect(capabilityPermits(payload, { scope: 'fs:read', path: '/project/src2' })).toBe(false)
    expect(capabilityPermits(payload, { scope: 'fs:read', path: '/project/src2/app.ts' })).toBe(false)
    expect(capabilityPermits(payload, { scope: 'fs:read', path: '/project/src-other/app.ts' })).toBe(false)
    expect(capabilityPermits(payload, { scope: 'fs:read', path: '/project/src/../src2/app.ts' })).toBe(false)
    expect(capabilityPermits(payload, { scope: 'fs:write', path: '/project/src/app.ts' })).toBe(false)

    // A path-scoped grant does not imply a broad capability when no path is given.
    expect(capabilityPermits(payload, { scope: 'fs:read' })).toBe(false)
  })

  test('supports relative paths and broad base scopes', () => {
    const relative = payloadOf(issue(['fs:read:src']))
    expect(capabilityPermits(relative, { scope: 'fs:read', path: 'src/app.ts' })).toBe(true)
    expect(capabilityPermits(relative, { scope: 'fs:read', path: 'src2/app.ts' })).toBe(false)
    expect(capabilityPermits(relative, {
      scope: 'fs:read',
      path: join(process.cwd(), 'src', 'app.ts'),
    })).toBe(true)

    const broad = payloadOf(issue(['fs:read']))
    expect(capabilityPermits(broad, { scope: 'fs:read' })).toBe(true)
    expect(capabilityPermits(broad, { scope: 'fs:read', path: '/anywhere/at/all.ts' })).toBe(true)
    expect(capabilityPermits(broad, { scope: 'fs:write', path: '/anywhere/at/all.ts' })).toBe(false)
  })

  test('handles a path-scoped request scope without a separate path', () => {
    const payload = payloadOf(issue(['fs:read:/project/src']))

    expect(capabilityPermits(payload, { scope: 'fs:read:/project/src/file.ts' })).toBe(true)
    expect(capabilityPermits(payload, { scope: 'fs:read:/project/src2/file.ts' })).toBe(false)
    expect(capabilityPermits(payload, { scope: 'fs:read:/project/src' })).toBe(true)
  })

  test('rejects malformed requests', () => {
    const payload = payloadOf(issue(['fs:read:/project/src']))
    expect(capabilityPermits(payload, { scope: '' })).toBe(false)
    expect(capabilityPermits(payload, { scope: 'fs:read', path: '' })).toBe(false)
    expect(capabilityPermits(payload, { scope: 'fs:read', path: 42 as unknown as string })).toBe(false)
  })

  test('resolves symlinks so a granted directory cannot be escaped or bypassed', () => {
    const root = mkdtempSync(join(tmpdir(), 'super-dsh-cap-'))
    try {
      mkdirSync(join(root, 'src'), { recursive: true })
      mkdirSync(join(root, 'outside'), { recursive: true })
      writeFileSync(join(root, 'src', 'inside.txt'), 'inside')
      writeFileSync(join(root, 'outside', 'secret.txt'), 'secret')

      // A link inside the grant points outside: realpath must deny it.
      symlinkSync(join(root, 'outside'), join(root, 'src', 'escape'), symlinkType())
      // A link outside the grant points inside: realpath must allow it.
      symlinkSync(join(root, 'src'), join(root, 'link-to-src'), symlinkType())

      const payload = payloadOf(issue([`fs:read:${resolve(root, 'src')}`]))

      expect(capabilityPermits(payload, {
        scope: 'fs:read',
        path: join(root, 'src', 'inside.txt'),
      })).toBe(true)
      expect(capabilityPermits(payload, {
        scope: 'fs:read',
        path: join(root, 'link-to-src', 'inside.txt'),
      })).toBe(true)
      expect(capabilityPermits(payload, {
        scope: 'fs:read',
        path: join(root, 'src', 'escape', 'secret.txt'),
      })).toBe(false)
      expect(capabilityPermits(payload, {
        scope: 'fs:read',
        path: join(root, 'outside', 'secret.txt'),
      })).toBe(false)

      // A dangling/nonexistent requested path falls back to path.resolve and
      // still cannot leave the granted root.
      expect(capabilityPermits(payload, {
        scope: 'fs:read',
        path: join(root, 'src', 'not-yet-created.txt'),
      })).toBe(true)
      expect(capabilityPermits(payload, {
        scope: 'fs:read',
        path: join(root, 'src', '..', 'outside', 'not-yet-created.txt'),
      })).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
