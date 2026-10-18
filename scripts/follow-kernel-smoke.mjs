/** Authenticate a released old shell, then exercise this build's real official kernel through it. */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform } from 'node:stream'
import { createWriteStream } from 'node:fs'
import { fileHash, UpdateManager, verifyFeed } from '../build/update-core.mjs'
import { installUserDesktop } from '../build/user-install.mjs'
import { releaseFeedNames } from './build-bridge.mjs'

const root = resolve(import.meta.dirname, '..')
const json = async path => JSON.parse(await fs.readFile(path, 'utf8'))
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
const candidate = await json(join(root, 'desktop.json'))
const upstream = await json(join(root, 'upstream.json'))
const output = join(root, 'dist/kernel-adaptation.json')
await fs.rm(output, { force: true })
if (candidate.followOfficial !== true) {
  await fs.mkdir(join(root, 'dist'), { recursive: true })
  await fs.writeFile(output, JSON.stringify({ schemaVersion: 1, mode: 'legacy', reason: 'This historical shell has no official-kernel follow capability' }) + '\n')
  console.log('Legacy desktop: official-kernel-follow smoke is not applicable')
  process.exit(0)
}
let sourceSha = process.env.DSH_FOLLOW_BASE_SHA || process.env.BASE_SHA || git('rev-parse', 'HEAD^')
assert.match(sourceSha, /^[0-9a-f]{40}$/, 'The baseline must be an exact trusted commit SHA')
const mainDesktop = JSON.parse(git('show', `${sourceSha}:desktop.json`))
const trustedConfig = JSON.parse(git('show', `${sourceSha}:updates.json`))
let baseline = mainDesktop
let config = trustedConfig
const policy = await json(join(root, 'scripts/upstream-policy.json'))
const bootstrap = mainDesktop.followOfficial !== true
if (bootstrap) {
  const approved = policy.automaticRelease?.bootstrap
  assert.ok(approved, 'A baseline without follow support requires the explicitly authorized bootstrap')
  assert.equal(candidate.version, approved.version)
  assert.equal(candidate.linuxRevision, approved.linuxRevision)
  assert.equal(candidate.dataEpoch, approved.dataEpoch)
  assert.equal(baseline.version, candidate.version, 'Bootstrap cannot pretend to test a newer official kernel')
  assert.ok(baseline.linuxRevision < candidate.linuxRevision)
} else {
  const shell = policy.automaticRelease?.shellBaseline
  assert.ok(shell, 'The trusted policy must identify the oldest supported published shell')
  assert.match(shell.version, /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/)
  assert.ok(Number.isSafeInteger(shell.linuxRevision) && shell.linuxRevision > 0)
  const tag = `workbench-v${shell.version}-r${shell.linuxRevision}`
  git('fetch', '--depth=1', 'origin', 'tag', tag)
  sourceSha = git('rev-parse', `refs/tags/${tag}^{commit}`)
  assert.match(sourceSha, /^[0-9a-f]{40}$/)
  baseline = JSON.parse(git('show', `${sourceSha}:desktop.json`))
  config = JSON.parse(git('show', `${sourceSha}:updates.json`))
  for (const [key, value] of Object.entries(shell)) assert.deepEqual(baseline[key], value, `Policy shell baseline differs: ${key}`)
  assert.equal(baseline.followOfficial, true, 'The published baseline shell must already support official kernels')
  assert.equal(config.desktop.publicKey, trustedConfig.desktop.publicKey, 'A release tag cannot replace the trusted update key')
}
const shellMaintenance = !bootstrap && candidate.version === baseline.version
if (shellMaintenance) {
  assert.ok(candidate.linuxRevision >= baseline.linuxRevision, 'Shell maintenance cannot decrease the baseline revision')
  assert.equal(candidate.dataEpoch, baseline.dataEpoch)
  assert.equal(upstream.commit, policy.sources[baseline.version]?.commit, 'Shell maintenance must retain the exact official kernel')
}
const directory = join(root, 'dist/kernel-release')
const archives = (await fs.readdir(directory)).filter(name => /^dsh-kernel-.+-linux-x64\.tgz$/.test(name))
assert.equal(archives.length, 1, 'Exactly one actual kernel artifact is required')
const kernel = join(directory, archives[0])
const kernelSha256 = await fileHash(kernel)
const temporary = await fs.mkdtemp('/tmp/dsh-official-kernel-follow-')
const smokeResult = join(temporary, 'result.json')
const home = join(temporary, 'home')
await fs.mkdir(home, { mode: 0o700 })
const response = url => UpdateManager.prototype.response.call({ fetch }, url, 600_000)
async function runSmoke(environment) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, 'scripts/kernel-update-smoke.mjs')], {
      cwd: root, env: { ...process.env, DSH_WORKBENCH_TEST_RESULT: smokeResult, ...environment }, stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Kernel UI smoke failed: code=${code}, signal=${signal}`)))
  })
  return json(smokeResult)
}
try {
  let result
  if (bootstrap) {
    console.log(`BOOTSTRAP ONLY: ${baseline.version}-r${baseline.linuxRevision} has no kernel-follow updater; exercising the new same-epoch updater fixture`)
    result = await runSmoke({ DSH_WORKBENCH_TEST_APP: '', DSH_WORKBENCH_TEST_KERNEL: '', DSH_WORKBENCH_TEST_METADATA: '', DSH_WORKBENCH_TEST_HOME: '' })
    assert.equal(result.backupVerified, true)
  } else {
    const repository = upstream.repository && git('remote', 'get-url', 'origin').match(/(?:github\.com[:/])([^/]+\/[^/]+?)(?:\.git)?$/)?.[1]
    assert.match(repository ?? '', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
    const tag = `workbench-v${baseline.version}-r${baseline.linuxRevision}`
    const base = `https://github.com/${repository}/releases/download/${tag}/`
    const feed = await response(base + releaseFeedNames(baseline).desktop)
    assert.ok(feed.ok, `Published baseline desktop feed is unavailable: HTTP ${feed.status}`)
    const envelope = await feed.json()
    const release = verifyFeed(envelope, config.desktop.publicKey, 'desktop')
    for (const [key, value] of Object.entries(baseline)) assert.deepEqual(release[key], value, `Signed baseline mismatch: ${key}`)
    const name = `dsh-workbench-${baseline.version}-r${baseline.linuxRevision}-linux-x64.tar.gz`
    assert.equal(release.asset.url, base + name, 'The authenticated baseline must come from its exact release')
    if (shellMaintenance) {
      console.log(`SHELL MAINTENANCE ONLY: authenticated ${baseline.version}-r${baseline.linuxRevision}; exercising the newly built shell with a same-epoch fixture`)
      result = await runSmoke({ DSH_WORKBENCH_TEST_APP: '', DSH_WORKBENCH_TEST_KERNEL: '', DSH_WORKBENCH_TEST_METADATA: '', DSH_WORKBENCH_TEST_HOME: '' })
      assert.equal(result.backupVerified, true)
    } else {
      const archive = join(temporary, name)
      const download = await response(release.asset.url)
      assert.ok(download.ok && download.body, `Published baseline archive is unavailable: HTTP ${download.status}`)
      let size = 0
      const digest = createHash('sha256')
      await pipeline(Readable.fromWeb(download.body), new Transform({ transform(chunk, _encoding, done) {
        size += chunk.length
        if (size > release.asset.size) return done(new Error('Baseline download exceeds signed size'))
        digest.update(chunk); done(null, chunk)
      } }), createWriteStream(archive, { flags: 'wx', mode: 0o600 }))
      assert.equal(size, release.asset.size)
      assert.equal(digest.digest('hex'), release.asset.sha256)
      const installed = await installUserDesktop({ archive, sha256: release.asset.sha256, version: baseline.version,
        home, root: join(home, 'Applications/dsh-linux-desktop'), xdgDataHome: join(home, 'data') })
      const metadata = await json(join(installed.executable, '..', 'resources/app/workbench/desktop.json'))
      assert.deepEqual(metadata, baseline, 'The executable must be the authentic old published shell')
      result = await runSmoke({ DSH_WORKBENCH_TEST_APP: installed.executable, DSH_WORKBENCH_TEST_KERNEL: kernel,
        DSH_WORKBENCH_TEST_METADATA: join(root, 'desktop.json'), DSH_WORKBENCH_TEST_HOME: home })
      assert.equal(result.kernelSha256, kernelSha256)
      assert.equal(result.backupVerified, true)
    }
  }
  assert.equal(result.kernelHealthy, true)
  assert.equal(result.desktopUnchanged, true)
  const evidence = { schemaVersion: 1, mode: bootstrap ? 'bootstrap' : shellMaintenance ? 'shell' : 'kernel',
    candidate: { version: candidate.version, linuxRevision: candidate.linuxRevision, dataEpoch: candidate.dataEpoch,
      upstreamCommit: upstream.commit, kernelSha256 },
    baseline: { sourceSha, version: baseline.version, linuxRevision: baseline.linuxRevision, followOfficial: baseline.followOfficial === true },
    kernelHealthy: true, desktopUnchanged: true, backupVerified: result.backupVerified }
  await fs.writeFile(output, JSON.stringify(evidence, null, 2) + '\n')
  console.log(`Kernel adaptation evidence: ${output}; mode=${evidence.mode}`)
} finally {
  await fs.rm(temporary, { recursive: true, force: true })
}
