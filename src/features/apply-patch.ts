/**
 * apply_patch: transactional multi-file editing.
 *
 * The host's edit tools commit one file at a time. A multi-file refactor built
 * from a sequence of edits can therefore leave the workspace half-updated when
 * a later file has drifted. This tool changes the unit of success to the whole
 * patch:
 *
 * 1. validate the batch (non-empty, <= maxFiles, one edit per file),
 * 2. resolve and read every target, locating each `old_string` tolerantly,
 * 3. refuse the entire batch if any file cannot be matched,
 * 4. write sequentially, keeping the original content of every committed file,
 * 5. if a write fails, write the originals back in reverse order and throw.
 *
 * No file is written until every edit has passed its preflight. The rollback
 * is best-effort by nature (a filesystem that keeps failing can also refuse the
 * restoring writes), so the error reports how many files were restored.
 */

import type {
  PluginContext,
  SuperDshConfig,
  ToolDefinitionLike,
  ToolExecutionLike,
} from '../plugin-types.ts'
import { fuzzyApply } from '../fuzzy-apply.ts'
import { sessionCwd, warn } from '../shared.ts'

interface PatchEdit {
  file_path: string
  old_string: string
  new_string: string
}

interface PreparedEdit {
  filePath: string
  displayPath: string
  target: unknown
  original: string
  content: string
  strategy: string
  matchedChars: number
}

export function applyPatch(ctx: PluginContext, config: SuperDshConfig): void {
  const options = typeof config.applyPatch === 'object' ? config.applyPatch : {}
  const maxFiles = normalizeMaxFiles(options.maxFiles)

  ctx.systemPrompt.section({
    name: 'super-dsh:apply-patch',
    order: 115,
    text: '`apply_patch` applies edits to up to ' + String(maxFiles) + ' files as one transaction: '
      + 'if any old_string cannot be located, nothing is written. Use one edit per file and merge multiple '
      + 'changes to the same file into a single old_string/new_string pair. Matching tolerates whitespace drift, '
      + 'but still requires a unique region. Read the files first.',
  })

  const tool: ToolDefinitionLike = {
    name: 'apply_patch',
    description: 'Edit 1..' + String(maxFiles) + ' files atomically. Every edit is preflighted; if any old_string '
      + 'cannot be matched uniquely, no file is written. Writes are sequential and rolled back to the original '
      + 'contents if a write fails, so the batch ends all-applied or all-original. '
      + 'Only one edit per file is allowed: merge multiple changes into one old_string/new_string.',
    parameters: {
      type: 'object',
      properties: {
        edits: {
          type: 'array',
          minItems: 1,
          maxItems: maxFiles,
          items: {
            type: 'object',
            properties: {
              file_path: {
                type: 'string',
                description: 'Path to edit, resolved by the filesystem backend.',
              },
              old_string: {
                type: 'string',
                description: 'Text to find. Whitespace and line endings may differ from the file.',
              },
              new_string: {
                type: 'string',
                description: 'Replacement text. Use an empty string to delete the match.',
              },
            },
            required: ['file_path', 'old_string', 'new_string'],
            additionalProperties: false,
          },
        },
      },
      required: ['edits'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          applied: { type: 'boolean' },
          files: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                strategy: { type: 'string' },
                matched_chars: { type: 'integer' },
              },
              required: ['path', 'strategy', 'matched_chars'],
              additionalProperties: false,
            },
          },
          restored: {
            type: 'integer',
            description: 'Files written back to their original content after a failure.',
          },
        },
        required: ['applied', 'files'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const files = value.files as Array<{ path: string; strategy: string; matched_chars: number }>
        if (value.applied !== true) {
          return [{ type: 'text', text: 'apply_patch did not apply any edits.' }]
        }
        const lines = files.map(file => `- ${file.path} (${file.strategy}, ${file.matched_chars} chars)`)
        return [{
          type: 'text',
          text: `Applied ${files.length} file edit(s) as one transaction:\n${lines.join('\n')}`,
        }]
      },
    },
    isConcurrencySafe: () => false,
    async execute(rawArgs: Record<string, unknown>, exec: ToolExecutionLike) {
      exec.signal.throwIfAborted()
      const edits = parseEdits(rawArgs.edits)
      validateBatch(edits, maxFiles)

      const cwd = await sessionCwd(ctx, exec.agent, exec.signal)

      // Preflight: read everything and locate every match before the first
      // write. Independent failures are collected so the model can fix the
      // whole batch in one round trip.
      const prepared: PreparedEdit[] = []
      const failures: string[] = []
      for (const edit of edits) {
        exec.signal.throwIfAborted()
        try {
          const target = await ctx.fs.resolve(edit.file_path, { cwd, signal: exec.signal })
          const original = await ctx.fs.readText(target, exec.signal)
          const match = fuzzyApply(original, edit.old_string, edit.new_string)
          if (!match.ok || match.matchedText === undefined) {
            failures.push(`${edit.file_path}: ${match.reason ?? 'could not safely locate old_string'}`)
            continue
          }
          prepared.push({
            filePath: edit.file_path,
            displayPath: displayPathOf(target, edit.file_path),
            target,
            original,
            content: match.content,
            strategy: match.strategy,
            matchedChars: match.matchedText.length,
          })
        } catch (error: unknown) {
          if (exec.signal.aborted) throw error
          failures.push(`${edit.file_path}: ${errorMessage(error)}`)
        }
      }

      if (failures.length > 0) {
        throw new Error(`apply_patch refused: ${failures.length} of ${edits.length} edit(s) failed; `
          + `no files were changed:\n${failures.map(failure => `- ${failure}`).join('\n')}`)
      }

      const sandboxPolicy = resolveSandboxPolicy(ctx, exec)
      const written: PreparedEdit[] = []
      let current: PreparedEdit | undefined
      try {
        for (const edit of prepared) {
          current = edit
          exec.signal.throwIfAborted()
          await ctx.fs.writeText(edit.target, edit.content, undefined, exec.signal, sandboxPolicy)
          written.push(edit)
        }
      } catch (error: unknown) {
        const failedPath = current?.filePath ?? 'unknown file'
        // Rollback uses a live signal even if the batch was aborted: cleanup is
        // the one write that should not be cancelled by the caller's abort.
        const rollbackSignal = exec.signal.aborted ? undefined : exec.signal
        let restored = 0
        const rollbackFailures: string[] = []
        for (let index = written.length - 1; index >= 0; index--) {
          const done = written[index]
          try {
            await ctx.fs.writeText(done.target, done.original, undefined, rollbackSignal, sandboxPolicy)
            restored++
          } catch (restoreError: unknown) {
            rollbackFailures.push(`${done.filePath}: ${errorMessage(restoreError)}`)
          }
        }

        const parts = [`apply_patch failed while writing ${failedPath}: ${errorMessage(error)}`]
        parts.push(restored === 0
          ? 'no previously written files needed restoration'
          : `restored ${restored} previously written file(s) to their original content`)
        if (rollbackFailures.length > 0) {
          parts.push(`rollback failed for:\n${rollbackFailures.map(failure => `- ${failure}`).join('\n')}`)
        }
        const combined = new Error(parts.join('; ')) as Error & { restored?: number }
        combined.restored = restored
        throw combined
      }

      return {
        applied: true,
        files: prepared.map(edit => ({
          path: edit.displayPath,
          strategy: edit.strategy,
          matched_chars: edit.matchedChars,
        })),
      }
    },
  }

  try {
    ctx.tools.register(tool)
  } catch (error: unknown) {
    warn(ctx.logger, 'could not register apply_patch', error)
  }
}

