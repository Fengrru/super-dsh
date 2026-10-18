/**
 * Real kill-9 artifact recovery:
 * 1. a child writes a valid content-addressed blob but no index entry;
 * 2. the parent kills it with taskkill /F /T or SIGKILL;
 * 3. a new process reads the blob by hash, verifies it, reindexes, and lists it.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dir, '..')
const src = pathToFileURL(join(root, 'src', 'features', 'artifacts.ts')).href
const tests = pathToFileURL(join(root, 'tests', 'fake-context.ts')).href
const temp = mkdtempSync(join(tmpdir(), 'super-dsh-kill9-artifacts-'))
const artifactDir = join(temp, 'artifacts')
const content = 'artifact crash survivor'
const hash = createHash('sha256').update(content).digest('hex')
const childPath = join(temp, 'child.ts')
writeFileSync(childPath, `
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { applyArtifacts } from ${JSON.stringify(src)}
import { fakeContext, exec } from ${JSON.stringify(tests)}
const [mode, root] = process.argv.slice(2)
const fake = fakeContext()
applyArtifacts(fake.ctx, { artifacts: { dir: root } })
if (mode === 'write') {
  const hash = process.argv[4]
  const path = join(root, hash.slice(0, 2), hash)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, process.argv[5], 'utf8')
  console.log('READY ' + hash)
  await new Promise(resolve => setTimeout(resolve, 30000))
} else {
  const hash = process.argv[4]
  const get = await fake.tools.get('artifact_get').execute({ hash }, exec())
  const verify = await fake.tools.get('artifact_verify').execute({ hash }, exec())
  const reindex = await fake.tools.get('artifact_reindex').execute({}, exec())
  const list = await fake.tools.get('artifact_list').execute({}, exec())
  console.log(JSON.stringify({ get, verify, reindex, list }))
}
`, 'utf8')

function killTree(pid: number): void {
  if (process.platform === 'win32') {
    Bun.spawn(['taskkill', '/pid', String(pid), '/T', '/F'], { stdout: 'ignore', stderr: 'ignore' })
  } else {
    try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
  }
}

async function main(): Promise<void> {
  const env = { ...process.env, DSH_HOME: join(temp, 'dsh-home') }
  const writer = Bun.spawn([process.execPath, childPath, 'write', artifactDir, hash, content], {
    env, stdout: 'pipe', stderr: 'pipe', cwd: temp,
  })
  const reader = writer.stdout.getReader()
  let ready = false
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    if (new TextDecoder().decode(value).includes('READY')) { ready = true; break }
  }
  if (!ready) throw new Error('writer child did not become ready')
  killTree(writer.pid)
  const writerExit = await writer.exited
  reader.releaseLock()

  const verifier = Bun.spawn([process.execPath, childPath, 'verify', artifactDir, hash], {
    env, stdout: 'pipe', stderr: 'pipe', cwd: temp,
  })
  const output = await new Response(verifier.stdout).text()
  const verifierExit = await verifier.exited
  const parsed = JSON.parse(output.trim().split(/\r?\n/).filter(Boolean).pop() ?? '{}') as {
    get?: { content?: string }
    verify?: { ok?: boolean }
    reindex?: { indexed?: number }
    list?: { count?: number }
  }
  const result = {
    experiment: 'kill9-artifacts',
    generatedAt: new Date().toISOString(),
    hash,
    writerExit,
    verifierExit,
    getContent: parsed.get?.content,
    verifyOk: parsed.verify?.ok === true,
    reindexed: parsed.reindex?.indexed ?? 0,
    listed: parsed.list?.count ?? 0,
    ok: parsed.get?.content === content
      && parsed.verify?.ok === true
      && (parsed.reindex?.indexed ?? 0) >= 1
      && (parsed.list?.count ?? 0) >= 1,
  }
  const resultsDir = join(import.meta.dir, 'results')
  mkdirSync(resultsDir, { recursive: true })
  writeFileSync(join(resultsDir, 'kill9-artifacts.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  console.log(`writer exit ${writerExit}; verifier exit ${verifierExit}`)
  console.log(`get=${result.getContent === content} verify=${result.verifyOk} reindexed=${result.reindexed} listed=${result.listed} ok=${result.ok}`)
  rmSync(temp, { recursive: true, force: true })
  if (!result.ok) process.exitCode = 1
}

await main()
