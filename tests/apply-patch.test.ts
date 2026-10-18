/**
 * apply_patch transaction tests: preflight refusal, rollback, batch limits, and
 * fuzzy matching. All filesystem behavior is faked in memory.
 */

import { describe, expect, test } from 'bun:test'
import { applyPatch } from '../src/features/apply-patch.ts'
import { exec, fakeContext } from './fake-context.ts'

interface FakeTree {
  files: Map<string, string>
  writes: Array<{ path: string; content: string }>
  reads: string[]
}

function fileSystem(initial: Record<string, string>): { fake: ReturnType<typeof fakeContext>; tree: FakeTree } {
  const tree: FakeTree = {
    files: new Map(Object.entries(initial)),
    writes: [],
    reads: [],
  }
  const fake = fakeContext({
    fs: {
      resolve: async (path: string) => ({ displayPath: path, targetKey: path }),
      readText: async (target: unknown) => {
        const path = (target as { targetKey: string }).targetKey
        tree.reads.push(path)
        const content = tree.files.get(path)
        if (content === undefined) throw new Error(`ENOENT: ${path}`)
        return content
      },
      writeText: async (target: unknown, content: string) => {
        const path = (target as { targetKey: string }).targetKey
        tree.writes.push({ path, content })
        tree.files.set(path, content)
        return { operation: 'update', version: 2 }
      },
    },
  })
  return { fake, tree }
}

