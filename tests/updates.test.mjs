import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import fsSync from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { UpdateManager, checkCompatibility, extractKernel, inventory, verifyFeed, verifyKernelTree } from '../build/update-core.mjs'

const require = createRequire(new URL('../build/upstream/package.json', import.meta.url))
const tar = require('tar')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const keys = generateKeyPairSync('ed25519')
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' })
const metadata = { version: '1.0.0', protocol: 4, dataEpoch: 'schema-1', desktopRange: '>=1.0.0 <3', nodeRange: '>=24 <25' }
function signed(release, privateKey = keys.privateKey) {
  const payload = Buffer.from(JSON.stringify(release))
  return { payload: payload.toString('base64'), signature: sign(null, payload, privateKey).toString('base64') }
}
async function fixture(t, changes = {}) {
  const root = await fs.mkdtemp('/tmp/dsh-updates-test-')
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const payload = join(root, 'payload')
  for (const directory of ['dsh', 'runtime/bin']) await fs.mkdir(join(payload, directory), { recursive: true })
  await fs.writeFile(join(payload, 'dsh/entry.js'), 'kernel entry\n')
  await fs.writeFile(join(payload, 'runtime/bin/node'), 'runtime\n', { mode: 0o755 })
  const kernel = { schemaVersion: 1, channel: 'kernel', platform: 'linux', arch: 'x64', ...metadata, version: '1.1.0', ...changes }
  const manifest = Buffer.from(JSON.stringify({ ...kernel, files: await inventory(payload) }) + '\n')
  await fs.writeFile(join(payload, 'kernel.json'), manifest)
  const archive = join(root, 'kernel.tgz')
  await tar.c({ gzip: true, cwd: payload, file: archive }, ['kernel.json', 'dsh', 'runtime'])
  const bytes = await fs.readFile(archive)
  const release = { ...kernel, manifestSha256: sha(manifest), asset: { url: 'https://updates.test/kernel.tgz', sha256: sha(bytes), size: bytes.length } }
  const envelope = signed(release)
  const responses = new Map([
    ['https://updates.test/kernel.json', Buffer.from(JSON.stringify(envelope))],
    [release.asset.url, bytes],
  ])
  let verified = 0, probes = 0
  const options = {
    root: join(root, 'user-updates'), config: { kernel: { url: 'https://updates.test/kernel.json', publicKey },
      desktop: { url: 'https://updates.test/desktop.json', publicKey } },
    desktop: { ...metadata, nodeVersion: '24.18.1' }, bundled: { ...metadata, dsh: '/bundled/dsh', runtime: '/bundled/runtime' },
    verifyKernel: async () => { verified++ }, probeKernel: async () => { probes++ },
    fetch: async (url, request) => {
      assert.equal(request.redirect, 'error')
      if (!responses.has(url)) return new Response('not found', { status: 404 })
      return new Response(responses.get(url))
    },
  }
  const manager = new UpdateManager(options)
  await manager.boot()
  return { root, payload, archive, release, envelope, responses, options, manager,
    counts: () => ({ verified, probes }) }
}

async function wholeDesktopFixture(t, archiveChanges = {}) {
  const f = await fixture(t)
  const home = join(f.root, 'home')
  const input = join(f.root, 'whole-input')
  const app = join(input, 'app')
  const metadata = { version: '2.0.0', linuxRevision: 2, protocol: 4, dataEpoch: 'schema-2',
    desktopRange: '>=2 <3', kernelRange: '>=2 <3', nodeRange: '>=24 <25', nodeVersion: '24.18.1', electronVersion: '41.0.0' }
  const runtime = []
  const files = {
    'dsh-workbench': '#!/bin/sh\nprintf "v41.0.0\\n"\n',
    'resources/app/package.json': JSON.stringify({ name: 'dsh-workbench', version: '2.0.0', linuxRevision: 2 }),
    'resources/app/workbench/desktop.json': JSON.stringify({ ...metadata, ...archiveChanges }),
    'resources/runtime/primary-runtime/runtime.json': JSON.stringify({ platform: 'linux', arch: 'x64', node: '24.18.1' }),
    'resources/runtime/primary-runtime/dependencies/node/bin/node': '#!/bin/sh\nprintf "v24.18.1\\n"\n',
  }
  const sharedPackages = ['dsh', 'dsh-desktop-host'].map(name => ({ name: `@deepseek-ai/${name}`, version: '2.0.0', path: `node_modules/@deepseek-ai/${name}` }))
  for (const entry of sharedPackages) {
    const path = `${entry.path}/package.json`
    const bytes = Buffer.from(JSON.stringify({ name: entry.name, version: entry.version }))
    files[`resources/app/dsh/${path}`] = bytes
    runtime.push({ path, bytes: bytes.length, sha256: sha(bytes), executable: false })
  }
  files['resources/app/dsh/desktop-runtime.json'] = JSON.stringify({ schemaVersion: 1, platform: 'linux', arch: 'x64',
    release: { schemaVersion: 1, version: '2.0.0', hostProtocolVersion: 4, nodeVersion: '24.18.1', pnpmVersion: '11.7.0' },
    sharedPackages, files: runtime.sort((a, b) => a.path < b.path ? -1 : 1) })
  for (const [path, bytes] of Object.entries(files)) {
    await fs.mkdir(join(app, path, '..'), { recursive: true, mode: 0o700 })
    await fs.writeFile(join(app, path), bytes, { mode: path === 'dsh-workbench' || path.endsWith('/bin/node') ? 0o700 : 0o600 })
  }
  const archive = join(f.root, 'whole.tar.gz')
  await tar.c({ file: archive, cwd: input, gzip: true, portable: true }, ['app'])
  const bytes = await fs.readFile(archive)
  const release = { ...metadata, schemaVersion: 2, channel: 'desktop', platform: 'linux', arch: 'x64', format: 'tar.gz',
    asset: { url: 'https://updates.test/whole.tar.gz', sha256: sha(bytes), size: bytes.length } }
  f.options.config.desktopUpgrade = { url: 'https://updates.test/whole.json', publicKey }
  f.responses.set('https://updates.test/whole.json', Buffer.from(JSON.stringify(signed(release))))
  f.responses.set(release.asset.url, bytes)
  const request = { home, root: join(home, 'Applications/dsh-linux-desktop'), dshHome: join(home, '.dsh'),
    userData: join(home, '.config/dsh-workbench'), xdgDataHome: join(home, '.local/share'), oldExecutable: process.execPath,
    node: process.execPath, workerPath: fileURLToPath(new URL('../build/upstream/apps/desktop/lib/workbench-migration-worker.mjs', import.meta.url)) }
  for (const path of [request.home, request.dshHome, request.userData]) await fs.mkdir(path, { recursive: true, mode: 0o700 })
  return { ...f, request }
}

