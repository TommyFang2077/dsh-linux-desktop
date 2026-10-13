import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { BRIDGE_REVISION, bridgePlan, releaseFeedNames, stageBridge } from '../scripts/build-bridge.mjs'
import { installUserDesktop } from '../build/user-install.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const baseline = 'workbench-v0.2.1-alpha.1-r7'
const require = createRequire(new URL('../build/upstream/package.json', import.meta.url))
const tar = require('tar')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

async function legacyFixture(t) {
  const directory = await fs.mkdtemp('/tmp/workbench-legacy-bridge-test-')
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const bundle = join(directory, 'legacy-r7-core.mjs')
  const upstream = join(root, 'build/upstream')
  const esbuild = require(require.resolve('esbuild', { paths: [join(upstream, 'node_modules/.pnpm/node_modules')] }))
  await esbuild.build({ entryPoints: [join(root, 'tests/fixtures/legacy-r7-core.mjs')], outfile: bundle,
    bundle: true, platform: 'node', format: 'esm', target: 'node24', nodePaths: [join(upstream, 'node_modules')],
    banner: { js: "import { createRequire as __legacyRequire } from 'node:module'; const require = __legacyRequire(import.meta.url);" } })
  const { UpdateManager } = await import(pathToFileURL(bundle))
  const plan = bridgePlan(root)
  const home = join(directory, 'home')
  await fs.mkdir(home, { mode: 0o700 })
  const installation = join(home, 'Applications/dsh-linux-desktop')
  async function archive(revision) {
    const input = join(directory, `input-r${revision}`)
    const metadata = { ...plan.desktop, linuxRevision: revision }
    const files = {
      'dsh-workbench': '#!/bin/sh\nexit 0\n',
      'resources/app/package.json': JSON.stringify({ name: 'dsh-workbench', version: metadata.version, linuxRevision: revision }),
      'resources/app/workbench/desktop.json': JSON.stringify(metadata),
      'resources/runtime/primary-runtime/runtime.json': JSON.stringify({ platform: 'linux', arch: 'x64', node: metadata.nodeVersion }),
      'resources/runtime/primary-runtime/dependencies/node/bin/node': '#!/bin/sh\nprintf "v24.21.0\\n"\n',
    }
    const sharedPackages = ['dsh', 'dsh-desktop-host'].map(name => ({ name: `@deepseek-ai/${name}`,
      version: metadata.version, path: `node_modules/@deepseek-ai/${name}` }))
    const inventory = []
    for (const entry of sharedPackages) {
      const path = `${entry.path}/package.json`
      const bytes = Buffer.from(JSON.stringify({ name: entry.name, version: entry.version }))
      files[`resources/app/dsh/${path}`] = bytes
      inventory.push({ path, bytes: bytes.length, sha256: digest(bytes), executable: false })
    }
    files['resources/app/dsh/desktop-runtime.json'] = JSON.stringify({ schemaVersion: 1, platform: 'linux', arch: 'x64',
      release: { schemaVersion: 1, version: metadata.version, hostProtocolVersion: 4, nodeVersion: '24.18.1', pnpmVersion: '11.7.0' },
      sharedPackages, files: inventory.sort((a, b) => a.path < b.path ? -1 : 1) })
    for (const [path, bytes] of Object.entries(files)) {
      const destination = join(input, 'app', path)
      await fs.mkdir(join(destination, '..'), { recursive: true, mode: 0o755 })
      await fs.writeFile(destination, bytes, { mode: path === 'dsh-workbench' || path.endsWith('/bin/node') ? 0o755 : 0o644 })
    }
    const path = join(directory, `r${revision}.tar.gz`)
    await tar.c({ file: path, cwd: input, gzip: true, portable: true }, ['app'])
    const bytes = await fs.readFile(path)
    return { path, bytes, metadata, sha256: digest(bytes) }
  }
  const old = await archive(7)
  const bridge = await archive(BRIDGE_REVISION)
  const installed = await installUserDesktop({ archive: old.path, sha256: old.sha256, version: old.metadata.version,
    linuxRevision: 7, root: installation, home, xdgDataHome: join(home, '.local/share') })
  const keys = generateKeyPairSync('ed25519')
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' })
  const release = { ...bridge.metadata, schemaVersion: 2, channel: 'desktop', platform: 'linux', arch: 'x64', format: 'tar.gz',
    asset: { url: 'https://fixture.invalid/bridge.tar.gz', size: bridge.bytes.length, sha256: bridge.sha256 } }
  const signed = value => {
    const payload = Buffer.from(JSON.stringify(value))
    return { payload: payload.toString('base64'), signature: sign(null, payload, keys.privateKey).toString('base64') }
  }
  const responses = new Map([[plan.config.desktop.url, Buffer.from(JSON.stringify(signed(release)))], [release.asset.url, bridge.bytes]])
  const config = structuredClone(plan.config)
  for (const channel of ['kernel', 'desktop', 'desktopUpgrade']) config[channel].publicKey = publicKey
  const manager = new UpdateManager({ root: join(home, '.dsh/workbench-updates'), config, desktop: old.metadata,
    bundled: { ...old.metadata, dsh: '/frozen/r7/dsh', runtime: '/frozen/r7/runtime' },
    fetch: async (url, request) => {
      assert.equal(request.redirect, 'error')
      return responses.has(url) ? new Response(responses.get(url)) : new Response('', { status: 404 })
    } })
  await manager.boot()
  return { manager, responses, signed, release, home, installation, installed, plan }
}

