/**
 * Deterministic checks for the lightweight repository map: duplicate symbol
 * names across files, import-aware references, impact lookup, cache refresh,
 * and directory filtering.
 */

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { applyRepoMap } from '../src/features/repo-map.ts'
import { exec, fakeContext } from './fake-context.ts'

interface FoundSymbol {
  name: string
  kind: string
  file: string
  line: number
  score: number
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'super-dsh-repo-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'alpha.ts'), [
    'export function shared(value: number) {',
    '  return value + 1',
    '}',
    '',
    'export function alphaHelper() {',
    '  return shared(1)',
    '}',
    '',
  ].join('\n'), 'utf8')
  writeFileSync(join(root, 'src', 'beta.ts'), [
    'export function shared(value: number) {',
    '  return value * 2',
    '}',
    '',
  ].join('\n'), 'utf8')
  writeFileSync(join(root, 'src', 'main.ts'), [
    "import { shared as consume } from './alpha'",
    '',
    'export function caller() {',
    '  return consume(41)',
    '}',
    '',
  ].join('\n'), 'utf8')
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(
    join(root, 'node_modules', 'pkg', 'hidden.ts'),
    'export function hiddenSymbol() { return 1 }\n',
    'utf8',
  )
  return root
}

function repo(root: string) {
  const fake = fakeContext()
  applyRepoMap(fake.ctx, { repoMap: { root, refreshMs: 0 } })
  return {
    map: fake.tools.get('repo_map')!,
    find: fake.tools.get('find_symbol')!,
    impact: fake.tools.get('impact_of')!,
  }
}

describe('repository map', () => {
  test('keeps same-named symbols from different files and follows imports for impact', async () => {
    const root = fixture()
    const tools = repo(root)

    const found = await tools.find.execute({ name: 'shared' }, exec())
    const symbols = found.symbols as FoundSymbol[]
    expect(found.count).toBe(2)
    expect(symbols.map(symbol => symbol.name)).toEqual(['shared', 'shared'])
    expect(symbols.map(symbol => symbol.file).sort()).toEqual(['src/alpha.ts', 'src/beta.ts'])

    const top = await tools.map.execute({}, exec())
    expect(top.files).toBe(3)
    expect(top.root).toBe(resolve(root))
    expect(top.count).toBeGreaterThan(0)
    expect(JSON.stringify(top)).not.toContain('hiddenSymbol')

    const query = await tools.map.execute({ query: 'shared' }, exec())
    expect(query.count).toBeGreaterThanOrEqual(2)

    const impact = await tools.impact.execute({ symbol: 'shared' }, exec())
    expect(impact.files as string[]).toContain('src/main.ts')
    const callers = impact.symbols as Array<{ name: string; file: string }>
    expect(callers.some(symbol => symbol.name === 'caller' && symbol.file === 'src/main.ts')).toBe(true)
    expect(impact.count).toBeGreaterThan(0)
  })

  test('honors result limits', async () => {
    const root = fixture()
    const tools = repo(root)
    const found = await tools.find.execute({ name: 'shared', limit: 1 }, exec())
    expect(found.count).toBe(1)
    expect((found.symbols as FoundSymbol[]).length).toBe(1)
  })

  test('serves the cached index inside the refresh window', async () => {
    const root = fixture()
    const fake = fakeContext()
    applyRepoMap(fake.ctx, { repoMap: { root, refreshMs: 60_000 } })
    const find = fake.tools.get('find_symbol')!

    const before = await find.execute({ name: 'secret' }, exec())
    expect(before.count).toBe(0)

    const beta = join(root, 'src', 'beta.ts')
    const original = readFileSync(beta, 'utf8')
    writeFileSync(beta, original.replace('shared', 'secret'), 'utf8')
    const future = new Date(Date.now() + 10_000)
    utimesSync(beta, future, future)

    // TTL cache: the change is intentionally invisible until refreshMs elapses.
    const cached = await find.execute({ name: 'secret' }, exec())
    expect(cached.count).toBe(0)
  })

  test('rebuilds when an existing file changes without changing size', async () => {
    const root = fixture()
    const tools = repo(root)
    const beta = join(root, 'src', 'beta.ts')

    const before = await tools.find.execute({ name: 'secret' }, exec())
    expect(before.count).toBe(0)

    const original = readFileSync(beta, 'utf8')
    const modified = original.replace('shared', 'secret')
    expect(modified.length).toBe(original.length)
    expect(modified).not.toBe(original)
    writeFileSync(beta, modified, 'utf8')
    const future = new Date(Date.now() + 10_000)
    utimesSync(beta, future, future)

    const after = await tools.find.execute({ name: 'secret' }, exec())
    const symbols = after.symbols as FoundSymbol[]
    expect(after.count).toBe(1)
    expect(symbols[0].file).toBe('src/beta.ts')

    const renamed = await tools.find.execute({ name: 'shared' }, exec())
    expect(renamed.count).toBe(1)
    expect((renamed.symbols as FoundSymbol[])[0].file).toBe('src/alpha.ts')
  })

  test('ignores node_modules and other build directories', async () => {
    const root = fixture()
    const tools = repo(root)

    const found = await tools.find.execute({ name: 'hiddenSymbol' }, exec())
    expect(found.count).toBe(0)

    const map = await tools.map.execute({}, exec())
    expect(map.files).toBe(3)
    expect(JSON.stringify(map)).not.toContain('node_modules')
  })

  test('impact_of returns an empty result for an unknown symbol', async () => {
    const root = fixture()
    const tools = repo(root)
    const impact = await tools.impact.execute({ symbol: 'doesNotExist' }, exec())
    expect(impact.count).toBe(0)
    expect(impact.files).toEqual([])
    expect(impact.symbols).toEqual([])
  })
})