test('offline signing tool emits a verifiable complete kernel archive without publishing', async t => {
  const f = await fixture(t)
  await fs.writeFile(join(f.payload, 'dsh/desktop-runtime.json'), JSON.stringify({ release: { version: '1.1.0', hostProtocolVersion: 4 } }))
  const key = join(f.root, 'signing.pem')
  await fs.writeFile(key, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  const config = join(f.root, 'desktop.json')
  await fs.writeFile(config, JSON.stringify(metadata))
  const output = join(f.root, 'release')
  const args = [fileURLToPath(new URL('../build/release-updates.mjs', import.meta.url)), 'kernel', '--input', f.payload,
    '--output', output, '--key', key, '--metadata', config, '--base-url', 'https://updates.test/']
  execFileSync(process.execPath, args, { stdio: 'pipe' })
  const envelope = JSON.parse(await fs.readFile(join(output, 'kernel-latest.json'), 'utf8'))
  const release = verifyFeed(envelope, publicKey, 'kernel')
  assert.equal(release.version, '1.1.0')
  const extracted = join(f.root, 'release-extracted')
  await fs.mkdir(extracted)
  await extractKernel(join(output, 'dsh-kernel-1.1.0-linux-x64.tgz'), extracted)
  await verifyKernelTree(extracted, release)
  assert.throws(() => execFileSync(process.execPath, args, { stdio: 'pipe' }), /Command failed/)
})

test('bounded extraction worker preserves verification and rejects unsafe members', async t => {
  const f = await fixture(t)
  const output = join(f.root, 'worker-output')
  await fs.mkdir(output)
  const worker = fileURLToPath(new URL('../build/upstream/apps/desktop/lib/workbench-archive.mjs', import.meta.url))
  execFileSync(process.execPath, ['--max-old-space-size=256', worker, f.archive, output], { stdio: 'pipe' })
  await verifyKernelTree(output, f.release)
  await fs.symlink('/etc/passwd', join(f.payload, 'dsh/escape'))
  const malicious = join(f.root, 'malicious.tgz')
  await tar.c({ gzip: true, file: malicious, cwd: f.payload }, ['dsh'])
  assert.throws(() => execFileSync(process.execPath, [worker, malicious, output], { stdio: 'pipe' }), /Command failed/)
  await assert.rejects(fs.lstat(join(output, 'dsh/escape')), { code: 'ENOENT' })
})

test('signed kernel trial, atomic activation, healthy commit and desktop reinstall preserve newer kernel', async t => {
  const f = await fixture(t)
  await f.manager.check('kernel')
  assert.equal(f.manager.status().kernel.available, '1.1.0')
  let restarted = 0
  await f.manager.installKernel(async () => true, () => { restarted++ })
  assert.equal(restarted, 1)
  assert.equal(f.counts().probes, 1)
  assert.equal(f.manager.selected.version, '1.0.0', 'running process keeps its old immutable kernel')
  const boot = new UpdateManager(f.options)
  assert.equal((await boot.boot()).version, '1.1.0')
  await boot.markHealthy()
  const upgradedDesktop = new UpdateManager({ ...f.options, desktop: { ...f.options.desktop, version: '1.2.0' } })
  assert.equal((await upgradedDesktop.boot()).version, '1.1.0')
  const reinstalledDesktop = new UpdateManager(f.options)
  assert.equal((await reinstalledDesktop.boot()).version, '1.1.0')
})

test('full desktop epoch upgrade preserves old pointers but starts only its bundled kernel', async t => {
  const f = await fixture(t)
  await f.manager.check('kernel')
  await f.manager.installKernel(async () => true, () => {})
  const old = new UpdateManager(f.options)
  await old.boot()
  await old.markHealthy()
  const before = await fs.readFile(join(f.options.root, 'state.json'), 'utf8')
  const options = { ...f.options,
    desktop: { ...f.options.desktop, version: '2.0.0', dataEpoch: 'schema-2' },
    bundled: { ...f.options.bundled, version: '2.0.0', dataEpoch: 'schema-2' },
    verifyKernel: async () => assert.fail('the superseded tree must never execute'),
  }
  const upgraded = new UpdateManager(options)
  assert.equal((await upgraded.boot()).version, '2.0.0')
  assert.match(upgraded.notice, /数据备份/)
  assert.equal(await fs.readFile(join(f.options.root, 'state.json'), 'utf8'), before)
  assert.equal(await fs.readFile(join(f.options.root, 'kernels', f.release.asset.sha256, 'dsh/entry.js'), 'utf8'), 'kernel entry\n')
  await assert.rejects(upgraded.readKernel(f.release.asset.sha256), /不兼容/)
  for (const version of ['1.0.0', '1.1.0']) {
    await assert.rejects(new UpdateManager({ ...options, bundled: { ...options.bundled, version } }).boot(), /不兼容/)
  }
  const mismatched = signed({ ...f.release, asset: { ...f.release.asset, sha256: 'a'.repeat(64) } })
  await fs.writeFile(join(f.options.root, 'kernels', f.release.asset.sha256, 'release.json'), JSON.stringify(mismatched))
  await assert.rejects(new UpdateManager(options).boot(), /摘要不一致/)
  const invalid = signed(f.release, generateKeyPairSync('ed25519').privateKey)
  await fs.writeFile(join(f.options.root, 'kernels', f.release.asset.sha256, 'release.json'), JSON.stringify(invalid))
  await assert.rejects(new UpdateManager(options).boot(), /签名/)
})

test('full desktop epoch upgrade retains the normal pending trial recovery lifecycle', async t => {
  for (const pending of ['staged', 'booting']) {
    await t.test(pending, async t => {
      const f = await fixture(t)
      await f.manager.check('kernel')
      await f.manager.installKernel(async () => true, () => {})
      if (pending === 'booting') await new UpdateManager(f.options).boot()
      const options = { ...f.options,
        desktop: { ...f.options.desktop, version: '2.0.0', dataEpoch: 'schema-2' },
        bundled: { ...f.options.bundled, version: '2.0.0', dataEpoch: 'schema-2' },
        verifyKernel: async () => assert.fail('pending old-epoch tree must never execute'),
      }
      const upgraded = new UpdateManager(options)
      assert.equal((await upgraded.boot()).version, '2.0.0')
      assert.equal(upgraded.state.active, pending === 'staged' ? f.release.asset.sha256 : null)
      assert.equal(upgraded.state.pending, pending === 'staged' ? 'booting' : null)
      const interrupted = new UpdateManager(options)
      assert.equal((await interrupted.boot()).version, '2.0.0')
      assert.deepEqual(interrupted.state, { schemaVersion: 1, active: null, previous: null, pending: null })
      upgraded.state = { schemaVersion: 1, active: null, previous: f.release.asset.sha256, pending: 'booting' }
      assert.equal(await upgraded.rollback(), true)
      assert.equal(upgraded.selected.version, '2.0.0')
      assert.deepEqual(upgraded.state, { schemaVersion: 1, active: f.release.asset.sha256, previous: null, pending: null })
      assert.equal(await fs.readFile(join(f.options.root, 'kernels', f.release.asset.sha256, 'dsh/entry.js'), 'utf8'), 'kernel entry\n')
    })
  }
})

test('process crash before health acknowledgement restores previous kernel on the next launch', async t => {
  const f = await fixture(t)
  await f.manager.check('kernel')
  await f.manager.installKernel(async () => true, () => {})
  const attempt = new UpdateManager(f.options)
  await attempt.boot()
  assert.equal(attempt.selected.version, '1.1.0')
  const recovered = new UpdateManager(f.options)
  assert.equal((await recovered.boot()).version, '1.0.0')
  assert.match(recovered.notice, /启动中断/)
  assert.equal(recovered.state.pending, null)
})

test('a failed second kernel boot restores the last installed kernel, not the bundled baseline', async t => {
  const first = await fixture(t)
  await first.manager.check('kernel')
  await first.manager.installKernel(async () => true, () => {})
  const current = new UpdateManager(first.options)
  await current.boot()
  await current.markHealthy()
  const next = await fixture(t, { version: '1.2.0' })
  current.fetch = next.options.fetch
  await current.check('kernel')
  await current.installKernel(async () => true, () => {})
  const attempt = new UpdateManager(first.options)
  await attempt.boot()
  assert.equal(attempt.selected.version, '1.2.0')
  assert.equal(await attempt.rollback(), true)
  assert.equal(attempt.selected.version, '1.1.0')
  assert.equal((await new UpdateManager(first.options).boot()).version, '1.1.0')
})

test('signature failure, wrong protocol, incompatible Node and data epoch are refused before download', async t => {
  const f = await fixture(t)
  const wrongKey = generateKeyPairSync('ed25519').privateKey
  assert.throws(() => verifyFeed(signed(f.release, wrongKey), publicKey, 'kernel'), /签名/)
  assert.throws(() => verifyFeed(f.envelope, publicKey, 'desktop'), /元数据/)
  for (const change of [{ protocol: 5 }, { dataEpoch: 'breaking-schema' }, { nodeRange: '>=26' }, { desktopRange: '>=5' }]) {
    assert.throws(() => checkCompatibility({ ...f.release, ...change }, f.options.desktop), /不兼容/)
  }
  f.responses.set('https://updates.test/kernel.json', Buffer.from(JSON.stringify(signed({ ...f.release, protocol: 5 }))))
  await assert.rejects(f.manager.check('kernel'), /不兼容/)
  assert.equal(f.manager.status().kernel.available, null)
})

test('a new data epoch blocks both OTA channels before activation', async t => {
  const f = await fixture(t)
  const before = JSON.stringify(f.manager.state)
  const kernel = { ...f.release, dataEpoch: 'next-epoch' }
  const desktop = { ...kernel, schemaVersion: 2, channel: 'desktop', format: 'tar.gz',
    linuxRevision: 1, version: '1.2.0', nodeVersion: '24.18.1', kernelRange: '>=1 <2' }
  for (const [channel, release] of [['kernel', kernel], ['desktop', desktop]]) {
    f.responses.set(`https://updates.test/${channel}.json`, Buffer.from(JSON.stringify(signed(release))))
    await assert.rejects(f.manager.check(channel), /不兼容.*完整桌面升级/)
    assert.equal(f.manager.status()[channel].available, null)
    assert.equal(f.manager.status()[channel].crossEpoch, true)
    assert.equal(JSON.stringify(f.manager.state), before)
  }
})

test('explicit whole desktop checking admits a signed next epoch without changing the running identity', async t => {
  const f = await fixture(t)
  f.options.config.desktopUpgrade = { url: 'https://updates.test/whole.json', publicKey }
  const release = { ...f.release, schemaVersion: 2, channel: 'desktop', format: 'tar.gz',
    version: '2.0.0', linuxRevision: 1, protocol: 5, dataEpoch: 'schema-2',
    desktopRange: '>=2 <3', kernelRange: '>=2 <3', nodeRange: '>=26 <27',
    nodeVersion: '26.0.0', electronVersion: '42.0.0' }
  const envelope = signed(release)
  f.responses.set('https://updates.test/desktop.json', Buffer.from(JSON.stringify(envelope)))
  f.responses.set('https://updates.test/whole.json', Buffer.from(JSON.stringify(envelope)))
  const before = JSON.stringify({ desktop: f.manager.desktop, selected: f.manager.selected, state: f.manager.state })
  await assert.rejects(f.manager.check('desktop'), /不兼容/)
  assert.equal(f.manager.status().desktop.available, null)
  const result = await f.manager.checkWholeDesktopUpgrade()
  assert.equal(result.desktopUpgrade.available, '2.0.0')
  assert.equal(result.desktopUpgrade.availableLinuxRevision, 1)
  assert.equal(result.desktopUpgrade.configured, true)
  assert.equal(JSON.stringify({ desktop: f.manager.desktop, selected: f.manager.selected, state: f.manager.state }), before)
  for (const bad of [signed(release, generateKeyPairSync('ed25519').privateKey),
    { ...envelope, payload: Buffer.from(JSON.stringify({ ...release, dataEpoch: 'tampered' })).toString('base64') },
    signed({ ...release, nodeRange: '>=24 <25' }), signed({ ...release, electronVersion: undefined }),
    signed({ ...release, kernelRange: '>=1 <2' })]) {
    f.responses.set('https://updates.test/whole.json', Buffer.from(JSON.stringify(bad)))
    await assert.rejects(f.manager.checkWholeDesktopUpgrade(), /签名|运行时/)
    assert.equal(f.manager.status().desktopUpgrade.available, null)
  }
})

test('whole desktop install revalidates its signature before download or Host preparation', async t => {
  const f = await fixture(t)
  f.options.config.desktopUpgrade = { url: 'https://updates.test/whole.json', publicKey }
  const release = { ...f.release, schemaVersion: 2, channel: 'desktop', format: 'tar.gz',
    version: '2.0.0', linuxRevision: 1, dataEpoch: 'schema-2', nodeVersion: '24.18.1',
    kernelRange: '>=2 <3', electronVersion: '41.0.0' }
  f.responses.set('https://updates.test/whole.json', Buffer.from(JSON.stringify(signed(release))))
  await f.manager.checkWholeDesktopUpgrade()
  f.options.config.desktopUpgrade.publicKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' })
  let prepared = false
  await assert.rejects(f.manager.installWholeDesktopUpgrade({}, {
    prepareRestart: async () => { prepared = true; return true },
    recover: async () => {}, quitWithoutRelaunch: () => assert.fail('must remain alive'),
  }), /签名/)
  assert.equal(prepared, false)
  assert.equal(f.manager.state.active, null)
  assert.equal(f.manager.busy, false)
})

test('whole desktop public install reaches real archive validation and cancellation without changing data', async t => {
  const f = await wholeDesktopFixture(t)
  await fs.writeFile(join(f.request.dshHome, 'sentinel'), 'old data\n')
  await f.manager.checkWholeDesktopUpgrade()
  let prepared = 0
  const result = await f.manager.installWholeDesktopUpgrade(f.request, {
    prepareRestart: async () => { prepared++; return false },
    recover: async () => assert.fail('cancel before Host stop does not need recovery'),
    quitWithoutRelaunch: () => assert.fail('cancelled parent remains alive'),
  })
  assert.deepEqual(result, { kind: 'cancelled' })
  assert.equal(prepared, 1)
  assert.equal(await fs.readFile(join(f.request.dshHome, 'sentinel'), 'utf8'), 'old data\n')
  assert.equal(f.manager.desktop.dataEpoch, 'schema-1')
  assert.equal(f.manager.state.active, null)
  await assert.rejects(fs.stat(join(f.request.root, 'current')), { code: 'ENOENT' })
  assert.equal((await fs.readdir(f.options.root)).some(name => name.startsWith('.whole-desktop-')), false)
})

test('whole desktop preparation without clean acknowledgement recovers the running Host and keeps Electron alive', async t => {
  const f = await wholeDesktopFixture(t)
  await f.manager.checkWholeDesktopUpgrade()
  let recovered = 0
  await assert.rejects(f.manager.installWholeDesktopUpgrade(f.request, {
    prepareRestart: async () => { throw new Error('Host stop failed without clean acknowledgement') },
    recover: async () => { recovered++ },
    quitWithoutRelaunch: () => assert.fail('unclean parent must remain alive'),
  }), /without clean acknowledgement/)
  assert.equal(recovered, 1)
  assert.equal(f.manager.busy, false)
  assert.equal(f.manager.state.active, null)
  await assert.rejects(fs.stat(join(f.request.root, 'current')), { code: 'ENOENT' })
})

test('signed target identity never substitutes for the identity inside its full desktop archive', async t => {
  for (const drift of [{ dataEpoch: 'schema-1' }, { protocol: 5 }, { nodeVersion: '24.0.0' }]) {
    await t.test(Object.keys(drift)[0], async t => {
      const f = await wholeDesktopFixture(t, drift)
      await f.manager.checkWholeDesktopUpgrade()
      let prepared = false
      await assert.rejects(f.manager.installWholeDesktopUpgrade(f.request, {
        prepareRestart: async () => { prepared = true; return false },
        recover: async () => {}, quitWithoutRelaunch: () => assert.fail('invalid archive keeps parent alive'),
      }), /metadata|nodeVersion|protocol|dataEpoch|运行时|签名|target/)
      assert.equal(prepared, false)
      assert.equal(f.manager.state.active, null)
      await assert.rejects(fs.stat(join(f.request.root, 'current')), { code: 'ENOENT' })
    })
  }
})

test('truncated and corrupt downloads, failed probes, and cancellation do not change active version', async t => {
  for (const failure of ['hash', 'truncated', 'probe', 'cancel', 'restart']) {
    await t.test(failure, async t => {
      const f = await fixture(t)
      await f.manager.check('kernel')
      if (failure === 'hash') f.responses.set(f.release.asset.url, Buffer.alloc(f.release.asset.size, 42))
      if (failure === 'truncated') f.responses.set(f.release.asset.url, Buffer.alloc(10))
      if (failure === 'probe') f.manager.probeKernel = async () => { throw new Error('host trial failed') }
      const operation = f.manager.installKernel(async () => failure !== 'cancel', () => {
        if (failure === 'restart') throw new Error('restart failed')
      })
      if (failure === 'cancel') assert.equal(await operation, false)
      else await assert.rejects(operation)
      assert.equal(f.manager.state.active, null)
      assert.equal(f.manager.selected.version, '1.0.0')
      assert.equal(f.manager.busy, false)
    })
  }
})

test('support-runtime tampering is detected on next boot and pending kernel rolls back', async t => {
  const f = await fixture(t)
  await f.manager.check('kernel')
  await f.manager.installKernel(async () => true, () => {})
  await fs.writeFile(join(f.options.root, 'kernels', f.release.asset.sha256, 'runtime/bin/node'), 'tampered')
  const reboot = new UpdateManager(f.options)
  assert.equal((await reboot.boot()).version, '1.0.0')
  assert.match(reboot.notice, /校验失败/)
})

test('kernel archives reject traversal, symlinks and hardlinks before extraction', async t => {
  const f = await fixture(t)
  const destination = join(f.root, 'unpacked')
  await fs.mkdir(destination)
  await fs.symlink('/etc/passwd', join(f.payload, 'dsh/escape'))
  const archive = join(f.root, 'symlink.tgz')
  await tar.c({ gzip: true, cwd: f.payload, file: archive }, ['kernel.json', 'dsh', 'runtime'])
  await assert.rejects(extractKernel(archive, destination), /链接/)
  assert.deepEqual(await fs.readdir(destination), [])
  await fs.rm(join(f.payload, 'dsh/escape'))
  await fs.link(join(f.payload, 'dsh/entry.js'), join(f.payload, 'dsh/hardlink'))
  await tar.c({ gzip: true, cwd: f.payload, file: archive }, ['kernel.json', 'dsh', 'runtime'])
  await assert.rejects(extractKernel(archive, destination), /链接/)
  const header = Buffer.alloc(512)
  header.write('../outside', 0)
  header.write('0000644\0', 100)
  header.write('0000000\0', 108); header.write('0000000\0', 116)
  header.write('00000000000\0', 124); header.write('00000000000\0', 136)
  header.fill(32, 148, 156); header.write('0', 156)
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148)
  await fs.writeFile(archive, Buffer.concat([header, Buffer.alloc(1024)]))
  await assert.rejects(extractKernel(archive, destination), /不安全路径/)
})