test('bridge plan preserves fixed official alpha.1 source and independent r8 identity', () => {
  const plan = bridgePlan(root)
  assert.equal(plan.baselineTag, baseline)
  assert.equal(plan.baselineCommit, 'fd218dddff5225e0c0b6bb938a0570da4e718992')
  assert.equal(plan.upstream.commit, '5badb15009ae1756c3afe0ae0cef1faafc290ccc')
  assert.equal(plan.upstream.version, '0.2.1-alpha.1')
  assert.equal(plan.upstream.pnpm, '11.7.0')
  assert.equal(plan.desktop.version, '0.2.1-alpha.1')
  assert.equal(plan.desktop.linuxRevision, BRIDGE_REVISION)
  assert.equal(plan.desktop.dataEpoch, 'dsh-0.2.1-alpha.1')
  for (const channel of ['kernel', 'desktop']) {
    assert.equal(plan.config[channel].url, `https://raw.githubusercontent.com/TommyFang2077/dsh-linux-desktop/update-feed/${channel}-latest.json`)
  }
  assert.equal(plan.config.desktopUpgrade.url, 'https://raw.githubusercontent.com/TommyFang2077/dsh-linux-desktop/update-feed/desktop-dsh-0.2.1-alpha.2-latest.json')
  assert.equal(plan.config.desktopUpgrade.publicKey, plan.config.desktop.publicKey)
})

test('legacy fixture is the entire unmodified real r7 update module', () => {
  const fixture = readFileSync(new URL('./fixtures/legacy-r7-core.mjs', import.meta.url))
  assert.deepEqual(fixture, execFileSync('git', ['show', `${baseline}:updates/core.mjs`], { cwd: root }))
  assert.equal(createHash('sha256').update(fixture).digest('hex'), '4d08a7ca4c67fdc89d9c4f49756912615ce586172811f565c28939ef0f0f10f6')
})

test('bridge owns legacy feeds while new epochs leave them untouched', () => {
  assert.deepEqual(releaseFeedNames(bridgePlan(root).desktop), { kernel: 'kernel-latest.json', desktop: 'desktop-latest.json' })
  assert.deepEqual(releaseFeedNames({ version: '0.2.1-alpha.2', linuxRevision: 2, dataEpoch: 'dsh-0.2.1-alpha.2' }), {
    kernel: 'kernel-dsh-0.2.1-alpha.2-latest.json', desktop: 'desktop-dsh-0.2.1-alpha.2-latest.json',
  })
  assert.throws(() => releaseFeedNames({ version: '0.2.1-alpha.2', linuxRevision: BRIDGE_REVISION, dataEpoch: 'dsh-0.2.1-alpha.1' }), /alpha.1 r9/)
  assert.throws(() => releaseFeedNames({ version: '0.2.1-alpha.1', linuxRevision: 8, dataEpoch: 'dsh-0.2.1-alpha.1' }), /alpha.1 r9/)
  assert.throws(() => releaseFeedNames({ version: '0.2.1-alpha.2', linuxRevision: 2, dataEpoch: '../legacy' }), /epoch/)
})

