/**
 * Extract stable identities from dsh agent/session handles without importing
 * dsh runtime types.
 */

import type { AgentLike } from './plugin-types.ts'

export function sessionIdOf(agent: AgentLike | undefined): string | undefined {
  const session = agent?.session as { id?: unknown } | undefined
  return session !== undefined && typeof session.id === 'string' && session.id.length > 0
    ? session.id
    : undefined
}

export function agentIdOf(agent: AgentLike | undefined): string | undefined {
  const id = (agent as { id?: unknown } | undefined)?.id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

export function stableAgentKey(agent: AgentLike | undefined): string {
  return sessionIdOf(agent) ?? agentIdOf(agent) ?? 'anonymous-session'
}

/** Sanitize a session id for use as one file name component. */
export function safeFileStem(value: string, maxLength = 80): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, maxLength)
  return cleaned.length === 0 ? 'session' : cleaned
}
