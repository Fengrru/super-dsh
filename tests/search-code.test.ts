/**
 * Deterministic checks for the natural-language search_code tool: intent
 * classification, identifier extraction, duplicate definitions, direct
 * callers, lexical text fallback, limits, and the search:false switch.
 * No model calls, no network.
 */

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { applyRepoMap } from '../src/features/repo-map.ts'
import type { SuperDshConfig, ToolDefinitionLike } from '../src/plugin-types.ts'
import { exec, fakeContext } from './fake-context.ts'

interface SearchHit {
  name: string
  kind: string
  file: string
  line: number
  score: number
}

interface SearchOutput {
  mode: string
  query: string
  results: SearchHit[]
  count: number
}

const FIXTURE_FILES: Record<string, string> = {
  'src/auth/session.ts': [
    "import { loadConfig } from '../config/index'",
    '',
    'export interface Session {',
    '  token: string',
    '  expiresAt: number',
    '}',
    '',
    '// Token expiration is checked before any privileged action.',
    'export function validateSession(token: string): boolean {',
    '  const config = loadConfig()',
    '  return token.length > 0 && Date.now() < config.sessionTtl',
    '}',
    '',
    'export function refreshSession(token: string): string {',
    '  return `${token}:refreshed`',
    '}',
    '',
  ].join('\n'),

  'src/auth/login.ts': [
    "import { validateSession } from './session'",
    "import { logMessage } from '../utils/logger'",
    '',
    'export function login(token: string): boolean {',
    "  logMessage('info', 'login attempt')",
    '  return validateSession(token)',
    '}',
    '',
  ].join('\n'),

  'src/auth/middleware.ts': [
    "import { refreshSession, validateSession } from './session'",
    '',
    '// Authentication middleware for protected routes.',
    'export function authMiddleware(token: string): string {',
    '  if (!validateSession(token)) {',
    "    throw new Error('unauthorized')",
    '  }',
    '  return refreshSession(token)',
    '}',
    '',
  ].join('\n'),

  'src/legacy/session.ts': [
    '// Legacy token expiration handling kept for old mobile clients.',
    'export function validateSession(token: string): boolean {',
    "  return token !== ''",
    '}',
    '',
  ].join('\n'),

  'src/config/index.ts': [
    "import { defaultConfig } from './defaults'",
    '',
    '// Timeout handling for outbound requests is defined in defaults.',
    "export const configVersion = 'v2'",
    '',
    'export function loadConfig(): typeof defaultConfig {',
    '  return defaultConfig',
    '}',
    '',
  ].join('\n'),

  'src/config/loader.ts': [
    "import { defaultConfig } from './defaults'",
    '',
    'export function loadConfig() {',
    '  return { ...defaultConfig, loadedAt: Date.now() }',
    '}',
    '',
  ].join('\n'),

  'src/config/defaults.ts': [
    '// Default retry policy and timeout handling for the HTTP client.',
    '// loadConfig merges these defaults; call loadConfig once per request.',
    'export const defaultConfig = {',
    '  sessionTtl: 60_000,',
    '  requestTimeoutMs: 2_500,',
    '  maxRetries: 3,',
    '}',
    '',
    'export function describeDefaults(): string {',
    "  return 'timeout handling defaults'",
    '}',
    '',
  ].join('\n'),

  'src/http/client.ts': [
    "import { loadConfig } from '../config/loader'",
    "import { logMessage } from '../utils/logger'",
    '',
    '// Rate limiting bounds concurrency. validateSession is enforced upstream;',
    '// a failed validateSession returns 401 before any request is sent.',
    '// refreshSession is retried here; refreshSession failures fall back to login.',
    '// sleep is awaited between retry attempts; sleep must stay capped at 2s.',
    'export async function request(url: string): Promise<string> {',
    '  const config = loadConfig()',
    "  logMessage('info', `request ${url} timeout=${config.requestTimeoutMs}`)",
    '  return url',
    '}',
    '',
  ].join('\n'),

  'src/http/retry.ts': [
    "import { request } from './client'",
    '',
    '// Retry policy: backoff is bounded by the request timeout handling.',
    '// loadConfig is not called here; loadConfig values arrive from the client.',
    '// validateSession is expected to have run already, and validateSession errors abort retries.',
    '// refreshSession is scheduled elsewhere; refreshSession never runs in this file.',
    'export async function retryRequest(url: string): Promise<string> {',
    '  return request(url)',
    '}',
    '',
    'function sleep(ms: number): Promise<void> {',
    '  return new Promise(resolve => setTimeout(resolve, ms))',
    '}',
    '',
    'export async function retryWithBackoff(url: string): Promise<string> {',
    '  await sleep(10)',
    '  return retryRequest(url)',
    '}',
    '',
  ].join('\n'),

  'src/http/server.ts': [
    "import { request } from './client'",
    "import { sleep } from '../utils/sleep'",
    "import { logMessage } from '../utils/logger'",
    '',
    '// The server enforces authentication middleware before rate limiting.',
    '// validateSession is checked here, and validateSession failures return 401.',
    '// loadConfig is resolved by the client, not by loadConfig in this file.',
    '// refreshSession is handled by the auth layer; refreshSession is not called here.',
    'export async function handleRequest(url: string): Promise<string> {',
    '  await sleep(5)',
    "  logMessage('info', 'server handling request')",
    '  return request(url)',
    '}',
    '',
  ].join('\n'),

  'src/utils/sleep.ts': [
    '// Centralized sleep helper for request pacing.',
    '// refreshSession callers use sleep between auth retries; refreshSession itself never sleeps.',
    'export function sleep(ms: number): Promise<void> {',
    '  return new Promise(resolve => setTimeout(resolve, ms))',
    '}',
    '',
  ].join('\n'),

  'src/utils/logger.ts': [
    '// logMessage is the only console sink.',
    'export function logMessage(level: string, message: string): void {',
    '  const line = `[${level}] ${message}`',
    '  if (line.length > 0) console.log(line)',
    '}',
    '',
  ].join('\n'),
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'super-dsh-search-'))
  for (const [rel, content] of Object.entries(FIXTURE_FILES)) {
    const abs = join(root, ...rel.split('/'))
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content, 'utf8')
  }
  return root
}