test('isolated bridge staging applies historical Linux patch before the minimal migration backport', async t => {
  const directory = await fs.mkdtemp(join(root, 'build/bridge-staging-test-'))
  await fs.rmdir(directory)
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const result = await stageBridge({ root, directory, sourceRepository: join(root, 'build/upstream-alpha.1-backup') })
  const read = file => JSON.parse(readFileSync(join(directory, file), 'utf8'))
  assert.equal(read('upstream.json').commit, '5badb15009ae1756c3afe0ae0cef1faafc290ccc')
  assert.equal(read('desktop.json').linuxRevision, BRIDGE_REVISION)
  assert.equal(read('build/upstream/package.json').version, '0.2.1-alpha.1')
  assert.equal(read('updates.json').desktopUpgrade.url, result.config.desktopUpgrade.url)
  assert.deepEqual(readFileSync(join(directory, 'scripts/build.py')), execFileSync('git', ['show', `${baseline}:scripts/build.py`], { cwd: root }))
  execFileSync('git', ['apply', '--reverse', '--check', join(directory, 'patches/linux.patch')], { cwd: join(directory, 'build/upstream'), stdio: 'pipe' })
  const diff = execFileSync('git', ['diff', 'HEAD'], { cwd: join(directory, 'build/upstream'), encoding: 'utf8' })
  assert.match(diff, /assertWholeDesktopStartupAllowed/)
  assert.deepEqual(readFileSync(join(directory, 'electron-builder.config.mjs')), readFileSync(join(root, 'electron-builder.config.mjs')))
  assert.doesNotMatch(diff, /readDesktopSettings/)
  assert.equal(read('bridge-build.json').officialTag, 'dsh-v0.2.1-alpha.1')
  assert.equal(read('bridge-build.json').sources['updates/migration-worker.mjs'], digest(readFileSync(join(directory, 'updates/migration-worker.mjs'))))
  assert.equal(read('bridge-build.json').sources['build/upstream/apps/desktop/src/main.ts'], digest(readFileSync(join(directory, 'build/upstream/apps/desktop/src/main.ts'))))
  await assert.rejects(stageBridge({ root, directory }), /already exists/)
})

test('real r7 check and install consume the signed same-epoch r8 bridge in an isolated HOME', async t => {
  const f = await legacyFixture(t)
  await f.manager.check('desktop')
  assert.equal(f.manager.status().desktop.availableLinuxRevision, BRIDGE_REVISION)
  let restarted, prepared = 0
  const result = await f.manager.installDesktop(async () => { prepared++; return true }, artifact => installUserDesktop({ ...artifact,
    root: f.installation, home: f.home, xdgDataHome: join(f.home, '.local/share') }), executable => { restarted = executable })
  assert.equal(result, true)
  assert.equal(prepared, 1)
  assert.notEqual(restarted, f.installed.executable)
  const actual = JSON.parse(await fs.readFile(join(f.installation, 'current/resources/app/workbench/desktop.json'), 'utf8'))
  assert.equal(actual.version, '0.2.1-alpha.1')
  assert.equal(actual.dataEpoch, 'dsh-0.2.1-alpha.1')
  assert.equal(actual.linuxRevision, BRIDGE_REVISION)
})

test('real r7 preserves signature, schema and epoch checks before staging any bridge', async t => {
  const f = await legacyFixture(t)
  for (const changes of [{ schemaVersion: 3 }, { dataEpoch: 'dsh-0.2.1-alpha.2', version: '0.2.1-alpha.2' }]) {
    f.responses.set(f.plan.config.desktop.url, Buffer.from(JSON.stringify(f.signed({ ...f.release, ...changes }))))
    await assert.rejects(f.manager.check('desktop'))
    assert.equal(f.manager.status().desktop.available, null)
  }
  const tampered = f.signed(f.release)
  tampered.payload = Buffer.from(JSON.stringify({ ...f.release, linuxRevision: BRIDGE_REVISION + 1 })).toString('base64')
  f.responses.set(f.plan.config.desktop.url, Buffer.from(JSON.stringify(tampered)))
  await assert.rejects(f.manager.check('desktop'), /签名/)
  f.responses.set(f.plan.config.desktop.url, Buffer.from(JSON.stringify(f.signed(f.release))))
  f.responses.set(f.release.asset.url, Buffer.from('tampered archive'))
  await f.manager.check('desktop')
  let installerCalled = false
  await assert.rejects(f.manager.installDesktop(async () => true, async () => { installerCalled = true }, () => {}), /摘要|大小/)
  assert.equal(installerCalled, false)
  assert.equal(await fs.realpath(join(f.installation, 'current/dsh-workbench')), f.installed.executable)
})
