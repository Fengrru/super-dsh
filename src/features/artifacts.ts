/**
 * Content-addressed artifact store.
 * Bytes are addressed by their SHA-256 hash and verified again on every read;
 * the append-only JSONL index adds metadata but is never trusted for paths.
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { TextDecoder } from 'node:util'
import type { PluginContext, SuperDshConfig, ToolDefinitionLike, ToolExecutionLike } from '../plugin-types.ts'
import { dshHome, warn } from '../shared.ts'

interface ArtifactIndexEntry {
  hash: string
  size: number
  media_type: string
  name?: string
  createdAt: number
}

const HASH_PATTERN = /^[a-f0-9]{64}$/

export function applyArtifacts(ctx: PluginContext, config: SuperDshConfig): void {
  if (config.artifacts === false) return
  const options = typeof config.artifacts === 'object' ? config.artifacts : {}
  const root = options.dir ?? join(dshHome(), 'super-dsh', 'artifacts')
  const indexPath = join(root, 'index.jsonl')

  ctx.systemPrompt.section({
    name: 'super-dsh:artifacts',
    order: 124,
    text: 'Artifacts are content-addressed and verified on read. Use `artifact_put` to persist large or binary outputs '
      + '(screenshots, reports, patches) instead of pasting them into the conversation; retrieve them by hash with '
      + '`artifact_get`, use `artifact_verify` when integrity matters, and use `artifact_reindex` to rebuild the '
      + 'index from the blob files after a crash or index loss.',
  })

  const putTool: ToolDefinitionLike = {
    name: 'artifact_put',
    description: 'Store content in the artifact store and return its SHA-256 hash and a stable artifact URI. '
      + 'Provide exactly one of content (UTF-8 text) or content_base64. Storing the same bytes twice is idempotent.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'UTF-8 text content. Mutually exclusive with content_base64.' },
        content_base64: { type: 'string', description: 'Binary content as standard base64. Mutually exclusive with content.' },
        media_type: { type: 'string', description: 'Optional MIME type, e.g. text/plain or image/png.' },
        name: { type: 'string', description: 'Optional human-readable name stored in the index.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          hash: { type: 'string' },
          uri: { type: 'string' },
          size: { type: 'integer' },
        },
        required: ['hash', 'uri', 'size'],
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Stored artifact ${String(value.hash)} (${String(value.size)} bytes) as ${String(value.uri)}.`,
      }],
    },
    async execute(rawArgs: Record<string, unknown>, _exec: ToolExecutionLike) {
      const hasContent = typeof rawArgs.content === 'string'
      const hasBase64 = typeof rawArgs.content_base64 === 'string'
      if (hasContent === hasBase64) {
        throw new Error('provide exactly one of content or content_base64')
      }
      if (rawArgs.media_type !== undefined && typeof rawArgs.media_type !== 'string') {
        throw new Error('media_type must be a string')
      }
      if (rawArgs.name !== undefined && typeof rawArgs.name !== 'string') {
        throw new Error('name must be a string')
      }

      const data = hasContent
        ? Buffer.from(rawArgs.content as string, 'utf8')
        : decodeBase64(rawArgs.content_base64 as string)
      const hash = hashBytes(data)
      const file = artifactFile(root, hash)
      writeAtomic(file, data)

      const mediaType = typeof rawArgs.media_type === 'string' && rawArgs.media_type.trim().length > 0
        ? rawArgs.media_type.trim()
        : hasContent ? 'text/plain; charset=utf-8' : 'application/octet-stream'
      const name = typeof rawArgs.name === 'string' && rawArgs.name.trim().length > 0
        ? rawArgs.name.trim()
        : undefined

      if (!readIndex(indexPath).some(entry => entry.hash === hash)) {
        mkdirSync(root, { recursive: true })
        appendIndex(indexPath, {
          hash,
          size: data.length,
          media_type: mediaType,
          ...(name === undefined ? {} : { name }),
          createdAt: Date.now(),
        })
      }

      return { hash, uri: `artifact://${hash}`, size: data.length }
    },
  }

  const getTool: ToolDefinitionLike = {
    name: 'artifact_get',
    description: 'Read an artifact by its SHA-256 hash. The stored bytes are re-hashed before returning; '
      + 'a mismatch is an error. Text is returned as UTF-8, binary as base64.',
    parameters: {
      type: 'object',
      properties: {
        hash: { type: 'string', description: '64-character lowercase SHA-256 hash returned by artifact_put.' },
      },
      required: ['hash'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          content: { type: 'string' },
          content_base64: { type: 'string' },
          encoding: { type: 'string', enum: ['utf8', 'base64'] },
          hash: { type: 'string' },
          size: { type: 'integer' },
        },
        required: ['encoding', 'hash', 'size'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        if (typeof value.content === 'string') return [{ type: 'text', text: value.content }]
        return [{
          type: 'text',
          text: `Artifact ${String(value.hash)} is binary (${String(value.size)} bytes); content_base64 is in the tool result.`,
        }]
      },
    },
    async execute(rawArgs: Record<string, unknown>) {
      const hash = requireHash(rawArgs.hash)
      const file = artifactFile(root, hash)
      let data: Buffer
      try {
        data = readFileSync(file)
      } catch {
        throw new Error(`artifact not found: ${hash}`)
      }
      const actual = hashBytes(data)
      if (actual !== hash) {
        throw new Error(`artifact ${hash} failed integrity check (actual hash ${actual})`)
      }

      const entry = findIndexEntry(readIndex(indexPath), hash)
      const text = decodeText(data, entry?.media_type)
      return text === undefined
        ? { content_base64: data.toString('base64'), encoding: 'base64', hash, size: data.length }
        : { content: text, encoding: 'utf8', hash, size: data.length }
    },
  }

  const verifyTool: ToolDefinitionLike = {
    name: 'artifact_verify',
    description: 'Verify that an artifact file still exists and matches its SHA-256 hash. '
      + 'This never throws for a missing or tampered file; it returns ok:false with a reason.',
    parameters: {
      type: 'object',
      properties: {
        hash: { type: 'string', description: '64-character lowercase SHA-256 hash to verify.' },
      },
      required: ['hash'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          expected: { type: 'string' },
          actual: { type: 'string' },
          size: { type: 'integer' },
          reason: { type: 'string' },
        },
        required: ['ok', 'expected'],
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok === true
          ? `OK ${String(value.expected)} (${String(value.size)} bytes).`
          : `FAIL ${String(value.expected)}: ${String(value.reason ?? 'integrity check failed')}`,
      }],
    },
    async execute(rawArgs: Record<string, unknown>) {
      const expected = typeof rawArgs.hash === 'string' ? rawArgs.hash : ''
      if (!HASH_PATTERN.test(expected)) {
        return { ok: false, expected, reason: 'invalid hash format' }
      }
      let data: Buffer
      try {
        data = readFileSync(artifactFile(root, expected))
      } catch {
        return { ok: false, expected, reason: 'artifact not found' }
      }
      const actual = hashBytes(data)
      if (actual !== expected) {
        return { ok: false, expected, actual, size: data.length, reason: 'hash mismatch' }
      }
      return { ok: true, expected, actual, size: data.length }
    },
  }

  const listTool: ToolDefinitionLike = {
    name: 'artifact_list',
    description: 'List recently stored artifacts from the index, deduplicated by hash and newest first.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Maximum entries to return, 1..100. Defaults to 20.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          count: { type: 'integer' },
          artifacts: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                hash: { type: 'string' },
                size: { type: 'integer' },
                media_type: { type: 'string' },
                name: { type: 'string' },
                createdAt: { type: 'integer' },
              },
              required: ['hash', 'size', 'media_type', 'createdAt'],
              additionalProperties: false,
            },
          },
        },
        required: ['count', 'artifacts'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const artifacts = value.artifacts as Array<{
          hash: string
          size: number
          media_type: string
          name?: string
        }>
        if (artifacts.length === 0) return [{ type: 'text', text: 'No artifacts stored.' }]
        return [{
          type: 'text',
          text: artifacts.map(entry => {
            const name = entry.name === undefined ? '' : ` ${entry.name}`
            return `${entry.hash} (${entry.size} bytes, ${entry.media_type})${name}`
          }).join('\n'),
        }]
      },
    },
    async execute(rawArgs: Record<string, unknown>) {
      const requested = typeof rawArgs.limit === 'number' && Number.isFinite(rawArgs.limit)
        ? Math.floor(rawArgs.limit)
        : 20
      const limit = Math.min(100, Math.max(1, requested))
      const artifacts = mergeIndex(readIndex(indexPath)).slice(0, limit).map(entry => ({
        hash: entry.hash,
        size: entry.size,
        media_type: entry.media_type,
        ...(entry.name === undefined ? {} : { name: entry.name }),
        createdAt: entry.createdAt,
      }))
      return { count: artifacts.length, artifacts }
    },
  }

  const reindexTool: ToolDefinitionLike = {
    name: 'artifact_reindex',
    description: 'Rebuild and deduplicate the artifact index from the blob files on disk. '
      + 'Use this after a crash or index loss: every valid xx/<sha256> blob is re-hashed and re-indexed, '
      + 'while malformed names, symlinks, non-regular files, and blobs whose bytes no longer match their name are skipped. '
      + 'Existing index metadata is preserved and the index is replaced atomically.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          indexed: { type: 'integer' },
          skipped: { type: 'integer' },
          total: { type: 'integer' },
          total_bytes: { type: 'integer' },
        },
        required: ['indexed', 'skipped', 'total', 'total_bytes'],
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Reindexed ${String(value.indexed)} artifact blob(s), skipped ${String(value.skipped)}; `
          + `the index now holds ${String(value.total)} artifact(s) (${String(value.total_bytes)} bytes).`,
      }],
    },
    async execute() {
      const scanned = scanArtifactFiles(root)
      const merged = mergeReindex(readIndex(indexPath), scanned.entries)
      writeIndexAtomic(indexPath, merged)
      return {
        indexed: scanned.entries.length,
        skipped: scanned.skipped,
        total: merged.length,
        total_bytes: merged.reduce((sum, entry) => sum + entry.size, 0),
      }
    },
  }

  for (const tool of [putTool, getTool, verifyTool, listTool, reindexTool]) {
    try {
      ctx.tools.register(tool)
    } catch (error: unknown) {
      warn(ctx.logger, `could not register ${tool.name}`, error)
    }
  }
}

function hashBytes(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function artifactFile(root: string, hash: string): string {
  return join(root, hash.slice(0, 2), hash)
}

function writeAtomic(file: string, data: Buffer): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(tmp, data)
    renameSync(tmp, file)
  } catch (error: unknown) {
    try {
      unlinkSync(tmp)
    } catch {
      // The temporary file may already be gone.
    }
    throw error
  }
}

function decodeBase64(raw: string): Buffer {
  const normalized = raw.replace(/\s+/g, '')
  if (normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new Error('content_base64 must be standard base64')
  }
  return Buffer.from(normalized, 'base64')
}

function requireHash(value: unknown): string {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    throw new Error('hash must be a 64-character lowercase SHA-256 hex string')
  }
  return value
}

function readIndex(file: string): ArtifactIndexEntry[] {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const entries: ArtifactIndexEntry[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length === 0) continue
    try {
      const parsed = JSON.parse(line) as Partial<ArtifactIndexEntry>
      if (typeof parsed.hash !== 'string' || !HASH_PATTERN.test(parsed.hash)) continue
      if (typeof parsed.size !== 'number' || !Number.isFinite(parsed.size) || parsed.size < 0) continue
      entries.push({
        hash: parsed.hash,
        size: parsed.size,
        media_type: typeof parsed.media_type === 'string' && parsed.media_type.length > 0
          ? parsed.media_type
          : 'application/octet-stream',
        ...(typeof parsed.name === 'string' && parsed.name.length > 0 ? { name: parsed.name } : {}),
        createdAt: typeof parsed.createdAt === 'number' && Number.isFinite(parsed.createdAt)
          ? parsed.createdAt
          : 0,
      })
    } catch {
      // Index lines are advisory; one bad line must not hide the rest.
    }
  }
  return entries
}

function findIndexEntry(entries: readonly ArtifactIndexEntry[], hash: string): ArtifactIndexEntry | undefined {
  let found: ArtifactIndexEntry | undefined
  for (const entry of entries) {
    if (entry.hash === hash) found = entry
  }
  return found
}

interface ScannedArtifacts {
  entries: ArtifactIndexEntry[]
  skipped: number
}

/**
 * Rebuild index entries directly from blobs. The layout is
 * `<root>/<first two hex>/<64-hex>`; the file name must equal SHA-256(bytes).
 * Symlinks and non-regular files are never followed.
 */
