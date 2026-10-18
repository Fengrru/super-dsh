/**
 * Small helpers shared by SuperDSH features: home/workspace paths, canonical
 * JSON, and a user message factory that matches dsh's runtime shape without
 * importing dsh at runtime.
 */

import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { UserMessageLike } from './plugin-types.ts'

/** dsh's Harness home, honoring the same DSH_HOME override as the host. */
export function dshHome(): string {
  return process.env.DSH_HOME && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
}

/** Resolve the Session's current working directory, falling back to the host cwd. */
export async function sessionCwd(
  ctx: { workingDirectory?: { ensure(agent: unknown, signal?: AbortSignal): Promise<string> } },
  agent: unknown,
  signal?: AbortSignal,
): Promise<string> {
  if (agent !== undefined) {
    try {
      const service = ctx.workingDirectory
      if (service !== undefined) return await service.ensure(agent, signal)
    } catch {
      // Fall through to the process default.
    }
  }
  return process.env.SUPER_DSH_WORKSPACE ?? process.cwd()
}

/** Stable id for the current workspace; keeps per-project state separate. */
export function workspaceKey(workspace = process.env.SUPER_DSH_WORKSPACE ?? process.cwd()): string {
  return createHash('sha256').update(resolve(workspace)).digest('hex').slice(0, 16)
}

export function workspacePath(): string {
  return resolve(process.env.SUPER_DSH_WORKSPACE ?? process.cwd())
}

/** Deterministic JSON: sorted object keys, no whitespace. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) {
      const next = source[key]
      if (next !== undefined) out[key] = sortValue(next)
    }
    return out
  }
  return value
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** Build a user-role message that dsh can persist and project to the model. */
export function userMessage(text: string): UserMessageLike {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

/** Extract plain text from a dsh user-message batch. */
export function messageText(messages: readonly unknown[] | undefined): string {
  if (!Array.isArray(messages)) return ''
  const parts: string[] = []
  for (const message of messages) {
    const content = (message as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block !== null && typeof block === 'object' && (block as { type?: string }).type === 'text') {
        const text = (block as { text?: unknown }).text
        if (typeof text === 'string') parts.push(text)
      }
    }
  }
  return parts.join('\n')
}

/** Rough token estimate used only for budget caps. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** Log a contained feature failure without breaking the host. */
export function warn(logger: PluginContextLogger | undefined, message: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error)
  try {
    logger?.warn(`super-dsh: ${message}: ${detail}`)
  } catch {
    // A logger failure must never break the harness.
  }
}

export interface PluginContextLogger {
  warn(message: string): void
}