function normalizeMaxFiles(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 10
  return Math.max(1, Math.floor(value))
}

function parseEdits(raw: unknown): PatchEdit[] {
  if (!Array.isArray(raw)) throw new Error('edits must be an array of {file_path, old_string, new_string}')
  const edits: PatchEdit[] = []
  for (let index = 0; index < raw.length; index++) {
    const item = raw[index]
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`edits[${index}] must be an object`)
    }
    const candidate = item as Record<string, unknown>
    if (typeof candidate.file_path !== 'string' || candidate.file_path.trim().length === 0) {
      throw new Error(`edits[${index}].file_path must be a non-empty string`)
    }
    if (typeof candidate.old_string !== 'string' || candidate.old_string.length === 0) {
      throw new Error(`edits[${index}].old_string must be a non-empty string`)
    }
    if (typeof candidate.new_string !== 'string') {
      throw new Error(`edits[${index}].new_string must be a string`)
    }
    if (candidate.old_string === candidate.new_string) {
      throw new Error(`edits[${index}] (${candidate.file_path}): old_string and new_string must differ`)
    }
    edits.push({
      file_path: candidate.file_path,
      old_string: candidate.old_string,
      new_string: candidate.new_string,
    })
  }
  return edits
}

function validateBatch(edits: PatchEdit[], maxFiles: number): void {
  if (edits.length === 0) throw new Error('edits must contain at least one edit')
  if (edits.length > maxFiles) {
    throw new Error(`apply_patch accepts at most ${maxFiles} edits per call (received ${edits.length}); `
      + 'split the change into smaller batches')
  }
  const seen = new Set<string>()
  for (const edit of edits) {
    if (seen.has(edit.file_path)) {
      throw new Error(`duplicate file_path ${JSON.stringify(edit.file_path)}: `
        + 'combine multiple edits to the same file into one old_string/new_string pair')
    }
    seen.add(edit.file_path)
  }
}

function displayPathOf(target: unknown, fallback: string): string {
  const value = (target as { displayPath?: unknown } | null)?.displayPath
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function resolveSandboxPolicy(ctx: PluginContext, exec: ToolExecutionLike): unknown {
  const service = ctx.get?.('sandboxPolicy') as
    | { resolve(input: { session?: unknown }): unknown }
    | undefined
  if (service === undefined) return undefined
  try {
    return service.resolve(exec.agent?.session === undefined ? {} : { session: exec.agent.session })
  } catch {
    return undefined
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
