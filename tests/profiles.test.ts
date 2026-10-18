/**
 * Profile resolution checks: the profile selects a default feature group, and
 * explicit feature flags override it in both directions. These tests only
 * register tools on a fake context; no event is emitted and nothing is written
 * to disk.
 *
 * Run: bun test tests/profiles.test.ts
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.ts'
import type { SuperDshConfig } from '../src/plugin-types.ts'
import { fakeContext } from './fake-context.ts'

const CORE_TOOLS = [
  'apply_patch',
  'artifact_get',
  'artifact_list',
  'artifact_put',
  'artifact_reindex',
  'artifact_verify',
  'audit_evidence',
  'audit_export',
  'audit_verify',
  'effect_reconcile',
  'effect_resolve',
  'effect_status',
  'fuzzy_edit',
  'memory_consolidate',
  'memory_export',
  'memory_feedback',
  'memory_forget',
  'memory_import',
  'memory_invalidate',
  'memory_save',
  'memory_search',
  'repair_list',
  'repair_record',
  'repair_search',
].sort()

const CODING_EXTRA_TOOLS = [
  'find_symbol',
  'handoff',
  'history_compact',
  'impact_of',
  'knowledge_add',
  'knowledge_forget',
  'knowledge_history',
  'knowledge_search',
  'knowledge_verify',
  'note_append',
  'note_compact',
  'note_read',
  'reflect',
  'replay_plan',
  'repo_map',
  'search_code',
].sort()

const CODING_TOOLS = [...CORE_TOOLS, ...CODING_EXTRA_TOOLS].sort()

const FULL_EXTRA_TOOLS = [
  'archive_ledgers',
  'budget_status',
  'restore_archive',
  'verify',
].sort()

const FULL_TOOLS = [...CODING_TOOLS, ...FULL_EXTRA_TOOLS].sort()

const REPO_MAP_TOOLS = ['find_symbol', 'impact_of', 'repo_map', 'search_code'].sort()

function registered(config: SuperDshConfig): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'super-dsh-profiles-'))
  const fake = fakeContext({ workingDirectory: dir })
  apply(fake.ctx, config)
  return [...fake.tools.keys()].sort()
}

describe('profiles', () => {
  test('core registers exactly the core surface (24 tools)', () => {
    const names = registered({ profile: 'core' })
    expect(names).toHaveLength(24)
    expect(names).toEqual(CORE_TOOLS)
  })

  test('coding adds repo, notes, knowledge, and session tooling (40 tools)', () => {
    const names = registered({ profile: 'coding' })
    expect(names).toHaveLength(40)
    expect(names).toEqual(CODING_TOOLS)
    // The coding extra is exactly the 16 tools listed above.
    expect(names.filter(name => CORE_TOOLS.includes(name))).toEqual(CORE_TOOLS)
    expect(names.filter(name => !CORE_TOOLS.includes(name))).toEqual(CODING_EXTRA_TOOLS)
  })

  test('full with verify, budget, and retention configs registers 44 tools', () => {
    const names = registered({
      profile: 'full',
      verify: { command: 'node -e "process.exit(0)"' },
      budget: { maxTokens: 1000 },
      retention: { maxAgeDays: 30 },
    })
    expect(names).toHaveLength(44)
    expect(names).toEqual(FULL_TOOLS)
  })

  test('defaults to the core profile when no profile is configured', () => {
    expect(registered({})).toEqual(CORE_TOOLS)
  })

  test('full without operational configs stays at the coding surface (40 tools)', () => {
    const names = registered({ profile: 'full' })
    expect(names).toHaveLength(40)
    expect(names).toEqual(CODING_TOOLS)
    expect(names).not.toContain('verify')
    expect(names).not.toContain('budget_status')
    expect(names).not.toContain('archive_ledgers')
  })

  test('explicit repoMap: true enables the repo map tools in core', () => {
    const names = registered({ profile: 'core', repoMap: true })
    expect(names).toHaveLength(CORE_TOOLS.length + REPO_MAP_TOOLS.length)
    expect(names).toEqual([...CORE_TOOLS, ...REPO_MAP_TOOLS].sort())
  })

  test('memory: false disables memory tools in coding', () => {
    const names = registered({ profile: 'coding', memory: false })
    const memoryTools = names.filter(name => name.startsWith('memory_'))
    expect(memoryTools).toEqual([])
    expect(names).toHaveLength(CODING_TOOLS.length - 8)
    expect(names).toEqual(CODING_TOOLS.filter(name => !name.startsWith('memory_')))
  })

  test('an options object counts as an explicit enable outside the profile', () => {
    const names = registered({ profile: 'core', notes: { maxEntriesPerSession: 10 } })
    expect(names).toEqual([...CORE_TOOLS, 'note_append', 'note_compact', 'note_read'].sort())
  })

  test('explicit flags override the profile in both directions', () => {
    const enabled = registered({ profile: 'core', knowledge: true })
    expect(enabled).toContain('knowledge_add')
    expect(enabled).toContain('knowledge_search')

    const disabled = registered({ profile: 'coding', knowledge: false })
    expect(disabled).not.toContain('knowledge_add')
    expect(disabled).toHaveLength(CODING_TOOLS.length - 5)

    const operationalOff = registered({
      profile: 'full',
      verify: false,
      budget: false,
      retention: false,
    })
    expect(operationalOff).toEqual(CODING_TOOLS)
  })
})