function scanArtifactFiles(root: string): ScannedArtifacts {
  const entries: ArtifactIndexEntry[] = []
  let skipped = 0
  let bucketNames: string[]
  try {
    bucketNames = readdirSync(root)
  } catch {
    return { entries, skipped }
  }
  for (const bucket of bucketNames) {
    if (!/^[a-f0-9]{2}$/.test(bucket)) continue
    let names: string[]
    try {
      names = readdirSync(join(root, bucket))
    } catch {
      continue
    }
    for (const name of names) {
      if (!HASH_PATTERN.test(name)) {
        skipped++
        continue
      }
      const path = join(root, bucket, name)
      try {
        const stat = lstatSync(path)
        if (!stat.isFile() || stat.isSymbolicLink()) {
          skipped++
          continue
        }
        const bytes = readFileSync(path)
        if (hashBytes(bytes) !== name) {
          skipped++
          continue
        }
        entries.push({
          hash: name,
          size: bytes.length,
          media_type: 'application/octet-stream',
          createdAt: Math.round(stat.mtimeMs),
        })
      } catch {
        skipped++
      }
    }
  }
  return { entries, skipped }
}

function mergeReindex(
  existing: readonly ArtifactIndexEntry[],
  scanned: readonly ArtifactIndexEntry[],
): ArtifactIndexEntry[] {
  const byHash = new Map<string, ArtifactIndexEntry>()
  for (const entry of scanned) byHash.set(entry.hash, entry)
  // Preserve metadata for blobs that are still present; content is the source
  // of truth for hash/size.
  for (const entry of existing) {
    const current = byHash.get(entry.hash)
    if (current === undefined) continue
    byHash.set(entry.hash, {
      hash: entry.hash,
      size: current.size,
      media_type: entry.media_type.length > 0 ? entry.media_type : current.media_type,
      ...(entry.name === undefined ? {} : { name: entry.name }),
      createdAt: entry.createdAt,
    })
  }
  return [...byHash.values()].sort((left, right) => right.createdAt - left.createdAt)
}