describe('apply_patch', () => {
  test('applies a two-file patch successfully', async () => {
    const { fake, tree } = fileSystem({
      'a.ts': 'const a = 1\n',
      'b.ts': 'const b = 2\n',
    })
    applyPatch(fake.ctx, {})
    const tool = fake.tools.get('apply_patch')
    expect(tool).toBeDefined()

    const result = await tool!.execute({
      edits: [
        { file_path: 'a.ts', old_string: 'const a = 1', new_string: 'const a = 10' },
        { file_path: 'b.ts', old_string: 'const b = 2', new_string: 'const b = 20' },
      ],
    }, exec())

    expect(result.applied).toBe(true)
    const files = result.files as Array<{ path: string; strategy: string; matched_chars: number }>
    expect(files.map(file => file.path)).toEqual(['a.ts', 'b.ts'])
    expect(files.map(file => file.strategy)).toEqual(['literal', 'literal'])
    expect(tree.files.get('a.ts')).toBe('const a = 10\n')
    expect(tree.files.get('b.ts')).toBe('const b = 20\n')
    expect(tree.writes.map(write => write.path)).toEqual(['a.ts', 'b.ts'])
  })

  test('refuses the whole batch when any old_string cannot be matched', async () => {
    const { fake, tree } = fileSystem({
      'a.ts': 'const a = 1\n',
      'b.ts': 'const b = 2\n',
      'c.ts': 'const c = 3\n',
    })
    applyPatch(fake.ctx, {})
    const tool = fake.tools.get('apply_patch')!

    let failure: unknown
    try {
      await tool.execute({
        edits: [
          { file_path: 'a.ts', old_string: 'const a = 1', new_string: 'const a = 10' },
          { file_path: 'b.ts', old_string: 'missing text from b', new_string: 'replacement' },
          { file_path: 'c.ts', old_string: 'totally unrelated zzz', new_string: 'replacement' },
        ],
      }, exec())
    } catch (error: unknown) {
      failure = error
    }

    expect(failure).toBeDefined()
    const message = String((failure as Error).message)
    expect(message).toContain('2 of 3 edit(s) failed')
    expect(message).toContain('b.ts')
    expect(message).toContain('c.ts')
    expect(message).toContain('no files were changed')
    expect(tree.writes).toHaveLength(0)
    expect(tree.files.get('a.ts')).toBe('const a = 1\n')
    expect(tree.files.get('b.ts')).toBe('const b = 2\n')
    expect(tree.files.get('c.ts')).toBe('const c = 3\n')
  })

  test('restores the first file when a later write fails', async () => {
    const { fake, tree } = fileSystem({
      'a.ts': 'const a = 1\n',
      'b.ts': 'const b = 2\n',
    })
    const normalWrite = fake.ctx.fs.writeText.bind(fake.ctx.fs)
    fake.ctx.fs.writeText = async (target, content) => {
      const path = (target as { targetKey: string }).targetKey
      if (path === 'b.ts') throw new Error('disk full')
      return normalWrite(target, content)
    }
    applyPatch(fake.ctx, {})
    const tool = fake.tools.get('apply_patch')!

    let failure: unknown
    try {
      await tool.execute({
        edits: [
          { file_path: 'a.ts', old_string: 'const a = 1', new_string: 'const a = 10' },
          { file_path: 'b.ts', old_string: 'const b = 2', new_string: 'const b = 20' },
        ],
      }, exec())
    } catch (error: unknown) {
      failure = error
    }

    expect(failure).toBeDefined()
    expect((failure as Error).message).toContain('disk full')
    expect((failure as { restored?: number }).restored).toBe(1)
    expect(tree.files.get('a.ts')).toBe('const a = 1\n')
    expect(tree.files.get('b.ts')).toBe('const b = 2\n')
    // First write of a.ts, a failed write of b.ts, then the restoring write.
    expect(tree.writes.map(write => write.path)).toEqual(['a.ts', 'a.ts'])
    expect(tree.writes[1].content).toBe('const a = 1\n')
  })

  test('rejects a duplicate file_path', async () => {
    const { fake, tree } = fileSystem({ 'a.ts': 'const a = 1\n' })
    applyPatch(fake.ctx, {})
    const tool = fake.tools.get('apply_patch')!

    await expect(tool.execute({
      edits: [
        { file_path: 'a.ts', old_string: 'const a = 1', new_string: 'const a = 10' },
        { file_path: 'a.ts', old_string: 'const a = 10', new_string: 'const a = 100' },
      ],
    }, exec())).rejects.toThrow(/duplicate file_path/)
    expect(tree.writes).toHaveLength(0)
    expect(tree.reads).toHaveLength(0)
  })

  test('rejects an empty edits array and batches beyond maxFiles', async () => {
    const { fake, tree } = fileSystem({
      'a.ts': 'const a = 1\n',
      'b.ts': 'const b = 2\n',
      'c.ts': 'const c = 3\n',
    })
    applyPatch(fake.ctx, { applyPatch: { maxFiles: 2 } })
    const tool = fake.tools.get('apply_patch')!

    await expect(tool.execute({ edits: [] }, exec())).rejects.toThrow(/at least one edit/)
    await expect(tool.execute({
      edits: [
        { file_path: 'a.ts', old_string: 'const a = 1', new_string: 'const a = 10' },
        { file_path: 'b.ts', old_string: 'const b = 2', new_string: 'const b = 20' },
        { file_path: 'c.ts', old_string: 'const c = 3', new_string: 'const c = 30' },
      ],
    }, exec())).rejects.toThrow(/at most 2 edits/)
    expect(tree.writes).toHaveLength(0)
  })

  test('applies a drifted old_string through fuzzyApply', async () => {
    const { fake, tree } = fileSystem({
      'config.ts': 'const config = {\n  port:   3000,\n  host: "localhost",\n}\n',
    })
    applyPatch(fake.ctx, {})
    const tool = fake.tools.get('apply_patch')!

    const result = await tool.execute({
      edits: [{
        file_path: 'config.ts',
        old_string: '  port: 3000,\n  host: "localhost",',
        new_string: '  port: 8080,\n  host: "0.0.0.0",',
      }],
    }, exec())

    expect(result.applied).toBe(true)
    const files = result.files as Array<{ path: string; strategy: string; matched_chars: number }>
    expect(files[0].strategy).not.toBe('literal')
    expect(files[0].matched_chars).toBeGreaterThan(0)
    expect(tree.files.get('config.ts')).toContain('port: 8080')
    expect(tree.files.get('config.ts')).toContain('host: "0.0.0.0"')
  })
})
