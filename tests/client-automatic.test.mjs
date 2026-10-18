import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test, { after } from 'node:test'
import { AutomaticUpdates, CHECK_INTERVAL, RETRY_INTERVAL, confirmUpdate, requireIdle } from '../updates/automatic.mjs'
import { releaseFeedNames } from '../scripts/build-bridge.mjs'
const dependencies = resolve(process.env.DSH_UPSTREAM_DEPENDENCIES ?? 'build/upstream')
const require = createRequire(join(dependencies, 'package.json'))
const { build } = require(require.resolve('esbuild', { paths: [join(dependencies, 'node_modules/.pnpm/node_modules')] }))
const coreDirectory = await fs.mkdtemp('/tmp/dsh-client-core-test-')
after(() => fs.rm(coreDirectory, { recursive: true, force: true }))
const corePath = join(coreDirectory, 'core.mjs')
await build({ entryPoints: ['updates/core.mjs'], outfile: corePath, bundle: true, format: 'esm', platform: 'node', target: 'node24',
  external: ['electron'], nodePaths: [join(dependencies, 'node_modules')],
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' } })
const { UpdateManager, checkCompatibility } = await import(pathToFileURL(corePath).href)

function clock() {
  let time = 1000, id = 0
  const timers = new Map()
  return {
    now: () => time,
    setTimer: (callback, delay) => { timers.set(++id, { callback, delay }); return id },
    clearTimer: id => timers.delete(id),
    get timers() { return [...timers.values()] },
    async fire() {
      const [id, timer] = timers.entries().next().value
      timers.delete(id)
      time += timer.delay
      timer.callback()
    },
  }
}

function stubManager() {
  const release = { version: '1.1.0', asset: { sha256: 'abc' } }
  let checks = 0, downloads = 0
  return {
    candidates: { desktop: { release } },
    status: () => ({ desktop: { configured: true, available: release.version }, kernel: { configured: false } }),
    check: async () => { checks++ },
    prepareDownload: async () => { downloads++ },
    counts: () => ({ checks, downloads }),
  }
}

test('startup and six-hour checks download only; notification and concurrent checks deduplicate', async () => {
  const manager = stubManager(), timer = clock(), notifications = []
  const automatic = new AutomaticUpdates({ manager, ...timer, notify: (...args) => notifications.push(args) })
  automatic.start()
  automatic.start()
  const first = automatic.check()
  assert.equal(first, automatic.check())
  await first
  assert.deepEqual(manager.counts(), { checks: 1, downloads: 1 })
  assert.equal(notifications.length, 1)
  assert.equal(timer.timers[0].delay, CHECK_INTERVAL)
  await timer.fire()
  await automatic.inFlight
  assert.equal(manager.counts().checks, 2)
  assert.equal(notifications.length, 1)
  automatic.stop()
  assert.equal(timer.timers.length, 0)
})

test('failures exponentially back off with six-hour cap and reset after recovery', async () => {
  const manager = stubManager(), timer = clock()
  manager.check = async () => { throw new Error('offline') }
  const automatic = new AutomaticUpdates({ manager, ...timer })
  automatic.start()
  await automatic.inFlight
  assert.equal(timer.timers[0].delay, RETRY_INTERVAL)
  for (let attempt = 1; attempt < 10; attempt++) {
    await timer.fire(); await automatic.inFlight
    assert.equal(timer.timers[0].delay, Math.min(CHECK_INTERVAL, RETRY_INTERVAL * 2 ** attempt))
  }
  manager.check = async () => {}
  await timer.fire(); await automatic.inFlight
  assert.equal(automatic.failures, 0)
  assert.deepEqual(automatic.state.errors, {})
  assert.equal(timer.timers[0].delay, CHECK_INTERVAL)
  automatic.stop()
})

test('quit during download suppresses notification and timer rearming', async () => {
  const manager = stubManager(), timer = clock(), pending = Promise.withResolvers()
  let notified = false
  manager.prepareDownload = () => pending.promise
  const automatic = new AutomaticUpdates({ manager, ...timer, notify: () => { notified = true } })
  automatic.start()
  await Promise.resolve()
  automatic.stop()
  pending.resolve()
  await automatic.inFlight
  assert.equal(notified, false)
  assert.equal(timer.timers.length, 0)
})

test('unconfigured channels and cross-data migration are never automatically downloaded', async () => {
  const manager = stubManager()
  manager.status = () => ({ desktop: { configured: false }, kernel: { configured: false }, desktopUpgrade: { configured: true, available: '2.0.0' } })
  await new AutomaticUpdates({ manager }).check()
  assert.deepEqual(manager.counts(), { checks: 0, downloads: 0 })
})

test('a prepared kernel is downloaded before an optional desktop and avoids its transfer', async () => {
  const sequence = []
  const release = { version: '2.0.0', asset: { sha256: 'new-kernel' } }
  const manager = {
    candidates: { kernel: { release }, desktop: { release } },
    status: () => ({ kernel: { configured: true, available: '2.0.0', crossEpoch: true },
      desktop: { configured: true, available: '2.0.0' } }),
    check: async channel => { sequence.push(`check:${channel}`) },
    prepareDownload: async channel => { sequence.push(`download:${channel}`) },
  }
  await new AutomaticUpdates({ manager }).check()
  assert.deepEqual(sequence, ['check:kernel', 'download:kernel'])
})

test('installation requires exact idle proof; errors and unknown states fail closed', async () => {
  await requireIdle(async () => false)
  for (const value of [true, undefined, null, 0, 'false']) await assert.rejects(requireIdle(async () => value), /暂缓安装/)
  await assert.rejects(requireIdle(), /无法确认/)
  await assert.rejects(requireIdle(async () => { throw new Error('timeout') }), /无法确认/)
})

test('cancel keeps candidate and retry requires fresh checks before and after consent', async () => {
  const manager = stubManager()
  const options = { manager, channel: 'desktop', inspect: async () => false, confirm: async () => false }
  assert.equal(await confirmUpdate(options), false)
  assert.ok(manager.candidates.desktop)
  assert.deepEqual(manager.counts(), { checks: 1, downloads: 1 })
  assert.equal(await confirmUpdate({ ...options, confirm: async () => true }), true)
  assert.deepEqual(manager.counts(), { checks: 3, downloads: 3 })
})

test('target changes before consent, activity during consent, and unavailable Host block installation', async () => {
  const manager = stubManager()
  let prompted = 0
  const options = { manager, channel: 'desktop', inspect: async () => false, confirm: async () => { prompted++; return true } }
  manager.check = async () => { manager.candidates.desktop.release = { version: '1.2.0' } }
  await assert.rejects(confirmUpdate(options), /目标已改变/)
  assert.equal(prompted, 0)
  manager.check = async () => {}
  let inspections = 0
  await assert.rejects(confirmUpdate({ ...options, inspect: async () => ++inspections > 1 }), /活动任务/)
  await assert.rejects(confirmUpdate({ ...options, inspect: async () => { throw new Error('Host disconnected') } }), /无法确认/)
})

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
async function fixture(t) {
  const root = await fs.mkdtemp('/tmp/dsh-automatic-test-')
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const keys = generateKeyPairSync('ed25519')
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' })
  const bytes = Buffer.from('signed desktop archive test bytes')
  const metadata = { version: '1.0.0', protocol: 4, dataEpoch: 'schema-1', desktopRange: '>=1 <3', nodeRange: '>=24 <25', nodeVersion: '24.18.1' }
  const release = { ...metadata, version: '1.1.0', linuxRevision: 1, kernelRange: '>=1 <3',
    schemaVersion: 2, channel: 'desktop', platform: 'linux', arch: 'x64', format: 'tar.gz',
    asset: { url: 'https://updates.test/archive', sha256: hash(bytes), size: bytes.length } }
  const payload = Buffer.from(JSON.stringify(release))
  const envelope = { payload: payload.toString('base64'), signature: sign(null, payload, keys.privateKey).toString('base64') }
  let downloads = 0
  const options = { root, desktop: metadata, bundled: metadata, config: { desktop: { url: 'https://updates.test/feed', publicKey } },
    fetch: async url => {
      if (url.endsWith('/feed')) return new Response(JSON.stringify(envelope))
      downloads++
      return new Response(bytes)
    } }
  const manager = new UpdateManager(options)
  await manager.boot(); await manager.check('desktop')
  return { manager, root, bytes, release, envelope, options, downloads: () => downloads }
}

test('verified persistent cache is reused but corruption and symlinks are never trusted', async t => {
  const f = await fixture(t)
  await f.manager.prepareDownload('desktop')
  await f.manager.prepareDownload('desktop')
  assert.equal(f.downloads(), 1)
  const archive = join(f.root, 'downloads', 'desktop-' + f.release.asset.sha256 + '.tgz')
  await fs.writeFile(archive, Buffer.alloc(f.bytes.length))
  await f.manager.prepareDownload('desktop')
  assert.equal(f.downloads(), 2)
  assert.deepEqual(await fs.readFile(archive), f.bytes)
  await fs.unlink(archive)
  const outside = join(f.root, 'outside')
  await fs.writeFile(outside, f.bytes)
  await fs.symlink(outside, archive)
  await f.manager.prepareDownload('desktop')
  assert.equal((await fs.lstat(archive)).isSymbolicLink(), false)
  assert.deepEqual(await fs.readFile(outside), f.bytes)
  const restarted = new UpdateManager(f.options)
  await restarted.boot(); await restarted.check('desktop'); await restarted.prepareDownload('desktop')
  assert.equal(f.downloads(), 3)
})

test('after a followed kernel activates, subsequent checks do not download or notify for the matching full shell', async t => {
  const f = await fixture(t)
  f.manager.desktop = { ...f.manager.desktop, followOfficial: true }
  f.manager.selected = { ...f.manager.selected, version: f.release.version }
  const notifications = []
  const automatic = new AutomaticUpdates({ manager: f.manager, notify: (...args) => notifications.push(args) })
  automatic.start()
  await automatic.inFlight
  assert.equal(f.downloads(), 0)
  assert.deepEqual(notifications, [])
  assert.equal(f.manager.status().desktop.latest, f.release.version)
  assert.equal(f.manager.status().desktop.available, null)
  assert.deepEqual(automatic.state.errors, {})
  await automatic.check()
  assert.equal(f.downloads(), 0)
  assert.deepEqual(notifications, [])
  automatic.stop()
})

test('confirmation and install revalidate signature, compatibility, target version, and cached bytes', async t => {
  const f = await fixture(t)
  await f.manager.prepareDownload('desktop')
  f.manager.desktop.dataEpoch = 'changed'
  await assert.rejects(f.manager.prepareDownload('desktop'), /数据格式/)
  f.manager.desktop.dataEpoch = 'schema-1'
  f.manager.candidates.desktop.envelope.signature = Buffer.alloc(64).toString('base64')
  await assert.rejects(f.manager.installDesktop(async () => true, () => assert.fail('must not install'), () => {}), /签名/)
  await f.manager.check('desktop')
  f.manager.desktop.version = '2.0.0'
  await assert.rejects(f.manager.prepareDownload('desktop'), /不再适用/)
})

test('downloads have exclusive admission and ordinary installs stage verified cache without network', async t => {
  const f = await fixture(t)
  const pending = Promise.withResolvers()
  const fetch = f.manager.fetch
  f.manager.fetch = async url => url.endsWith('/archive') ? pending.promise : fetch(url)
  const first = f.manager.prepareDownload('desktop')
  await assert.rejects(f.manager.prepareDownload('desktop'), /正在进行/)
  pending.resolve(new Response(f.bytes)); await first
  f.manager.fetch = () => assert.fail('cache should avoid archive request')
  let installed = 0
  await f.manager.installDesktop(async () => true, async ({ archive }) => {
    assert.deepEqual(await fs.readFile(archive), f.bytes)
    installed++
  }, () => {})
  assert.equal(installed, 1)
})


test('current alpha4 metadata denies legacy epochs even when both versions satisfy semver ranges', async () => {
  const desktop = JSON.parse(await fs.readFile('desktop.json', 'utf8'))
  const upstream = JSON.parse(await fs.readFile('upstream.json', 'utf8'))
  const feeds = JSON.parse(await fs.readFile('updates.json', 'utf8'))
  assert.equal(desktop.version, upstream.version)
  assert.ok(!['dsh-0.2.1-alpha.1', 'dsh-0.2.1-alpha.2'].includes(desktop.dataEpoch))
  assert.doesNotThrow(() => checkCompatibility(desktop, desktop))
  assert.throws(() => checkCompatibility({ ...desktop, version: '0.2.1-alpha.2',
    dataEpoch: 'dsh-0.2.1-alpha.2', desktopRange: '>=0.2.1-alpha.2 <0.3.0' }, desktop), /不兼容/)
  const names = releaseFeedNames(desktop)
  for (const channel of ['kernel', 'desktop']) assert.ok(feeds[channel].url.endsWith(names[channel]))
  assert.ok(feeds.desktopUpgrade.url.endsWith(desktop.followOfficial ? names.desktop : 'desktop-dsh-0.2.1-alpha.2-latest.json'))
})

test('alpha4 checks the signed legacy upgrade feed without proposing a downgrade or ordinary cross-epoch install', async t => {
  const desktop = JSON.parse(await fs.readFile('desktop.json', 'utf8'))
  const feeds = JSON.parse(await fs.readFile('updates.json', 'utf8'))
  const root = await fs.mkdtemp('/tmp/dsh-alpha4-legacy-feed-')
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const keys = generateKeyPairSync('ed25519')
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' })
  const release = { ...desktop, version: '0.2.1-alpha.2', linuxRevision: 999, dataEpoch: 'dsh-0.2.1-alpha.2',
    desktopRange: '>=0.2.1-alpha.2 <0.3.0', kernelRange: '>=0.2.1-alpha.2 <0.3.0', electronVersion: '44.5.1',
    schemaVersion: 2, channel: 'desktop', platform: 'linux', arch: 'x64', format: 'tar.gz',
    asset: { url: 'https://updates.test/archive', sha256: hash(Buffer.from('legacy')), size: 6 } }
  const payload = Buffer.from(JSON.stringify(release))
  const envelope = { payload: payload.toString('base64'), signature: sign(null, payload, keys.privateKey).toString('base64') }
  const requested = []
  const source = { url: feeds.desktopUpgrade.url, publicKey }
  const manager = new UpdateManager({ root, desktop, bundled: desktop, config: { desktopUpgrade: source, desktop: source },
    fetch: async url => { requested.push(url); return new Response(JSON.stringify(envelope)) } })
  await manager.boot()
  const status = await manager.checkWholeDesktopUpgrade()
  assert.equal(status.desktopUpgrade.latest, '0.2.1-alpha.2')
  assert.equal(status.desktopUpgrade.available, null)
  assert.equal(manager.candidates.desktopUpgrade, undefined)
  assert.deepEqual(requested, [feeds.desktopUpgrade.url])
  await assert.rejects(manager.check('desktop'), /数据格式/)
  assert.equal(manager.candidates.desktop, undefined)
})
