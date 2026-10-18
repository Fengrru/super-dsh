/**
 * End-to-end packaging smoke: pack the published file set, install the tarball
 * into an isolated dsh profile with `dsh plugin add`, and assert that the
 * composed profile contains the SuperDSH entry. No model call is made.
 *
 * Run: bun run smoke:install
 * Optional: DSH_VERSION=0.2.1-rc.2 to pin a different published dsh.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const DSH_VERSION = process.env.DSH_VERSION ?? '0.2.1-rc.2'
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
const temp = mkdtempSync(join(tmpdir(), 'super-dsh-install-smoke-'))
const dshHome = join(temp, 'dsh-home')
const packDir = join(temp, 'pack')

function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  return execFileSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    timeout: 240_000,
  })
}

function findTarball(): string {
  const names = readdirSync(packDir).filter(name => name.endsWith('.tgz'))
  if (names.length !== 1) throw new Error(`expected one tarball in ${packDir}, found ${names.length}`)
  return join(packDir, names[0]!)
}

try {
  mkdirSync(packDir, { recursive: true })
  console.log(`packing ${ROOT}`)
  run(npm, ['pack', '--ignore-scripts', '--pack-destination', packDir])
  const tarball = findTarball()
  if (!existsSync(join(ROOT, 'dist', 'index.js'))) {
    throw new Error('dist/index.js is missing; run `bun run build` first')
  }

  console.log(`installing ${tarball} with dsh ${DSH_VERSION}`)
  run(npx, ['-y', `@deepseek-ai/dsh@${DSH_VERSION}`, 'plugin', '--profile', 'headless', 'add', tarball], {
    cwd: temp,
    env: { DSH_HOME: dshHome },
  })

  const config = run(npx, ['-y', `@deepseek-ai/dsh@${DSH_VERSION}`, '--profile', 'headless', '--dump-config'], {
    cwd: temp,
    env: { DSH_HOME: dshHome },
  })
  if (!config.includes('id: super-dsh') || !config.includes('name: dsh-super')) {
    throw new Error('installed profile does not contain the SuperDSH plugin entry')
  }

  console.log('install smoke passed: tarball installed and profile contains id: super-dsh')
} finally {
  rmSync(temp, { recursive: true, force: true })
}
