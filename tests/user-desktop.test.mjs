import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'
import { extractDesktop } from '../build/update-core.mjs'
import { detectUserDesktop, installUserDesktop, rollbackUserDesktop } from '../build/user-install.mjs'

const require = createRequire(new URL('../build/upstream/package.json', import.meta.url))
const tar = require('tar')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

async function fixture(t, version = '1.1.0') {
  const base = await fs.mkdtemp('/tmp/dsh-user-desktop-test-')
  t.after(() => fs.rm(base, { recursive: true, force: true }))
  const home = join(base, 'home')
  const root = join(home, 'Applications/dsh-linux-desktop')
  const input = join(base, 'input')
  const app = join(input, 'app')
  const runtime = join(app, 'resources/app/dsh')
  await fs.mkdir(home, { mode: 0o700 })
  const metadata = { version, protocol: 4, dataEpoch: 'test-epoch', desktopRange: '>=1 <3',
    nodeRange: '>=24 <25', kernelRange: '>=1 <2', nodeVersion: '24.21.0' }
  const files = {
    'dsh-workbench': 'mock desktop\n',
    'resources/app/package.json': JSON.stringify({ name: 'dsh-workbench', version }),
    'resources/app/workbench/desktop.json': JSON.stringify(metadata),
    'resources/runtime/primary-runtime/runtime.json': JSON.stringify({ platform: 'linux', arch: 'x64', node: '24.21.0' }),
    'resources/runtime/primary-runtime/dependencies/node/bin/node': 'mock node\n',
  }
  const sharedPackages = ['dsh', 'dsh-desktop-host'].map(name => ({ name: `@deepseek-ai/${name}`, version: '1.0.0', path: `node_modules/@deepseek-ai/${name}` }))
  const inventory = []
  for (const entry of sharedPackages) {
    const path = `${entry.path}/package.json`
    const bytes = Buffer.from(JSON.stringify({ name: entry.name, version: entry.version }))
    files[`resources/app/dsh/${path}`] = bytes
    inventory.push({ path, bytes: bytes.length, sha256: hash(bytes), executable: false })
  }
  files['resources/app/dsh/desktop-runtime.json'] = JSON.stringify({ schemaVersion: 1, platform: 'linux', arch: 'x64',
    release: { schemaVersion: 1, version: '1.0.0', hostProtocolVersion: 4, nodeVersion: '24.18.1', pnpmVersion: '11.7.0' },
    sharedPackages, files: inventory.sort((a, b) => a.path < b.path ? -1 : 1) })
  for (const [path, bytes] of Object.entries(files)) {
    const absolute = join(app, path)
    await fs.mkdir(join(absolute, '..'), { recursive: true, mode: 0o755 })
    await fs.writeFile(absolute, bytes, { mode: path === 'dsh-workbench' || path.endsWith('/bin/node') ? 0o755 : 0o644 })
  }
  const archive = join(base, 'desktop.tar.gz')
  await tar.c({ file: archive, cwd: input, gzip: true, portable: true }, ['app'])
  const options = { archive, sha256: hash(await fs.readFile(archive)), version, home, root, xdgDataHome: join(home, '.local/share') }
  return { base, app, home, root, archive, runtime, options }
}

test('user desktop installs in HOME, routes without system package detection and rolls back explicitly', async t => {
  const first = await fixture(t)
  const installed = await installUserDesktop(first.options)
  assert.equal(installed.version, '1.1.0')
  assert.equal((await fs.stat(installed.executable)).uid, process.getuid())
  assert.equal((await detectUserDesktop(installed.executable)).root, first.root)
  assert.equal(await detectUserDesktop(process.execPath), null)
  assert.match(await fs.readFile(join(first.home, '.local/bin/dsh-workbench'), 'utf8'), /current\/dsh-workbench/)
  const second = await fixture(t, '1.2.0')
  let restarted
  const upgraded = await installUserDesktop({ ...second.options, home: first.home, root: first.root,
    xdgDataHome: join(first.home, '.local/share'), restart: executable => { restarted = executable } })
  assert.equal(restarted, upgraded.executable)
  assert.notEqual(restarted, installed.executable)
  assert.equal(await rollbackUserDesktop({ root: first.root, home: first.home }), installed.executable)
  assert.ok(await fs.stat(upgraded.executable), 'previous releases are retained, not deleted')
})

