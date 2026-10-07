import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const cli = fileURLToPath(new URL('../build/install-user.mjs', import.meta.url))

test('user installer rejects missing trust, ambiguous actions and unknown arguments before writing', async t => {
  const directory = await fs.mkdtemp('/tmp/dsh-user-cli-test-')
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const archive = join(directory, 'desktop.tar.gz')
  const root = join(directory, 'installation')
  await fs.writeFile(archive, 'not a desktop archive')
  const base = ['--archive', archive, '--version', '1.0.0', '--root', root]
  for (const args of [
    base,
    [...base, '--sha256', 'invalid'],
    [...base, '--sha256', '0'.repeat(64), '--rollback'],
    [...base, '--sha256', '0'.repeat(64), '--unexpected'],
    [...base, '--sha256', '0'.repeat(64), 'unexpected-positional'],
  ]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, HOME: directory, XDG_DATA_HOME: join(directory, 'data') } })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Usage:|Unknown option|Unexpected argument/)
    await assert.rejects(fs.stat(root), { code: 'ENOENT' })
  }
})

test('user installer verifies archive bytes before creating an installation', async t => {
  const directory = await fs.mkdtemp('/tmp/dsh-user-cli-hash-test-')
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const archive = join(directory, 'desktop.tar.gz')
  const root = join(directory, 'installation')
  await fs.writeFile(archive, 'not a desktop archive')
  const result = spawnSync(process.execPath, [cli, '--archive', archive, '--sha256', '0'.repeat(64),
    '--version', '1.0.0', '--root', root], { encoding: 'utf8', env: { ...process.env, HOME: directory, XDG_DATA_HOME: join(directory, 'data') } })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /摘要|SHA|hash|checksum/iu)
  await assert.rejects(fs.stat(root), { code: 'ENOENT' })
})
