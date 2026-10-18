/**
 * Verification gate: the turn does not finish after file mutations until a
 * configured command passes, with failures fed back to the agent.
 *
 * This closes the most common failure mode in coding agents: reporting success
 * after an edit without running the project's tests. It also implements the
 * "verify the external world, not the agent's self-report" invariant.
 */

import { spawn } from 'node:child_process'
import type { AgentLike, PluginContext, SuperDshConfig, ToolDefinitionLike, ToolExecutionLike } from '../plugin-types.ts'
import { sessionCwd, userMessage, warn } from '../shared.ts'

interface VerifyState {
  mutated: boolean
  attempts: number
  lastAttemptAt: number
  running: boolean
}

interface VerifyResult {
  ok: boolean
  exitCode: number | null
  durationMs: number
  output: string
  timedOut: boolean
}

const MUTATING_TOOLS = new Set(['write', 'edit', 'fuzzy_edit', 'str_replace_editor'])
const VERIFY_MARKER = '[super-dsh verify]'

export function applyVerify(ctx: PluginContext, config: SuperDshConfig): void {
  const options = typeof config.verify === 'object' ? config.verify : {}
  const command = options.command ?? process.env.SUPER_DSH_VERIFY_COMMAND
  if (command === undefined || command.trim().length === 0) {
    warn(ctx.logger, 'verify is enabled but no command is configured; feature disabled', new Error('missing command'))
    return
  }
  const timeoutMs = options.timeoutMs ?? 120_000
  const maxAttempts = options.maxAttempts ?? 2
  const states = new WeakMap<AgentLike, VerifyState>()

  const commandCwd = async (agent: AgentLike | undefined, signal?: AbortSignal): Promise<string> => {
    return options.cwd ?? await sessionCwd(ctx, agent, signal)
  }

  ctx.systemPrompt.section({
    name: 'super-dsh:verify',
    order: 144,
    text: `This project has a verification gate. When you try to finish a turn after changing files, `
      + '`' + command + '` runs automatically; failures come back to you as the next instruction. '
      + 'You may also call `verify` yourself before claiming success.',
  })

  const verifyTool: ToolDefinitionLike = {
    name: 'verify',
    description: 'Run the configured project verification command and return exit status, duration, and output tail.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          exit_code: { type: 'integer' },
          duration_ms: { type: 'integer' },
          output_tail: { type: 'string' },
        },
        required: ['ok', 'exit_code', 'duration_ms', 'output_tail'],
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.ok === true ? 'PASS' : 'FAIL'} (exit ${String(value.exit_code)}, ${String(value.duration_ms)}ms)\n`
          + String(value.output_tail).slice(-2000),
      }],
    },
    async execute(_args: Record<string, unknown>, exec: ToolExecutionLike) {
      const result = await runVerify(command, await commandCwd(exec.agent, exec.signal), timeoutMs)
      return {
        ok: result.ok,
        exit_code: result.exitCode ?? -1,
        duration_ms: result.durationMs,
        output_tail: result.output.slice(-4000),
      }
    },
  }

  try {
    ctx.tools.register(verifyTool)
  } catch (error: unknown) {
    warn(ctx.logger, 'could not register verify', error)
  }

  ctx.on('tools/result', (exec: { name?: string }, result: { isError?: boolean }) => {
    if (result.isError === true) return
    if (exec.name === undefined || !MUTATING_TOOLS.has(exec.name)) return
    const agent = (exec as { agent?: AgentLike }).agent
    if (agent === undefined) return
    stateFor(states, agent).mutated = true
  })

  ctx.on('agent/pre-step', async (payload: { agent: AgentLike; messages?: unknown[]; step?: number }, next: () => Promise<unknown>) => {
    const decision = await next() as { kind?: string; messages?: unknown[] }
    if (decision.kind !== 'enter') return decision
    const step = typeof payload.step === 'number' ? payload.step : 0
    if (step > 1) return decision
    const text = extractText(payload.messages)
    if (text.includes(VERIFY_MARKER)) return decision
    const state = states.get(payload.agent)
    if (state !== undefined) state.attempts = 0
    return decision
  })

  ctx.on('agent/turn-stopping', async (payload: { agent: AgentLike; turn?: number; signal?: AbortSignal }) => {
    const state = stateFor(states, payload.agent)
    if (!state.mutated || state.running) return
    if (Date.now() - state.lastAttemptAt > 300_000) state.attempts = 0
    if (state.attempts >= maxAttempts) {
      ctx.logger?.warn(`super-dsh: verification still failing after ${maxAttempts} attempts; allowing the turn to finish`)
      return
    }

    state.running = true
    state.lastAttemptAt = Date.now()
    try {
      const result = await runVerify(command, await commandCwd(payload.agent, payload.signal), timeoutMs)
      if (result.ok) {
        state.mutated = false
        state.attempts = 0
        ctx.logger?.info?.(`super-dsh: verification passed in ${result.durationMs}ms`)
        return
      }
      state.attempts++
      if (state.attempts >= maxAttempts) {
        ctx.logger?.warn(`super-dsh: verification failed on the final allowed attempt; letting the agent report the failure`)
      }
      payload.agent.followup(userMessage(
        `${VERIFY_MARKER} The verification command failed before this turn could finish `
          + `(attempt ${state.attempts}/${maxAttempts}, exit ${result.exitCode ?? 'timeout'}).\n\n`
          + `Command: ${command}\n\nOutput (tail):\n${result.output.slice(-4000) || '(no output)'}\n\n`
          + 'Fix the underlying problem, then try to finish again. Do not claim the task is done until verification passes.',
      ))
    } catch (error: unknown) {
      warn(ctx.logger, 'verification gate failed to run', error)
    } finally {
      state.running = false
    }
  })
}

function stateFor(states: WeakMap<AgentLike, VerifyState>, agent: AgentLike): VerifyState {
  let state = states.get(agent)
  if (state === undefined) {
    state = { mutated: false, attempts: 0, lastAttemptAt: 0, running: false }
    states.set(agent, state)
  }
  return state
}

function extractText(messages: unknown[] | undefined): string {
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

function runVerify(command: string, cwd: string, timeoutMs: number): Promise<VerifyResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    let output = ''
    let timedOut = false
    const isWindows = process.platform === 'win32'
    const child = spawn(command, {
      cwd,
      shell: true,
      env: process.env,
      windowsHide: true,
      detached: !isWindows,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const capture = (chunk: Buffer): void => {
      output += chunk.toString('utf8')
      if (output.length > 100_000) output = output.slice(-100_000)
    }
    child.stdout?.on('data', capture)
    child.stderr?.on('data', capture)

    const timer = setTimeout(() => {
      timedOut = true
      if (isWindows && child.pid !== undefined) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      } else {
        try {
          process.kill(-(child.pid ?? 0), 'SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
      }
    }, timeoutMs)

    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        ok: !timedOut && code === 0,
        exitCode: code,
        durationMs: Date.now() - started,
        output,
        timedOut,
      })
    })
  })
}