test('wrong hashes, invalid identity and unsafe tar files cannot activate a user desktop', async t => {
  const f = await fixture(t)
  await assert.rejects(installUserDesktop({ ...f.options, sha256: '0'.repeat(64) }), /SHA-256/)
  await assert.rejects(fs.stat(f.root), { code: 'ENOENT' })
  await fs.writeFile(join(f.app, 'resources/app/package.json'), JSON.stringify({ name: 'other', version: '1.1.0' }))
  await tar.c({ file: f.archive, cwd: join(f.base, 'input'), gzip: true }, ['app'])
  await assert.rejects(installUserDesktop({ ...f.options, sha256: hash(await fs.readFile(f.archive)) }), /身份/)
  await assert.rejects(fs.stat(join(f.root, 'current')), { code: 'ENOENT' })
  await fs.symlink('/etc/passwd', join(f.app, 'escape'))
  await tar.c({ file: f.archive, cwd: join(f.base, 'input'), gzip: true }, ['app'])
  const destination = join(f.base, 'extracted')
  await fs.mkdir(destination)
  await assert.rejects(extractDesktop(f.archive, destination), /链接/)
  assert.deepEqual(await fs.readdir(destination), [])
})

test('cancellation and restart failure preserve the active desktop and user configuration', async t => {
  const first = await fixture(t)
  const installed = await installUserDesktop(first.options)
  const config = join(first.home, 'config.json')
  await fs.writeFile(config, 'user configuration\n')
  const next = await fixture(t, '1.2.0')
  const options = { ...next.options, home: first.home, root: first.root, xdgDataHome: join(first.home, '.local/share') }
  assert.equal(await installUserDesktop({ ...options, prepareRestart: async () => false }), null)
  assert.equal((await detectUserDesktop(installed.executable)).current, first.options.sha256)
  await assert.rejects(installUserDesktop({ ...options, restart: () => { throw new Error('restart failed') } }), /restart failed/)
  assert.equal((await detectUserDesktop(installed.executable)).current, first.options.sha256)
  assert.equal(await fs.readFile(config, 'utf8'), 'user configuration\n')
})

test('a canceled candidate cannot be reused after its executable bytes change', async t => {
  const first = await fixture(t)
  const installed = await installUserDesktop(first.options)
  const next = await fixture(t, '1.2.0')
  const options = { ...next.options, home: first.home, root: first.root, xdgDataHome: join(first.home, '.local/share') }
  assert.equal(await installUserDesktop({ ...options, prepareRestart: async () => false }), null)
  await fs.writeFile(join(first.root, 'versions', next.options.sha256, 'dsh-workbench'), 'changed desktop\n')
  await assert.rejects(installUserDesktop(options), /归档不一致/)
  assert.equal((await detectUserDesktop(installed.executable)).current, first.options.sha256)
})

test('an existing group-writable bin is accepted only behind a private user ancestor', async t => {
  const safe = await fixture(t)
  await fs.mkdir(join(safe.home, '.local'), { mode: 0o700 })
  await fs.mkdir(join(safe.home, '.local/bin'), { mode: 0o775 })
  await fs.chmod(join(safe.home, '.local/bin'), 0o775)
  await installUserDesktop(safe.options)
  assert.equal((await fs.stat(join(safe.home, '.local/bin'))).mode & 0o777, 0o775)
  const unsafe = await fixture(t)
  await fs.chmod(unsafe.base, 0o755)
  await fs.chmod(unsafe.home, 0o755)
  await fs.mkdir(join(unsafe.home, '.local'), { mode: 0o755 })
  await fs.mkdir(join(unsafe.home, '.local/bin'), { mode: 0o775 })
  await fs.chmod(join(unsafe.home, '.local/bin'), 0o775)
  await assert.rejects(installUserDesktop(unsafe.options), /私有上级目录/)
  await assert.rejects(fs.stat(join(unsafe.root, 'current')), { code: 'ENOENT' })
})

test('user installer refuses unrelated launchers and sealed runtime tampering', async t => {
  const f = await fixture(t)
  await fs.mkdir(join(f.home, '.local/bin'), { recursive: true })
  await fs.writeFile(join(f.home, '.local/bin/dsh-workbench'), 'user-owned command\n', { mode: 0o644 })
  await assert.rejects(installUserDesktop(f.options), /启动入口/)
  assert.equal(await fs.readFile(join(f.home, '.local/bin/dsh-workbench'), 'utf8'), 'user-owned command\n')
  await fs.rm(join(f.home, '.local/bin/dsh-workbench'))
  await fs.writeFile(join(f.runtime, 'node_modules/@deepseek-ai/dsh/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.0.1' }))
  await tar.c({ file: f.archive, cwd: join(f.base, 'input'), gzip: true }, ['app'])
  await assert.rejects(installUserDesktop({ ...f.options, sha256: hash(await fs.readFile(f.archive)) }), /metadata|integrity/)
})
