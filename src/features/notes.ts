/**
 * Session notes: a small JSONL scratchpad for long-running work.
 *
 * Each session gets one file named from `safeFileStem(sessionId)`, so a
 * hostile session id cannot escape the notes directory. Reads are tolerant:
 * one torn or malformed line is skipped instead of discarding the whole file.
 * Compaction is a real, atomic rewrite rather than a read-time limit.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { PluginContext, SuperDshConfig, ToolDefinitionLike, ToolExecutionLike } from '../plugin-types.ts'
import { dshHome, sessionCwd, workspaceKey, warn } from '../shared.ts'
import { safeFileStem, sessionIdOf } from '../session-id.ts'

interface NoteEntry {
  v: 1
  at: number
  content: string
  tag: string
}

const DEFAULT_TAG = 'general'
const DEFAULT_MAX_ENTRIES = 500
const MAX_CONTENT_CHARS = 8000

export function applyNotes(
  ctx: PluginContext,
  config: SuperDshConfig = {},
): void {
  if (config.notes === false) return
  const options = typeof config.notes === 'object' ? config.notes : {}
  const dir = options.dir ?? join(dshHome(), 'super-dsh', 'notes')
  const maxEntries = clampInt(options.maxEntriesPerSession ?? DEFAULT_MAX_ENTRIES, 1, 100_000)

  ctx.systemPrompt.section({
    name: 'super-dsh:notes',
    order: 142,
    text: 'Session notes are a scratchpad for this session only. Use `note_append` to record discoveries, '
      + 'decisions, and errors that are worth keeping across many steps; use `note_read` to recall them '
      + 'and `note_compact` when the scratchpad grows too long.',
  })

  const sessionKey = async (exec: ToolExecutionLike): Promise<string> => {
    return sessionIdOf(exec.agent)
      ?? workspaceKey(await sessionCwd(ctx, exec.agent, exec.signal))
  }

  const appendTool: ToolDefinitionLike = {
    name: 'note_append',
    description: 'Append one note to the current session scratchpad. Content is trimmed and capped at '
      + `${MAX_CONTENT_CHARS} characters; the tag defaults to "${DEFAULT_TAG}".`,
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Note text. Must be non-empty after trimming.' },
        tag: { type: 'string', description: `Optional category, e.g. discovery, decision, error. Defaults to ${DEFAULT_TAG}.` },
      },
      required: ['content'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          count: { type: 'integer', description: 'Notes stored for this session after the append.' },
          path: { type: 'string', description: 'Scratchpad file path.' },
        },
        required: ['count', 'path'],
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Saved note (${String(value.count)} notes in this session).`,
      }],
    },
    async execute(rawArgs: Record<string, unknown>, exec: ToolExecutionLike) {
      const content = typeof rawArgs.content === 'string' ? rawArgs.content.trim() : ''
      if (content.length === 0) throw new Error('note content must be a non-empty string')
      const rawTag = typeof rawArgs.tag === 'string' ? rawArgs.tag.trim() : ''
      const tag = rawTag.length === 0 ? DEFAULT_TAG : rawTag
      const body = content.length > MAX_CONTENT_CHARS ? content.slice(0, MAX_CONTENT_CHARS) : content
      const file = join(dir, `${safeFileStem(await sessionKey(exec))}.jsonl`)

      mkdirSync(dir, { recursive: true })
      const entry: NoteEntry = { v: 1, at: Date.now(), content: body, tag }
      appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8')

      let entries = readEntries(file).entries
      if (entries.length > maxEntries) {
        entries = entries.slice(-maxEntries)
        writeEntries(file, entries)
      }
      return { count: entries.length, path: file }
    },
  }

  const readTool: ToolDefinitionLike = {
    name: 'note_read',
    description: 'Read session notes in chronological order (oldest first). Malformed lines are skipped and counted. '
      + 'When a tag is given only exact, case-insensitive tag matches are returned.',
    parameters: {
      type: 'object',
      properties: {
        tag: { type: 'string', description: 'Optional tag to filter by.' },
        limit: { type: 'integer', description: 'Maximum notes to return (most recent first kept). Defaults to 50.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          count: { type: 'integer' },
          skipped: { type: 'integer', description: 'Malformed or invalid lines ignored in the file.' },
          notes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                at: { type: 'integer' },
                content: { type: 'string' },
                tag: { type: 'string' },
              },
              required: ['at', 'content', 'tag'],
              additionalProperties: false,
            },
          },
        },
        required: ['count', 'skipped', 'notes'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const notes = value.notes as Array<{ at: number; content: string; tag: string }>
        const header = `Read ${String(value.count)} note(s)`
          + (Number(value.skipped) > 0 ? `; skipped ${String(value.skipped)} malformed line(s)` : '')
        const lines = notes.slice(0, 20).map(note => `- [${note.tag}] ${note.content}`)
        return [{ type: 'text', text: lines.length === 0 ? header : `${header}\n${lines.join('\n')}` }]
      },
    },
    async execute(rawArgs: Record<string, unknown>, exec: ToolExecutionLike) {
      const tag = typeof rawArgs.tag === 'string' ? rawArgs.tag.trim().toLowerCase() : ''
      const limit = clampInt(rawArgs.limit ?? 50, 1, 1000)
      const file = join(dir, `${safeFileStem(await sessionKey(exec))}.jsonl`)
      const parsed = readEntries(file)
      let notes = parsed.entries
        .slice()
        .sort((left, right) => left.at - right.at)
      if (tag.length > 0) notes = notes.filter(note => note.tag.toLowerCase() === tag)
      const selected = notes.slice(-limit)
      return {
        count: selected.length,
        skipped: parsed.skipped,
        notes: selected.map(note => ({ at: note.at, content: note.content, tag: note.tag })),
      }
    },
  }

  const compactTool: ToolDefinitionLike = {
    name: 'note_compact',
    description: 'Rewrite the session scratchpad with only the most recent notes. '
      + 'This atomically replaces the JSONL file and drops malformed lines.',
    parameters: {
      type: 'object',
      properties: {
        keep: { type: 'integer', description: 'Number of most recent notes to keep. Defaults to 50.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          before: { type: 'integer' },
          after: { type: 'integer' },
        },
        required: ['before', 'after'],
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Compacted session notes: ${String(value.before)} -> ${String(value.after)}.`,
      }],
    },
    async execute(rawArgs: Record<string, unknown>, exec: ToolExecutionLike) {
      const keep = clampInt(rawArgs.keep ?? 50, 0, 100_000)
      const file = join(dir, `${safeFileStem(await sessionKey(exec))}.jsonl`)
      if (!existsSync(file)) return { before: 0, after: 0 }
      const entries = readEntries(file).entries
        .slice()
        .sort((left, right) => left.at - right.at)
      const before = entries.length
      const kept = entries.slice(Math.max(0, entries.length - keep))
      mkdirSync(dir, { recursive: true })
      writeEntries(file, kept)
      return { before, after: kept.length }
    },
  }

  for (const tool of [appendTool, readTool, compactTool]) {
    try {
      ctx.tools.register(tool)
    } catch (error: unknown) {
      warn(ctx.logger, `could not register ${tool.name}`, error)
    }
  }
}

function readEntries(file: string): { entries: NoteEntry[]; skipped: number } {
  if (!existsSync(file)) return { entries: [], skipped: 0 }
  const raw = readFileSync(file, 'utf8')
  const entries: NoteEntry[] = []
  let skipped = 0
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length === 0) continue
    try {
      const parsed = JSON.parse(line) as Partial<NoteEntry>
      if (parsed.v !== 1
        || typeof parsed.at !== 'number' || !Number.isFinite(parsed.at)
        || typeof parsed.content !== 'string' || parsed.content.length === 0
        || typeof parsed.tag !== 'string') {
        skipped++
        continue
      }
      entries.push({ v: 1, at: parsed.at, content: parsed.content, tag: parsed.tag })
    } catch {
      skipped++
    }
  }
  return { entries, skipped }
}

/** Write through a sibling temp file so readers never observe a partial rewrite. */
function writeEntries(file: string, entries: NoteEntry[]): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
  const body = entries.map(entry => JSON.stringify(entry)).join('\n') + (entries.length > 0 ? '\n' : '')
  try {
    writeFileSync(tmp, body, 'utf8')
    renameSync(tmp, file)
  } finally {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      // Best-effort cleanup of the temp path; the rename already succeeded.
    }
  }
}

function clampInt(value: unknown, min: number, max: number): number {
  const number = typeof value === 'number' ? Math.floor(value) : Number.NaN
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : min
}
