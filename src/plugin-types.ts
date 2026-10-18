/**
 * Minimal structural types for the DeepSeek Harness (dsh) plugin surface that
 * SuperDSH uses. They are intentionally local: dsh's public APIs are still
 * pre-stable, and keeping the contract here means the plugin has zero runtime
 * dependencies and can be loaded as a single ESM file.
 */

export interface UserMessageLike {
  id: string
  role: 'user'
  content: Array<{ type: 'text'; text: string } | { type: string; [key: string]: unknown }>
  source: { kind: string; [key: string]: unknown }
}

export interface AgentLike {
  session?: unknown
  followup(message: UserMessageLike): void
  inject?(message: UserMessageLike): void
}

export interface ToolExecutionLike {
  callId: string
  name: string
  arguments: unknown
  agent?: AgentLike
  signal: AbortSignal
}

export interface ToolResultLike {
  isError: boolean
  content?: unknown
  error?: { message?: string; code?: string }
  value?: unknown
}

export interface ToolDefinitionLike {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render(args: Record<string, unknown>, value: Record<string, unknown>): Array<{ type: 'text'; text: string }>
    presentationMeta?(args: Record<string, unknown>, value: Record<string, unknown>): Record<string, unknown>
  }
  execute(args: Record<string, unknown>, exec: ToolExecutionLike): Promise<Record<string, unknown>>
  presentCall?(args: Record<string, unknown>): Record<string, unknown>
  presentResult?(args: Record<string, unknown>, result: ToolResultLike): Record<string, unknown> | undefined
  isConcurrencySafe?(args: Record<string, unknown>): boolean
}

export interface PreStepDecisionLike {
  kind: 'enter' | 'reject' | string
  messages?: UserMessageLike[]
  [key: string]: unknown
}

/** The subset of the Cordis context that SuperDSH touches. */
export interface PluginContext {
  tools: {
    register(definition: ToolDefinitionLike): () => void
  }
  systemPrompt: {
    section(section: { name: string; order?: number; text: string | ((context: unknown) => string) }): () => void
  }
  fs: {
    resolve(path: string, options?: { cwd?: string; signal?: AbortSignal }): Promise<unknown>
    readText(target: unknown, signal?: AbortSignal): Promise<string>
    editText(
      target: unknown,
      edit: { oldString: string; newString: string; replaceAll: boolean },
      expected?: { version: unknown },
      signal?: AbortSignal,
      sandboxPolicy?: unknown,
    ): Promise<{ before: string; after: string; version: unknown }>
  }
  workingDirectory?: {
    ensure(agent: AgentLike, signal?: AbortSignal): Promise<string>
  }
  get?(service: string): unknown
  waterfall?(event: string, ...args: unknown[]): Promise<unknown>
  on(event: string, listener: (...args: any[]) => unknown): () => void
  logger?: {
    warn(message: string): void
    info?(message: string): void
  }
  effect?(callback: () => (() => void) | void, label?: string): void
}

export interface SuperDshConfig {
  /** Register the fuzzy_edit fallback tool. Default: true. */
  fuzzyEdit?: boolean
  /** Project memory store, tools, and automatic retrieval. Default: true. */
  memory?:
    | boolean
    | {
        dir?: string
        maxEntries?: number
        injectTopK?: number
        injectMaxChars?: number
      }
  /** Tamper-evident audit ledger and the audit_verify tool. Default: true. */
  audit?:
    | boolean
    | {
        dir?: string
      }
  /**
   * Verification gate: run a command when the agent tries to finish a turn in
   * which it mutated files, and feed failures back. Default: disabled.
   */
  verify?:
    | boolean
    | {
        command?: string
        timeoutMs?: number
        maxAttempts?: number
        cwd?: string
      }
}
