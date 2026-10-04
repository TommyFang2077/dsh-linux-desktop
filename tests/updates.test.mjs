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
  const release = { ...f.release, channel: 'desktop', version: '1.2.0', nodeVersion: '24.18.1',
    kernelRange: '>=1 <2', assets: { deb: asset, rpm: asset } }
  f.responses.set('https://updates.test/desktop.json', Buffer.from(JSON.stringify(signed(release))))
  f.responses.set(asset.url, bytes)
  await f.manager.check('desktop')
  const before = JSON.stringify(f.manager.state)
  let installed
  await f.manager.installDesktop('deb', async () => true, async args => { installed = args }, () => {})
  assert.equal(installed.version, '1.2.0')
  assert.equal(installed.sha256, asset.sha256)
  assert.equal(JSON.stringify(f.manager.state), before)
  await assert.rejects(fs.stat(installed.path), { code: 'ENOENT' })
  release.kernelRange = '>=2'
  f.responses.set('https://updates.test/desktop.json', Buffer.from(JSON.stringify(signed(release))))
  await assert.rejects(f.manager.check('desktop'), /不支持当前内核/)
})

test('desktop authorization/installer failure preserves kernel state and cleans the download', async t => {
  const f = await fixture(t)
  const bytes = Buffer.from('installer')
  const asset = { url: 'https://updates.test/desktop.deb', size: bytes.length, sha256: sha(bytes) }
  const release = { ...f.release, channel: 'desktop', version: '1.2.0', nodeVersion: '24.18.1', kernelRange: '>=1 <2', assets: { deb: asset, rpm: asset } }
  f.responses.set('https://updates.test/desktop.json', Buffer.from(JSON.stringify(signed(release))))
  f.responses.set(asset.url, bytes)
  await f.manager.check('desktop')
  await assert.rejects(f.manager.installDesktop('deb', async () => true, async () => { throw new Error('authorization cancelled') }, () => assert.fail('must not restart')), /authorization cancelled/)
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