test('replacing an archive after inspection cannot introduce links during extraction', async t => {
  const f = await fixture(t)
  const malicious = join(f.root, 'replacement.tgz')
  await fs.symlink('/etc/passwd', join(f.payload, 'dsh/escape'))
  await tar.c({ gzip: true, cwd: f.payload, file: malicious }, ['dsh'])
  const bytes = await fs.readFile(malicious)
  const destination = join(f.root, 'destination')
  await fs.mkdir(destination)
  const originalOpen = fsSync.openSync, originalClose = fsSync.closeSync
  let inspectedFd, replaced = false
  t.mock.method(fsSync, 'openSync', (path, ...args) => {
    const fd = originalOpen(path, ...args)
    if (path === f.archive && !replaced) inspectedFd = fd
    return fd
  })
  t.mock.method(fsSync, 'closeSync', fd => {
    const result = originalClose(fd)
    if (fd === inspectedFd && !replaced) {
      replaced = true
      fsSync.writeFileSync(f.archive, bytes)
    }
    return result
  })
  syncBuiltinESMExports()
  try {
    await assert.rejects(extractKernel(f.archive, destination), /链接/)
    assert.equal(replaced, true)
    await assert.rejects(fs.lstat(join(destination, 'dsh/escape')), { code: 'ENOENT' })
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
})

test('desktop update uses a different signed channel and never writes kernel pointers', async t => {
  const f = await fixture(t)
  const bytes = Buffer.from('a mocked verified desktop installer')
  const asset = { url: 'https://updates.test/desktop.deb', size: bytes.length, sha256: sha(bytes) }
  const release = { ...f.release, schemaVersion: 2, channel: 'desktop', format: 'tar.gz', linuxRevision: 1, version: '1.2.0', nodeVersion: '24.18.1',
    kernelRange: '>=1 <2', asset }
  f.responses.set('https://updates.test/desktop.json', Buffer.from(JSON.stringify(signed(release))))
  f.responses.set(asset.url, bytes)
  await f.manager.check('desktop')
  const before = JSON.stringify(f.manager.state)
  let installed
  await f.manager.installDesktop(async () => true, async args => {
    installed = args
    assert.equal(await args.prepareRestart(), true)
    await args.restart('/home/user/Applications/desktop/current/dsh-workbench')
    return { executable: '/home/user/Applications/desktop/current/dsh-workbench' }
  }, () => {})
  assert.equal(installed.version, '1.2.0')
  assert.equal(installed.sha256, asset.sha256)
  assert.equal(JSON.stringify(f.manager.state), before)
  await assert.rejects(fs.stat(installed.archive), { code: 'ENOENT' })
  release.kernelRange = '>=2'
  f.responses.set('https://updates.test/desktop.json', Buffer.from(JSON.stringify(signed(release))))
  await assert.rejects(f.manager.check('desktop'), /不支持当前内核/)
})

test('GitHub Releases feeds and assets follow bounded redirects without bypassing signature or hash checks', async t => {
  const f = await fixture(t)
  const base = 'https://github.com/owner/repository/releases/'
  const feed = `${base}latest/download/desktop-latest.json`
  const taggedFeed = `${base}download/v1.2.0/desktop-latest.json`
  const bytes = Buffer.from('verified GitHub desktop installer')
  const asset = { url: `${base}download/v1.2.0/desktop.deb`, size: bytes.length, sha256: sha(bytes) }
  const release = { ...f.release, schemaVersion: 2, channel: 'desktop', format: 'tar.gz', linuxRevision: 1, version: '1.2.0', nodeVersion: '24.18.1',
    kernelRange: '>=1 <2', asset }
  f.options.config.desktop.url = feed
  const replies = new Map([
    [feed, { location: taggedFeed }],
    [taggedFeed, { location: 'https://release-assets.githubusercontent.com/feed' }],
    ['https://release-assets.githubusercontent.com/feed', { body: JSON.stringify(signed(release)) }],
    [asset.url, { location: 'https://release-assets.githubusercontent.com/installer' }],
    ['https://release-assets.githubusercontent.com/installer', { body: bytes }],
  ])
  f.manager.fetch = async (url, options) => {
    assert.equal(options.redirect, url.startsWith(base) ? 'manual' : 'error')
    const reply = replies.get(url)
    assert.ok(reply, `unexpected URL: ${url}`)
    return reply.location ? new Response(null, { status: 302, headers: { location: reply.location } }) : new Response(reply.body)
  }
  await f.manager.check('desktop')
  assert.equal(f.manager.status().desktop.available, '1.2.0')
  await f.manager.installDesktop(async () => true, async args => {
    assert.deepEqual(await fs.readFile(args.archive), bytes)
    return { executable: '/home/user/new-dsh-workbench' }
  }, () => {})
  assert.equal(f.manager.state.active, null)
  replies.set('https://release-assets.githubusercontent.com/feed', { body: JSON.stringify(signed(release, generateKeyPairSync('ed25519').privateKey)) })
  await assert.rejects(f.manager.check('desktop'), /签名/)
  assert.equal(f.manager.status().desktop.available, null)
})

test('GitHub download redirects reject other repositories, hosts, insecure URLs and loops', async t => {
  const f = await fixture(t)
  const source = 'https://github.com/owner/repository/releases/latest/download/desktop-latest.json'
  for (const target of [
    'https://github.com/other/repository/releases/download/v1/desktop-latest.json',
    'https://github.com/owner/repository/releases/download/v1/other.json',
    'https://github.com/owner/repository/issues',
    'https://untrusted.test/installer',
    'https://release-assets.githubusercontent.com.untrusted.test/installer',
    'http://release-assets.githubusercontent.com/installer',
    'https://user:password@release-assets.githubusercontent.com/installer',
    source,
  ]) {
    let requests = 0
    f.manager.fetch = async (_url, options) => {
      assert.equal(options.redirect, 'manual')
      requests++
      return new Response(null, { status: 302, headers: { location: target } })
    }
    await assert.rejects(f.manager.response(source), /HTTPS|重定向/)
    assert.ok(requests <= 4, 'redirect loops must be bounded')
  }
  f.manager.fetch = async (_url, options) => {
    assert.equal(options.redirect, 'error')
    return new Response(null, { status: 302, headers: { location: 'https://untrusted.test/installer' } })
  }
  await assert.rejects(f.manager.response('https://updates.test/release.json'), /重定向/)
})

test('Linux revisions order desktop rebuilds without changing or downgrading official shell versions', async t => {
  const f = await fixture(t)
  f.manager.desktop.linuxRevision = 2
  f.manager.desktop.version = '1.2.0'
  const release = { ...f.release, schemaVersion: 2, channel: 'desktop', format: 'tar.gz',
    version: f.manager.desktop.version, linuxRevision: 3, nodeVersion: '24.18.1', kernelRange: '>=1 <2' }
  const feed = value => f.responses.set('https://updates.test/desktop.json', Buffer.from(JSON.stringify(signed(value))))
  feed(release)
  await f.manager.check('desktop')
  assert.equal(f.manager.status().desktop.available, f.manager.desktop.version)
  assert.equal(f.manager.status().desktop.availableLinuxRevision, 3)
  assert.equal(f.manager.status().desktop.linuxRevision, 2)
  assert.equal(f.manager.status().desktop.latest, release.version)
  assert.equal(f.manager.status().desktop.latestLinuxRevision, 3)
  for (const candidate of [{ ...release, linuxRevision: 2 }, { ...release, linuxRevision: 1 },
    { ...release, version: '1.1.0', linuxRevision: 100 }]) {
    feed(candidate)
    await f.manager.check('desktop')
    assert.equal(f.manager.status().desktop.available, null)
    assert.equal(f.manager.status().desktop.latest, candidate.version)
    assert.equal(f.manager.status().desktop.latestLinuxRevision, candidate.linuxRevision)
  }
  feed({ ...release, linuxRevision: -1 })
  await assert.rejects(f.manager.check('desktop'), /构建号/)
  assert.equal(f.manager.status().desktop.latest, null)
})

test('desktop authorization/installer failure preserves kernel state and cleans the download', async t => {
  const f = await fixture(t)
  const bytes = Buffer.from('installer')
  const asset = { url: 'https://updates.test/desktop.deb', size: bytes.length, sha256: sha(bytes) }
  const release = { ...f.release, schemaVersion: 2, channel: 'desktop', format: 'tar.gz', linuxRevision: 1, version: '1.2.0', nodeVersion: '24.18.1', kernelRange: '>=1 <2', asset }
  f.responses.set('https://updates.test/desktop.json', Buffer.from(JSON.stringify(signed(release))))
  f.responses.set(asset.url, bytes)
  await f.manager.check('desktop')
  await assert.rejects(f.manager.installDesktop(async () => true, async () => { throw new Error('activation failed') }, () => assert.fail('must not restart')), /activation failed/)
  assert.equal(f.manager.state.active, null)
  assert.equal(f.manager.busy, false)
})

test('concurrent mutations are rejected and a failed check clears the stale candidate', async t => {
  const f = await fixture(t)
  await f.manager.check('kernel')
  let releaseDownload
  const original = f.manager.fetch
  f.manager.fetch = async (url, options) => {
    if (url === f.release.asset.url) await new Promise(resolve => { releaseDownload = resolve })
    return original(url, options)
  }
  const installing = f.manager.installKernel(async () => false, () => assert.fail('cancelled'))
  while (!releaseDownload) await new Promise(resolve => setImmediate(resolve))
  await assert.rejects(f.manager.check('kernel'), /正在进行/)
  await assert.rejects(f.manager.installKernel(async () => true, () => {}), /正在进行/)
  releaseDownload()
  await installing
  f.responses.set('https://updates.test/kernel.json', Buffer.from('{"payload":"bad","signature":"bad"}'))
  await assert.rejects(f.manager.check('kernel'), /签名/)
  assert.equal(f.manager.status().kernel.available, null)
})

test('unconfigured sources, HTTP and downgraded releases never produce an install candidate', async t => {
  const f = await fixture(t, { version: '0.9.0' })
  await f.manager.check('kernel')
  assert.equal(f.manager.status().kernel.available, null)
  f.options.config.kernel = null
  await assert.rejects(f.manager.check('kernel'), /未配置/)
  f.options.config.kernel = { url: 'http://updates.test/kernel', publicKey }
  await assert.rejects(f.manager.check('kernel'), /HTTPS/)
})

test('desktop updates always install the signed archive into HOME, regardless of package attachments', async t => {
  const f = await fixture(t)
  const bytes = Buffer.from('verified HOME desktop archive')
  const archive = { url: 'https://updates.test/desktop.tar.gz', size: bytes.length, sha256: sha(bytes) }
  const packageAsset = { url: 'https://updates.test/bootstrap.deb', size: 8, sha256: sha(Buffer.from('bootstrap')) }
  const release = { ...f.release, schemaVersion: 2, channel: 'desktop', format: 'tar.gz',
    version: '1.2.0', linuxRevision: 2, nodeVersion: '24.18.1', kernelRange: '>=1 <2',
    asset: archive, assets: { deb: packageAsset, rpm: packageAsset } }
  f.responses.set('https://updates.test/desktop.json', Buffer.from(JSON.stringify(signed(release))))
  f.responses.set(archive.url, bytes)
  f.responses.set(packageAsset.url, Buffer.from('bootstrap'))
  await f.manager.check('desktop')
  const before = JSON.stringify(f.manager.state)
  let restarted = false
  await f.manager.installDesktop(async () => true, async artifact => {
    assert.equal(artifact.linuxRevision, 2)
    assert.equal(artifact.size, bytes.length)
    assert.deepEqual(await fs.readFile(artifact.archive), bytes)
    assert.equal(artifact.format, undefined)
    if (!await artifact.prepareRestart()) return null
    await artifact.restart('/home/test/Applications/dsh-linux-desktop/current/dsh-workbench')
    return { executable: '/home/test/Applications/dsh-linux-desktop/current/dsh-workbench' }
  }, executable => {
    assert.equal(executable, '/home/test/Applications/dsh-linux-desktop/current/dsh-workbench')
    restarted = true
  })
  assert.equal(restarted, true)
  assert.equal(JSON.stringify(f.manager.state), before)
  assert.equal(f.responses.has(packageAsset.url), true, 'signed package attachments remain separate from client OTA')
  const invalid = { ...release, assets: { deb: packageAsset, rpm: { ...packageAsset, size: 0 } } }
  assert.throws(() => verifyFeed(signed(invalid), publicKey, 'desktop'), /大小/)
})

test('asset downloads allow ten minutes while manifest requests retain the two-minute bound', async t => {
  const f = await fixture(t)
  const timeouts = []
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    timeouts.push(milliseconds)
    return new AbortController().signal
  })
  await f.manager.check('kernel')
  await f.manager.download(f.release.asset, join(f.root, 'bounded-download.tgz'))
  assert.deepEqual(timeouts, [120_000, 600_000])
})