function setup(extra: Record<string, unknown> = {}): {
  tools: Map<string, ToolDefinitionLike>
  search: ToolDefinitionLike
  sections: Array<{ name: string; text: unknown }>
} {
  const root = fixture()
  const fake = fakeContext()
  applyRepoMap(fake.ctx, { repoMap: { root, ...extra } } as unknown as SuperDshConfig)
  const search = fake.tools.get('search_code')
  if (search === undefined) throw new Error('search_code was not registered')
  return { tools: fake.tools, search, sections: fake.sections }
}

async function search(
  tool: ToolDefinitionLike,
  args: Record<string, unknown>,
): Promise<SearchOutput> {
  return await tool.execute(args, exec()) as unknown as SearchOutput
}

function expectScores(hits: SearchHit[]): void {
  for (const hit of hits) {
    expect(hit.score).toBeGreaterThanOrEqual(0)
    expect(hit.score).toBeLessThanOrEqual(1)
    expect(Number.isInteger(hit.line)).toBe(true)
    expect(hit.line).toBeGreaterThanOrEqual(1)
  }
}

describe('search_code', () => {
  test('is registered by default and advertised in the system prompt', () => {
    const { tools, sections } = setup()
    expect(tools.has('search_code')).toBe(true)
    expect(tools.has('repo_map')).toBe(true)
    expect(tools.has('find_symbol')).toBe(true)
    expect(tools.has('impact_of')).toBe(true)
    expect(String(sections[0]?.text)).toContain('search_code')
  })

  test('definition queries return every same-named definition', async () => {
    const { search: tool } = setup()

    const sessions = await search(tool, { query: 'where is validateSession defined' })
    expect(sessions.mode).toBe('definition')
    expect(sessions.query).toBe('where is validateSession defined')
    expect(sessions.count).toBe(sessions.results.length)
    const sessionDefs = sessions.results.filter(hit => hit.name === 'validateSession')
    expect(sessionDefs.map(hit => hit.file).sort()).toEqual([
      'src/auth/session.ts',
      'src/legacy/session.ts',
    ])
    expect(sessionDefs.every(hit => hit.kind === 'function')).toBe(true)
    expect(sessionDefs.every(hit => hit.score === 1)).toBe(true)
    expectScores(sessions.results)

    const configs = await search(tool, { query: 'where is loadConfig defined' })
    expect(configs.mode).toBe('definition')
    expect(configs.results.map(hit => hit.file).sort()).toEqual([
      'src/config/index.ts',
      'src/config/loader.ts',
    ])

    const viaFind = await search(tool, { query: 'find function sleep' })
    expect(viaFind.mode).toBe('definition')
    expect(viaFind.results.map(hit => hit.file).sort()).toEqual([
      'src/http/retry.ts',
      'src/utils/sleep.ts',
    ])
  })

  test('caller queries return direct referencing files and their symbols', async () => {
    const { search: tool } = setup()

    const result = await search(tool, { query: 'who calls validateSession' })
    expect(result.mode).toBe('caller')
    expect(result.count).toBe(result.results.length)

    const files = result.results.map(hit => hit.file)
    expect(files).toContain('src/auth/login.ts')
    expect(files).toContain('src/auth/middleware.ts')
    expect(result.results.some(hit =>
      hit.name === 'login' && hit.kind === 'function' && hit.file === 'src/auth/login.ts')).toBe(true)
    expect(result.results.some(hit =>
      hit.name === 'authMiddleware' && hit.file === 'src/auth/middleware.ts')).toBe(true)
    expectScores(result.results)

    const usedBy = await search(tool, { query: 'used by loadConfig' })
    expect(usedBy.mode).toBe('caller')
    expect(usedBy.results.map(hit => hit.file)).toContain('src/auth/session.ts')
  })

  test('text queries rank files by token occurrences and attach file symbols', async () => {
    const { search: tool } = setup()

    const timeout = await search(tool, { query: 'timeout handling' })
    expect(timeout.mode).toBe('text')
    expect(timeout.results[0]).toMatchObject({
      name: 'src/config/defaults.ts',
      kind: 'file',
      file: 'src/config/defaults.ts',
      line: 1,
      score: 1,
    })
    expect(timeout.results.some(hit =>
      hit.kind !== 'file' && hit.file === 'src/config/defaults.ts')).toBe(true)
    expectScores(timeout.results)

    const retry = await search(tool, { query: 'retry policy' })
    expect(retry.mode).toBe('text')
    expect(retry.results.filter(hit => hit.kind === 'file').map(hit => hit.file))
      .toContain('src/http/retry.ts')
    expectScores(retry.results)
  })

  test('honors the limit for every mode', async () => {
    const { search: tool } = setup()

    const definitions = await search(tool, {
      query: 'where is loadConfig defined',
      limit: 1,
    })
    expect(definitions.mode).toBe('definition')
    expect(definitions.count).toBe(1)
    expect(definitions.results.length).toBe(1)

    const text = await search(tool, { query: 'timeout handling', limit: 2 })
    expect(text.mode).toBe('text')
    expect(text.count).toBe(2)
    expect(text.results.length).toBe(2)
  })

  test('rejects a missing or blank query', async () => {
    const { search: tool } = setup()
    await expect(tool.execute({}, exec())).rejects.toThrow(/non-empty/)
    await expect(tool.execute({ query: '   ' }, exec())).rejects.toThrow(/non-empty/)
  })

  test('search:false skips only search_code', () => {
    const root = fixture()
    const fake = fakeContext()
    applyRepoMap(fake.ctx, {
      repoMap: { root, search: false },
    } as unknown as SuperDshConfig)

    expect(fake.tools.has('search_code')).toBe(false)
    expect(fake.tools.has('repo_map')).toBe(true)
    expect(fake.tools.has('find_symbol')).toBe(true)
    expect(fake.tools.has('impact_of')).toBe(true)
    expect(String(fake.sections[0]?.text)).not.toContain('search_code')
  })

  test('render includes the mode and file:line name (kind, score) lines', async () => {
    const { search: tool } = setup()
    const output = await search(tool, { query: 'where is validateSession defined' })
    const text = tool.output.render({}, output as unknown as Record<string, unknown>)[0].text
    expect(text).toContain('definition')
    expect(text).toMatch(/src\/auth\/session\.ts:\d+ validateSession \(function, 1\)/)
    expect(text).toMatch(/src\/legacy\/session\.ts:\d+ validateSession \(function, 1\)/)
  })
})
