/**
 * Cold archive and retention for audit ledgers.
 *
 * The store uses a hot/cold split with gzip cold storage. Manifest file names
 * are whitelisted and contained, archive entries never escape their directory,
 * every archive is verified against the source SHA-256 before any source is
 * deleted, and one failed deletion is reported instead of being silently
 * swallowed.
 *
 * This module is opt-in: tools are only registered when `retention` is `true`
 * or a config object. The default source is the audit ledger directory.
 */

import { createHash, randomBytes } from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import type { PluginContext, SuperDshConfig, ToolDefinitionLike, ToolExecutionLike } from '../plugin-types.ts'
import { dshHome, warn } from '../shared.ts'
import { safeFileStem } from '../session-id.ts'

export interface RetentionEntry {
  /** Original file name inside the source directory, e.g. `session.jsonl`. */
  name: string
  /** Absolute source path at archive time. Advisory; restore always uses the manifest sourceDir. */
  source: string
  /** SHA-256 of the original, uncompressed bytes. */
  sha256: string
  /** SHA-256 of the gzip file bytes. */
  gzSha256: string
  bytes: number
  gzBytes: number
  /** Source mtime in epoch milliseconds. */
  mtime: number
}

export interface RetentionManifest {
  v: 1
  createdAt: string
  sourceDir: string
  entries: RetentionEntry[]
  deleted: boolean
}

interface RetentionOptions {
  dir?: string
  maxAgeDays?: number
  maxTotalBytes?: number
  deleteSource?: boolean
}

interface RawManifest {
  v: 1
  createdAt: unknown
  sourceDir: string
  entries: unknown[]
  deleted: boolean
}

const DEFAULT_MAX_AGE_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000
/** Upper bound for a single gunzip; also protects restore from decompression bombs. */
const MAX_DECOMPRESSED_BYTES = 256 * 1024 * 1024
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024
const MAX_MANIFEST_ENTRIES = 100_000
const HASH_PATTERN = /^[a-f0-9]{64}$/
/** `archive-<timestamp>-<random>.json`; no separators are possible. */
const MANIFEST_NAME = /^archive-[A-Za-z0-9][A-Za-z0-9._-]{0,150}\.json$/
const LEDGER_SUFFIX = '.jsonl'
const HEAD_SUFFIX = '.head'

