import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { materializePythonAliases } from '../electron-builder.config.mjs'

function verifyArchive(directory) {
  const script = [
    'import io, pathlib, runpy, sys, tarfile',
    'policy = runpy.run_path(sys.argv[1])["archive_entry"]',
    'root = pathlib.Path(sys.argv[2])',
    'with tarfile.open(fileobj=io.BytesIO(), mode="w") as archive:',
    ' for path in [root, *sorted(root.rglob("*"))]:',
    '  policy(archive.gettarinfo(str(path), arcname=str(path.relative_to(root.parent))))',
  ].join('\n')
  return execFileSync('python3', ['-c', script, join(import.meta.dirname, '../scripts/build.py'), directory], { stdio: 'pipe' })
}

async function fixture(t) {
  const root = await fs.mkdtemp('/tmp/dsh-python-alias-test-')
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const bin = join(root, 'resources/runtime/primary-runtime/dependencies/python/bin')
  await fs.mkdir(bin, { recursive: true })
  const bytes = Buffer.from('locked interpreter fixture')
  await fs.writeFile(join(bin, 'python3.12'), bytes, { mode: 0o755 })
  for (const alias of ['python', 'python3']) await fs.symlink('python3.12', join(bin, alias))
  return { root, bin, bytes }
}

test('deployment Python aliases become independent executable files with identical bytes', async t => {
  const { root, bin, bytes } = await fixture(t)
  assert.throws(() => verifyArchive(root), /Desktop archive cannot contain links or special files/)
  materializePythonAliases(root)
  verifyArchive(root)
  const inodes = new Set()
  for (const name of ['python', 'python3', 'python3.12']) {
    const path = join(bin, name), stat = await fs.lstat(path)
    assert.ok(stat.isFile() && !stat.isSymbolicLink())
    assert.equal(stat.nlink, 1)
    assert.equal(stat.mode & 0o777, 0o755)
    assert.deepEqual(await fs.readFile(path), bytes)
    inodes.add(stat.ino)
  }
  assert.equal(inodes.size, 3)
  materializePythonAliases(root)
  assert.deepEqual((await fs.readdir(bin)).sort(), ['python', 'python3', 'python3.12'])
})

for (const target of ['/tmp/python3.12', '../bin/python3.12', 'python3', 'python3.11', './python3.12']) {
  test('rejects noncanonical alias target ' + target + ' before replacing either alias', async t => {
    const { root, bin } = await fixture(t)
    await fs.unlink(join(bin, 'python3'))
    await fs.symlink(target, join(bin, 'python3'))
    assert.throws(() => materializePythonAliases(root), /must point directly/)
    assert.equal(await fs.readlink(join(bin, 'python')), 'python3.12')
    assert.equal(await fs.readlink(join(bin, 'python3')), target)
  })
}

test('rejects a linked interpreter rather than following it', async t => {
  const { root, bin } = await fixture(t)
  await fs.rename(join(bin, 'python3.12'), join(bin, 'other'))
  await fs.symlink('other', join(bin, 'python3.12'))
  assert.throws(() => materializePythonAliases(root), /unsupported symbolic link/)
  assert.equal(await fs.readlink(join(bin, 'python')), 'python3.12')
})

test('rejects unknown links anywhere in the deployment tree before conversion', async t => {
  const { root, bin } = await fixture(t)
  await fs.symlink('/tmp', join(root, 'untrusted-directory'))
  assert.throws(() => materializePythonAliases(root), /unsupported symbolic link/)
  assert.equal(await fs.readlink(join(bin, 'python')), 'python3.12')
})

test('rejects a symlinked staging root', async t => {
  const { root } = await fixture(t)
  const link = root + '-link'
  t.after(() => fs.unlink(link))
  await fs.symlink(root, link)
  assert.throws(() => materializePythonAliases(link), /physical directory/)
})

test('rejects a non-executable target', async t => {
  const { root, bin } = await fixture(t)
  await fs.chmod(join(bin, 'python3.12'), 0o644)
  assert.throws(() => materializePythonAliases(root), /executable regular file/)
})

test('rejects different regular alias bytes without replacing the other alias', async t => {
  const { root, bin } = await fixture(t)
  await fs.unlink(join(bin, 'python3'))
  await fs.writeFile(join(bin, 'python3'), 'unexpected')
  assert.throws(() => materializePythonAliases(root), /does not match/)
  assert.equal(await fs.readlink(join(bin, 'python')), 'python3.12')
})

test('rejects a directory alias before replacing either alias', async t => {
  const { root, bin } = await fixture(t)
  await fs.unlink(join(bin, 'python3'))
  await fs.mkdir(join(bin, 'python3'))
  assert.throws(() => materializePythonAliases(root), /does not match/)
  assert.equal(await fs.readlink(join(bin, 'python')), 'python3.12')
})

test('the unchanged archive guard still rejects unknown symlinks and hard links', async t => {
  const { root, bin } = await fixture(t)
  materializePythonAliases(root)
  await fs.symlink('resources', join(root, 'unknown'))
  assert.throws(() => verifyArchive(root), /Desktop archive cannot contain links or special files/)
  await fs.unlink(join(root, 'unknown'))
  await fs.link(join(bin, 'python3.12'), join(root, 'hard-link'))
  assert.throws(() => verifyArchive(root), /Desktop archive cannot contain links or special files/)
})

test('rejects a FIFO interpreter without blocking an isolated packaging process', async t => {
  const { root, bin } = await fixture(t)
  await fs.unlink(join(bin, 'python3.12'))
  execFileSync('mkfifo', [join(bin, 'python3.12')])
  const module = new URL('../electron-builder.config.mjs', import.meta.url).href
  const script = 'import { materializePythonAliases } from ' + JSON.stringify(module) + '; materializePythonAliases(process.argv[1])'
  // Importing the packaging module from a busy build disk also counts against this deadline.
  assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '-e', script, root], { timeout: 10_000, killSignal: 'SIGKILL', stdio: 'pipe' }),
    error => error.status === 1 && /special file|executable regular file/.test(String(error.stderr)))
  for (const alias of ['python', 'python3']) assert.equal(await fs.readlink(join(bin, alias)), 'python3.12')
})

test('rejects unrelated special files before converting aliases', async t => {
  const { root, bin } = await fixture(t)
  execFileSync('mkfifo', [join(root, 'unknown-pipe')])
  assert.throws(() => materializePythonAliases(root), /special file/)
  for (const alias of ['python', 'python3']) assert.equal(await fs.readlink(join(bin, alias)), 'python3.12')
  assert.throws(() => verifyArchive(root), /Desktop archive cannot contain links or special files/)
})
