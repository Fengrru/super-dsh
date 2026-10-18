/**
 * Shared fake Cordis context for deterministic feature tests.
 * No model calls, no network, no real filesystem unless a test injects one.
 */

import type { PluginContext, ToolDefinitionLike } from '../src/plugin-types.ts'

export interface FakeContextOptions {
  fs?: Partial<PluginContext['fs']>
  services?: Record<string, unknown>
  workingDirectory?: string
}

export interface FakeContext {
  ctx: PluginContext
  tools: Map<string, ToolDefinitionLike>
  sections: Array<{ name: string; text: unknown }>
  handlers: Map<string, Array<(...args: any[]) => any>>
  emit(event: string, ...args: unknown[]): Promise<unknown[]>
}

export function fakeContext(options: FakeContextOptions = {}): FakeContext {
  const tools = new Map<string, ToolDefinitionLike>()
  const sections: Array<{ name: string; text: unknown }> = []
  const handlers = new Map<string, Array<(...args: any[]) => any>>()
  const services = new Map<string, unknown>(Object.entries(options.services ?? {}))

  const ctx = {
    tools: {
      register(definition: ToolDefinitionLike) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    systemPrompt: {
      section(section: { name: string; text: unknown }) {
        sections.push(section)
        return () => {}
      },
    },
    fs: {
      resolve: async (path: string) => ({ displayPath: path, targetKey: path }),
      readText: async () => '',
      editText: async () => ({ before: '', after: '', version: 1 }),
      writeText: async () => ({ operation: 'update', version: 1 }),
      ...options.fs,
    },
    ...(options.workingDirectory === undefined
      ? {}
      : { workingDirectory: { ensure: async () => options.workingDirectory } }),
    get(service: string) {
      return services.get(service)
    },
    waterfall: async (_event: string, ..._args: unknown[]) => undefined,
    on(event: string, listener: (...args: any[]) => any) {
      const list = handlers.get(event) ?? []
      list.push(listener)
      handlers.set(event, list)
      return () => {}
    },
    logger: { warn() {}, info() {} },
  } as unknown as PluginContext

  return {
    ctx,
    tools,
    sections,
    handlers,
    async emit(event, ...args) {
      const results: unknown[] = []
      for (const handler of handlers.get(event) ?? []) results.push(await handler(...args))
      return results
    },
  }
}

export function exec(overrides: Record<string, unknown> = {}) {
  return {
    callId: 'call-1',
    name: 'test',
    arguments: {},
    signal: new AbortController().signal,
    ...overrides,
  }
}

export function execWithAgent(agent: unknown, overrides: Record<string, unknown> = {}) {
  return exec({ agent, ...overrides })
}