export function applyRetention(ctx: PluginContext, config: SuperDshConfig = {}): void {
  const setting = config.retention
  if (setting !== true && (typeof setting !== 'object' || setting === null || Array.isArray(setting))) return
  const options: RetentionOptions = setting === true ? {} : setting

  const dir = resolve(
    typeof options.dir === 'string' && options.dir.length > 0
      ? options.dir
      : join(dshHome(), 'super-dsh', 'retention'),
  )
  const sourceDir = resolve(auditSourceDir(config))
  const maxAgeDays = validDays(options.maxAgeDays) ?? DEFAULT_MAX_AGE_DAYS
  const maxTotalBytes = positiveInteger(options.maxTotalBytes)
  const deleteSourceByDefault = options.deleteSource === true

  ctx.systemPrompt.section({
    name: 'super-dsh:retention',
    order: 132,
    text: 'Audit ledgers can be cold-archived with `archive_ledgers`: gzip files are written atomically, '
      + 'verified by SHA-256, and recorded in a manifest. `restore_archive` validates every archive before '
      + 'writing and never overwrites existing ledger files.',
  })

  const archiveTool: ToolDefinitionLike = {
    name: 'archive_ledgers',
    description: 'Cold-archive audit ledgers as gzip files plus a SHA-256 manifest. '
      + 'Selects *.jsonl files for one session (with a matching .head when present) or files older than '
      + 'older_than_days (default: the configured maxAgeDays, or 30). Every gzip is decompressed and verified '
      + 'before it is accepted. With delete_source, source files are removed only after a second verification; '
      + 'a failed deletion is reported as an error and the archive is kept.',
    parameters: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Archive only ledgers for this session (safeFileStem prefix/exact name). Age is ignored unless older_than_days is also given.',
        },
        older_than_days: {
          type: 'number',
          description: 'Archive ledgers whose modification time is older than this many days. Defaults to maxAgeDays or 30.',
        },
        delete_source: {
          type: 'boolean',
          description: 'Delete each source ledger after its archive has been verified twice. Config deleteSource:true has the same effect.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          manifest: { type: 'string', description: 'Absolute path of the archive manifest.' },
          archived: { type: 'integer', description: 'Number of files archived (ledger and .head files counted separately).' },
          bytes: { type: 'integer', description: 'Uncompressed bytes archived.' },
          deleted: { type: 'integer', description: 'Number of source files deleted.' },
          errors: { type: 'array', items: { type: 'string' } },
        },
        required: ['ok', 'manifest', 'archived', 'bytes', 'deleted'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const lines = [
          `Archived ${String(value.archived)} file(s), ${String(value.bytes)} bytes total. Manifest: ${String(value.manifest)}`,
        ]
        if (Number(value.deleted) > 0) lines.push(`Deleted ${String(value.deleted)} verified source file(s).`)
        const errors = Array.isArray(value.errors) ? value.errors as string[] : []
        if (errors.length > 0) lines.push(`Errors (${errors.length}):`, ...errors.slice(0, 8))
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe: () => false,
    async execute(rawArgs: Record<string, unknown>, _exec: ToolExecutionLike) {
      const sessionId = optionalSessionId(rawArgs.session_id)
      const explicitAge = rawArgs.older_than_days !== undefined
      const ageDays = explicitAge ? requireDays(rawArgs.older_than_days, 'older_than_days') : maxAgeDays
      if (rawArgs.delete_source !== undefined && typeof rawArgs.delete_source !== 'boolean') {
        throw new Error('delete_source must be a boolean')
      }
      const deleteSource = rawArgs.delete_source === true || deleteSourceByDefault

      const selected = selectLedgers(sourceDir, sessionId, ageDays, explicitAge)
      if (selected.length === 0) {
        throw new Error('No audit ledger files matched the retention selection.')
      }

      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const entries: RetentionEntry[] = []
      const errors: string[] = []
      let bytes = 0

      for (const ledger of selected) {
        const names = [ledger]
        const head = `${ledger}${HEAD_SUFFIX}`
        const headPath = contained(sourceDir, join(sourceDir, head))
        try {
          const headStat = lstatSync(headPath)
          if (headStat.isFile()) {
            names.push(head)
          } else {
            errors.push(`${head}: not a regular file; skipped`)
          }
        } catch (error: unknown) {
          if (!isMissing(error)) errors.push(`${head}: ${errorMessage(error)}`)
        }

        for (const name of names) {
          try {
            const entry = archiveOne(sourceDir, dir, name)
            entries.push(entry)
            bytes += entry.bytes
          } catch (error: unknown) {
            errors.push(`${name}: ${errorMessage(error)}`)
          }
        }
      }

      const manifest: RetentionManifest = {
        v: 1,
        createdAt: new Date().toISOString(),
        sourceDir,
        entries,
        deleted: false,
      }
      const manifestName = `archive-${archiveTimestamp()}-${randomBytes(6).toString('hex')}.json`
      const manifestPath = contained(dir, join(dir, manifestName))
      writeManifestAtomic(manifestPath, manifest)

      let deleted = 0
      let deleteFailures = 0
      if (deleteSource) {
        for (const entry of entries) {
          try {
            verifyArchiveFile(dir, entry)
            verifySourceUnchanged(sourceDir, entry)
            unlinkSync(entry.source)
            deleted++
          } catch (error: unknown) {
            deleteFailures++
            errors.push(`delete ${entry.name}: ${errorMessage(error)}`)
          }
        }
        manifest.deleted = entries.length > 0 && deleted === entries.length && deleteFailures === 0
        try {
          writeManifestAtomic(manifestPath, manifest)
        } catch (error: unknown) {
          errors.push(`manifest update failed: ${errorMessage(error)}`)
        }
      }

      if (maxTotalBytes !== undefined) {
        try {
          enforceArchiveCap(dir, maxTotalBytes, manifestPath, ctx.logger)
        } catch (error: unknown) {
          warn(ctx.logger, 'could not enforce the retention size cap', error)
        }
      }

      return {
        ok: errors.length === 0,
        manifest: manifestPath,
        archived: entries.length,
        bytes,
        deleted,
        ...(errors.length === 0 ? {} : { errors }),
      }
    },
  }

  const restoreTool: ToolDefinitionLike = {
    name: 'restore_archive',
    description: 'Restore ledger files from a manifest written by archive_ledgers. '
      + 'The manifest must be a file name inside the retention directory. Every gzip is checked against its '
      + 'recorded gzip hash and decompressed SHA-256 before anything is written; if any entry fails, nothing is '
      + 'restored. Existing files in the source directory are never overwritten and are reported as errors. '
      + 'With dry_run, only validation is performed.',
    parameters: {
      type: 'object',
      properties: {
        manifest: {
          type: 'string',
          description: 'Manifest file name inside the retention directory, e.g. archive-2026-01-01T00-00-00-000Z-ab12cd34ef56.json. Paths and absolute paths are rejected.',
        },
        dry_run: {
          type: 'boolean',
          description: 'Validate every archive and report integrity without writing files. Default: false.',
        },
      },
      required: ['manifest'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          restored: { type: 'integer' },
          skipped: { type: 'integer', description: 'Entries refused because the target already existed.' },
          errors: { type: 'array', items: { type: 'string' } },
        },
        required: ['ok', 'restored', 'skipped', 'errors'],
        additionalProperties: false,
      },
      render: (args, value) => {
        const errors = Array.isArray(value.errors) ? value.errors as string[] : []
        const lines = [args.dry_run === true
          ? `Dry run: archive integrity validated; no files written. Restored 0, skipped ${String(value.skipped)}.`
          : `Restored ${String(value.restored)} file(s), skipped ${String(value.skipped)} existing target(s).`]
        if (errors.length > 0) lines.push(`Errors (${errors.length}):`, ...errors.slice(0, 8))
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe: () => false,
    async execute(rawArgs: Record<string, unknown>) {
      if (typeof rawArgs.manifest !== 'string' || rawArgs.manifest.trim().length === 0) {
        throw new Error('manifest must be a non-empty manifest file name')
      }
      if (rawArgs.dry_run !== undefined && typeof rawArgs.dry_run !== 'boolean') {
        throw new Error('dry_run must be a boolean')
      }
      const dryRun = rawArgs.dry_run === true
      const manifestPath = resolveManifestPath(dir, rawArgs.manifest)
      const manifest = readManifest(manifestPath)
      const restoreDir = requireSourceDir(manifest.sourceDir)

      const prepared: Array<{ entry: RetentionEntry; data: Buffer; target: string }> = []
      const errors: string[] = []
      const seen = new Set<string>()
      for (let index = 0; index < manifest.entries.length; index++) {
        const raw = manifest.entries[index]
        try {
          const entry = validateEntry(raw)
          if (seen.has(entry.name)) throw new Error('duplicate entry name in manifest')
          seen.add(entry.name)
          const data = verifyArchiveFile(dir, entry)
          const target = contained(restoreDir, join(restoreDir, entry.name))
          prepared.push({ entry, data, target })
        } catch (error: unknown) {
          const name = raw !== null && typeof raw === 'object' && typeof (raw as { name?: unknown }).name === 'string'
            ? ` (${String((raw as { name: unknown }).name)})`
            : ''
          errors.push(`entry ${index}${name}: ${errorMessage(error)}`)
        }
      }

      // All-or-nothing preflight: never write a subset when an archive is bad.
      if (errors.length > 0) return { ok: false, restored: 0, skipped: 0, errors }
      if (dryRun) return { ok: true, restored: 0, skipped: 0, errors: [] }

      mkdirSync(restoreDir, { recursive: true, mode: 0o700 })
      let restored = 0
      let skipped = 0
      for (const item of prepared) {
        if (pathExists(item.target)) {
          skipped++
          errors.push(`${item.entry.name}: target already exists; not overwritten`)
          continue
        }
        try {
          // "wx" makes the no-overwrite check and the create one operation.
          writeFileSync(item.target, item.data, { flag: 'wx', mode: 0o600 })
          restored++
        } catch (error: unknown) {
          if (isCode(error, 'EEXIST')) {
            skipped++
            errors.push(`${item.entry.name}: target already exists; not overwritten`)
          } else {
            errors.push(`${item.entry.name}: ${errorMessage(error)}`)
            try {
              unlinkSync(item.target)
            } catch {
              // The target may not have been created.
            }
          }
        }
      }
      return { ok: errors.length === 0, restored, skipped, errors }
    },
  }

  try {
    ctx.tools.register(archiveTool)
    ctx.tools.register(restoreTool)
  } catch (error: unknown) {
    warn(ctx.logger, 'could not register retention tools', error)
  }
}

function auditSourceDir(config: SuperDshConfig): string {
  const audit = config.audit
  if (audit !== null && typeof audit === 'object' && !Array.isArray(audit)
    && typeof audit.dir === 'string' && audit.dir.length > 0) {
    return audit.dir
  }
  return join(dshHome(), 'super-dsh', 'audit')
}

/** Names of ledgers eligible for this run. Old files or one session's ledgers. */
function selectLedgers(
  sourceDir: string,
  sessionId: string | undefined,
  ageDays: number,
  explicitAge: boolean,
): string[] {
  let dirents
  try {
    dirents = readdirSync(sourceDir, { withFileTypes: true })
  } catch (error: unknown) {
    throw new Error(`cannot read audit source directory ${sourceDir}: ${errorMessage(error)}`)
  }
  const cutoff = Date.now() - ageDays * DAY_MS
  const stem = sessionId === undefined ? undefined : safeFileStem(sessionId)
  const selected: string[] = []
  for (const dirent of dirents) {
    if (!dirent.isFile() || !dirent.name.endsWith(LEDGER_SUFFIX)) continue
    if (stem !== undefined && !matchesSession(dirent.name.slice(0, -LEDGER_SUFFIX.length), stem)) continue
    // A session-targeted run ignores age unless older_than_days was explicit.
    if (stem !== undefined && !explicitAge) {
      selected.push(dirent.name)
      continue
    }
    let stat
    try {
      stat = lstatSync(join(sourceDir, dirent.name))
    } catch {
      continue
    }
    if (stat.isFile() && stat.mtimeMs < cutoff) selected.push(dirent.name)
  }
  return selected.sort()
}

function matchesSession(stem: string, safeStem: string): boolean {
  return stem === safeStem || stem.startsWith(`${safeStem}-`) || stem.startsWith(`${safeStem}.`)
}

function archiveOne(sourceDir: string, archiveDir: string, name: string): RetentionEntry {
  if (safeEntryName(name) === undefined) throw new Error('unsupported ledger file name')
  const source = contained(sourceDir, join(sourceDir, name))
  const stat = lstatSync(source)
  if (!stat.isFile()) throw new Error('source is not a regular file')

  const data = readFileSync(source)
  const digest = sha256Bytes(data)
  const compressed = gzipSync(data)
  const roundTrip = gunzipSync(compressed, { maxOutputLength: MAX_DECOMPRESSED_BYTES })
  if (sha256Bytes(roundTrip) !== digest) throw new Error('gzip verification failed before write')

  const target = contained(archiveDir, join(archiveDir, `${name}.gz`))
  assertReplaceableArchive(target)
  writeFileAtomic(target, compressed)

  // Read the committed file back: this is the same check deletion relies on.
  let written: Buffer
  try {
    written = readFileSync(target)
    if (sha256Bytes(written) !== sha256Bytes(compressed)) throw new Error('archive hash differs after write')
    const readBack = gunzipSync(written, { maxOutputLength: MAX_DECOMPRESSED_BYTES })
    if (readBack.length !== data.length || sha256Bytes(readBack) !== digest) {
      throw new Error('archive read-back verification failed')
    }
  } catch (error: unknown) {
    try {
      unlinkSync(target)
    } catch {
      // The target may not exist or may be locked.
    }
    throw error
  }

  return {
    name,
    source,
    sha256: digest,
    gzSha256: sha256Bytes(written),
    bytes: data.length,
    gzBytes: written.length,
    mtime: stat.mtimeMs,
  }
}

function verifyArchiveFile(archiveDir: string, entry: RetentionEntry): Buffer {
  const file = contained(archiveDir, join(archiveDir, `${entry.name}.gz`))
  const stat = lstatSync(file)
  if (!stat.isFile()) throw new Error('archive is not a regular file')
  const compressed = readFileSync(file)
  if (sha256Bytes(compressed) !== entry.gzSha256) throw new Error('archive gzip hash mismatch')
  const plain = gunzipSync(compressed, { maxOutputLength: MAX_DECOMPRESSED_BYTES })
  if (plain.length !== entry.bytes) throw new Error('archive size mismatch')
  if (sha256Bytes(plain) !== entry.sha256) throw new Error('archive content hash mismatch')
  return plain
}

function verifySourceUnchanged(sourceDir: string, entry: RetentionEntry): void {
  const source = contained(sourceDir, entry.source)
  const stat = lstatSync(source)
  if (!stat.isFile()) throw new Error('source is no longer a regular file')
  if (stat.size !== entry.bytes) throw new Error('source changed after it was archived')
  const data = readFileSync(source)
  if (sha256Bytes(data) !== entry.sha256) throw new Error('source changed after it was archived')
}

function writeManifestAtomic(file: string, manifest: RetentionManifest): void {
  writeFileAtomic(file, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'))
}

function writeFileAtomic(file: string, data: Buffer): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(tmp, data, { mode: 0o600 })
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

function assertReplaceableArchive(target: string): void {
  try {
    const stat = lstatSync(target)
    if (!stat.isFile()) throw new Error('archive target exists and is not a regular file')
  } catch (error: unknown) {
    if (!isMissing(error)) throw error
  }
}

function resolveManifestPath(dir: string, input: string): string {
  const value = input.trim()
  if (value.length === 0) throw new Error('manifest must be a non-empty file name')
  if (value.includes('\0')) throw new Error('manifest contains an invalid character')
  if (isAbsolute(value) || value.includes('/') || value.includes('\\')) {
    throw new Error('manifest must be a file name inside the retention directory')
  }
  if (value === '.' || value === '..') throw new Error('manifest must be a file name')
  if (!MANIFEST_NAME.test(value)) throw new Error('manifest must match archive-<timestamp>-<random>.json')
  const target = contained(dir, resolve(dir, value))
  if (target === resolve(dir)) throw new Error('manifest must be a file inside the retention directory')
  return target
}

function readManifest(file: string): RawManifest {
  let stat
  try {
    stat = lstatSync(file)
  } catch (error: unknown) {
    throw new Error(`cannot read archive manifest: ${errorMessage(error)}`)
  }
  if (!stat.isFile()) throw new Error('archive manifest is not a regular file')
  if (stat.size > MAX_MANIFEST_BYTES) throw new Error('archive manifest is too large')

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error: unknown) {
    throw new Error(`invalid archive manifest: ${errorMessage(error)}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid archive manifest: expected an object')
  }
  const record = parsed as Record<string, unknown>
  if (record.v !== 1) throw new Error('invalid archive manifest: unsupported version')
  if (typeof record.sourceDir !== 'string') throw new Error('invalid archive manifest: sourceDir is missing')
  if (!Array.isArray(record.entries)) throw new Error('invalid archive manifest: entries is missing')
  if (record.entries.length > MAX_MANIFEST_ENTRIES) throw new Error('invalid archive manifest: too many entries')
  return {
    v: 1,
    createdAt: record.createdAt,
    sourceDir: record.sourceDir,
    entries: record.entries,
    deleted: record.deleted === true,
  }
}

function requireSourceDir(value: string): string {
  if (value.includes('\0')) throw new Error('manifest sourceDir contains an invalid character')
  if (!isAbsolute(value)) throw new Error('manifest sourceDir must be an absolute path')
  return resolve(value)
}

function validateEntry(raw: unknown): RetentionEntry {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('entry is not an object')
  const entry = raw as Record<string, unknown>
  const name = safeEntryName(entry.name)
  if (name === undefined) throw new Error('entry name is not a safe ledger file name')
  if (typeof entry.source !== 'string') throw new Error('entry source is not a string')
  if (typeof entry.sha256 !== 'string' || !HASH_PATTERN.test(entry.sha256)) {
    throw new Error('entry sha256 is not a lowercase SHA-256 digest')
  }
  if (typeof entry.gzSha256 !== 'string' || !HASH_PATTERN.test(entry.gzSha256)) {
    throw new Error('entry gzSha256 is not a lowercase SHA-256 digest')
  }
  if (!isNonNegativeInteger(entry.bytes)) throw new Error('entry bytes is invalid')
  if (!isNonNegativeInteger(entry.gzBytes)) throw new Error('entry gzBytes is invalid')
  if (typeof entry.mtime !== 'number' || !Number.isFinite(entry.mtime)) throw new Error('entry mtime is invalid')
  return {
    name,
    source: entry.source,
    sha256: entry.sha256,
    gzSha256: entry.gzSha256,
    bytes: entry.bytes,
    gzBytes: entry.gzBytes,
    mtime: entry.mtime,
  }
}

function safeEntryName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  if (value.length === 0 || value.length > 255) return undefined
  if (value.includes('\0') || value.includes('/') || value.includes('\\')) return undefined
  if (value === '.' || value === '..' || isAbsolute(value)) return undefined
  if (!value.endsWith(LEDGER_SUFFIX) && !value.endsWith(`${LEDGER_SUFFIX}${HEAD_SUFFIX}`)) return undefined
  return value
}

/**
 * Best-effort `maxTotalBytes` enforcement: delete the oldest archive manifest
 * groups (manifest plus its gzip files, unless a surviving manifest still
 * references them). The manifest created by the current run is never pruned.
 */
function enforceArchiveCap(
  dir: string,
  maxTotalBytes: number,
  keepManifest: string,
  logger?: { warn(message: string): void },
): void {
  const keep = resolve(keepManifest)
  const sizes = new Map<string, number>()
  let total = 0
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.jsonl.gz') && !name.endsWith('.jsonl.head.gz') && !MANIFEST_NAME.test(name)) continue
    const path = resolve(dir, name)
    try {
      const stat = lstatSync(path)
      if (!stat.isFile()) continue
      sizes.set(path, stat.size)
      total += stat.size
    } catch {
      // A racing or locked file is simply not counted.
    }
  }
  if (total <= maxTotalBytes) return

  const manifests: Array<{ path: string; size: number; names: string[]; sort: number }> = []
  for (const [path, size] of sizes) {
    const name = basename(path)
    if (!MANIFEST_NAME.test(name)) continue
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { createdAt?: unknown; entries?: unknown }
      const names: string[] = []
      if (Array.isArray(parsed.entries)) {
        for (const raw of parsed.entries) {
          if (raw === null || typeof raw !== 'object') continue
          const entryName = safeEntryName((raw as { name?: unknown }).name)
          if (entryName !== undefined) names.push(entryName)
        }
      }
      let createdAt = Number.NaN
      if (typeof parsed.createdAt === 'string') createdAt = Date.parse(parsed.createdAt)
      else if (typeof parsed.createdAt === 'number') createdAt = parsed.createdAt
      let mtime = 0
      try {
        mtime = lstatSync(path).mtimeMs
      } catch {
        // Fall back to createdAt only.
      }
      manifests.push({ path, size, names, sort: Number.isFinite(createdAt) ? createdAt : mtime })
    } catch {
      // Malformed manifests are left alone rather than deleting unknown data.
    }
  }
  manifests.sort((a, b) => a.sort - b.sort)

  const references = new Map<string, number>()
  for (const manifest of manifests) {
    for (const name of manifest.names) {
      const gz = `${name}.gz`
      references.set(gz, (references.get(gz) ?? 0) + 1)
    }
  }

  for (const manifest of manifests) {
    if (total <= maxTotalBytes) break
    if (manifest.path === keep) continue
    try {
      unlinkSync(manifest.path)
      total -= manifest.size
      sizes.delete(manifest.path)
    } catch (error: unknown) {
      warn(logger, 'could not prune an old archive manifest', error)
      continue
    }
    for (const name of manifest.names) {
      const gz = `${name}.gz`
      const count = (references.get(gz) ?? 0) - 1
      if (count > 0) {
        references.set(gz, count)
        continue
      }
      references.delete(gz)
      const gzPath = resolve(dir, gz)
      const size = sizes.get(gzPath)
      if (size === undefined) continue
      try {
        const stat = lstatSync(gzPath)
        if (!stat.isFile()) continue
        unlinkSync(gzPath)
        sizes.delete(gzPath)
        total -= size
      } catch (error: unknown) {
        warn(logger, 'could not prune an old archive file', error)
      }
    }
  }
}

function optionalSessionId(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) throw new Error('session_id must be a non-empty string')
  return value
}

function requireDays(value: unknown, label: string): number {
  const days = validDays(value)
  if (days === undefined) throw new Error(`${label} must be a non-negative number of days`)
  return days
}

function validDays(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error: unknown) {
    return !isMissing(error)
  }
}

function contained(base: string, target: string): string {
  const root = resolve(base)
  const absolute = resolve(target)
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`
  if (absolute !== root && !absolute.startsWith(prefix)) {
    throw new Error(`path escapes ${root}: ${absolute}`)
  }
  return absolute
}

function sha256Bytes(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function archiveTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function isMissing(error: unknown): boolean {
  return isCode(error, 'ENOENT')
}

function isCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === 'object' && (error as { code?: unknown }).code === code
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