function writeIndexAtomic(file: string, entries: readonly ArtifactIndexEntry[]): void {
  mkdirSync(join(file, '..'), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, entries.map(entry => JSON.stringify(entry)).join('\n') + (entries.length > 0 ? '\n' : ''), 'utf8')
  renameSync(tmp, file)
}

function mergeIndex(entries: readonly ArtifactIndexEntry[]): ArtifactIndexEntry[] {
  const byHash = new Map<string, ArtifactIndexEntry>()
  for (const entry of entries) {
    const previous = byHash.get(entry.hash)
    const name = entry.name ?? previous?.name
    // Re-insert so map order follows the last occurrence of each hash.
    byHash.delete(entry.hash)
    byHash.set(entry.hash, {
      hash: entry.hash,
      size: entry.size,
      media_type: entry.media_type,
      ...(name === undefined ? {} : { name }),
      createdAt: entry.createdAt,
    })
  }
  return [...byHash.values()].reverse()
}

function appendIndex(file: string, entry: ArtifactIndexEntry): void {
  appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8')
}

function decodeText(data: Buffer, mediaType: string | undefined): string | undefined {
  if (mediaType !== undefined && mediaType.length > 0) {
    if (isTextMediaType(mediaType)) return tryDecodeUtf8(data)
    if (!isGenericBinaryMediaType(mediaType)) return undefined
  }
  return tryDecodeUtf8(data)
}

function isTextMediaType(mediaType: string): boolean {
  const lowered = mediaType.toLowerCase()
  return lowered.startsWith('text/')
    || lowered.includes('json')
    || lowered.includes('xml')
    || lowered.includes('javascript')
    || lowered.includes('ecmascript')
    || lowered.includes('yaml')
    || lowered.includes('toml')
    || lowered.includes('csv')
    || lowered.includes('markdown')
}

function isGenericBinaryMediaType(mediaType: string): boolean {
  const lowered = mediaType.toLowerCase()
  return lowered === 'application/octet-stream' || lowered === 'binary/octet-stream'
}

function tryDecodeUtf8(data: Buffer): string | undefined {
  // A NUL byte is a strong binary signal even when the bytes are valid UTF-8.
  if (data.includes(0)) return undefined
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data)
    return Buffer.from(text, 'utf8').equals(data) ? text : undefined
  } catch {
    return undefined
  }
}
