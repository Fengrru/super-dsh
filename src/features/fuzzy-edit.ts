/**
 * fuzzy_edit: a drop-in fallback for dsh's literal `edit` tool.
 *
 * The model proposes `old_string` from memory; whitespace, indentation, or line
 * endings may have drifted. `fuzzy-patch` locates the intended region, then the
 * edit is applied through the host's `ctx.fs.editText` with the exact matched
 * substring, so dsh's atomicity, observation policy, sandbox policy, and
 * unique-match guard all still apply.
 */

import type { PluginContext, ToolDefinitionLike, ToolExecutionLike, SuperDshConfig } from '../plugin-types.ts'
import { fuzzyApply } from '../fuzzy-apply.ts'
import { warn } from '../shared.ts'

interface FuzzyEditArgs {
  file_path: string
  old_string: string
  new_string: string
}

export function applyFuzzyEdit(ctx: PluginContext, config: SuperDshConfig): void {
  ctx.systemPrompt.section({
    name: 'super-dsh:fuzzy-edit',
    order: 110,
    text: '`edit` requires an exact, unique match. If it fails because of whitespace, indentation, or line-ending drift, '
      + 'call `fuzzy_edit` with the same `old_string` and `new_string`; it locates the intended region tolerantly, '
      + 'but still refuses ambiguous matches. Read the file first, as required by `edit`.',
  })

  const tool: ToolDefinitionLike = {
    name: 'fuzzy_edit',
    description: 'Edit an existing UTF-8 text file when the exact old_string is uncertain. '
      + 'Uses tolerant matching for whitespace, indentation, line endings, and token-level drift, '
      + 'then applies the change atomically. The matched region must still be unique in the file.',
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to edit, resolved by the filesystem backend.',
        },
        old_string: {
          type: 'string',
          description: 'Text to find, as remembered. Whitespace and line endings may differ from the file.',
        },
        new_string: {
          type: 'string',
          description: 'Replacement text. Use an empty string to delete the match.',
        },
      },
      required: ['file_path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          strategy: { type: 'string' },
          matched_chars: { type: 'integer' },
        },
        required: ['path', 'strategy', 'matched_chars'],
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: `The file ${String(value.path)} has been updated successfully `
          + `(fuzzy match: ${String(value.strategy)}, ${String(value.matched_chars)} chars).`,
      }],
    },
    async execute(rawArgs: Record<string, unknown>, exec: ToolExecutionLike) {
      const args = rawArgs as unknown as FuzzyEditArgs
      if (typeof args.file_path !== 'string' || args.file_path.trim().length === 0) {
        throw new Error('file_path must be a non-empty string')
      }
      if (typeof args.old_string !== 'string' || args.old_string.length === 0) {
        throw new Error('old_string must be a non-empty string')
      }
      if (typeof args.new_string !== 'string') {
        throw new Error('new_string must be a string')
      }
      if (args.old_string === args.new_string) {
        throw new Error('old_string and new_string must differ')
      }

      const target = await ctx.fs.resolve(args.file_path, await resolveOptions(ctx, exec))
      const before = await ctx.fs.readText(target, exec.signal)
      const match = fuzzyApply(before, args.old_string, args.new_string)

      if (!match.ok || match.matchedText === undefined) {
        throw new Error(match.reason
          ?? 'Could not safely locate the old_string. Re-read the file and include more surrounding context.')
      }

      let intent: { version: unknown } | undefined
      try {
        intent = await ctx.waterfall?.('fs/edit-intent', target, exec, () => undefined) as
          | { version: unknown }
          | undefined
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`${message} (fuzzy_edit still requires reading the file first, like edit)`)
      }

      const sandboxPolicy = resolveSandboxPolicy(ctx, exec)
      await ctx.fs.editText(
        target,
        { oldString: match.matchedText, newString: args.new_string, replaceAll: false },
        intent,
        exec.signal,
        sandboxPolicy,
      )

      return {
        path: (target as { displayPath?: string }).displayPath ?? args.file_path,
        strategy: match.strategy,
        matched_chars: match.matchedText.length,
      }
    },
  }

  try {
    ctx.tools.register(tool)
  } catch (error: unknown) {
    warn(ctx.logger, 'could not register fuzzy_edit', error)
  }
}

async function resolveOptions(
  ctx: PluginContext,
  exec: ToolExecutionLike,
): Promise<{ cwd?: string; signal: AbortSignal }> {
  let cwd: string | undefined
  if (exec.agent !== undefined && ctx.workingDirectory !== undefined) {
    cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
  }
  return { ...(cwd === undefined ? {} : { cwd }), signal: exec.signal }
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
