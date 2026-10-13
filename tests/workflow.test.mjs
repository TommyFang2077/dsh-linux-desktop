import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import test from 'node:test'

const require = createRequire(new URL('../build/upstream/package.json', import.meta.url))
const workflow = require('js-yaml').load(readFileSync(new URL('../.github/workflows/linux-updates.yml', import.meta.url), 'utf8'))
const config = JSON.parse(readFileSync(new URL('../updates.json', import.meta.url), 'utf8'))
const desktop = JSON.parse(readFileSync(new URL('../desktop.json', import.meta.url), 'utf8'))

test('CI builds with read permission and publishes only explicit release tags, never signing keys', () => {
  assert.equal(workflow.permissions.contents, 'read')
  assert.deepEqual(workflow.on.push.tags, ['workbench-v*'])
  assert.equal(workflow.jobs.publish.if, "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/workbench-v')")
  assert.equal(workflow.jobs.publish.permissions.contents, 'write')
  assert.equal(workflow.jobs.build.steps.find(step => step.name === 'Sign independent kernel and desktop feeds').if, "env.HAS_SIGNING_KEY == 'true'")
  const upload = workflow.jobs.build.steps.find(step => step.uses === 'actions/upload-artifact@v4')
  assert.doesNotMatch(upload.with.path, /pem|key|RUNNER_TEMP/)
  for (const format of ['deb', 'rpm', 'tar.gz']) assert.ok(upload.with.path.includes(`linux-x64.${format}`))
  const sign = workflow.jobs.build.steps.find(step => step.name === 'Sign independent kernel and desktop feeds').run
  assert.match(sign, /--deb /)
  assert.match(sign, /--rpm /)
  const publish = workflow.jobs.publish.steps.find(step => step.run?.includes('gh release create')).run
  assert.ok(publish.indexOf('gh release create') < publish.indexOf('git -C "$feed" add'))
  assert.doesNotMatch(publish, /--force|--clobber/)
  for (const format of ['deb', 'rpm', 'tar.gz']) assert.ok(publish.includes(`linux-x64.${format}`))
})

test('CI prepares real packaged runtimes before testing the public afterPack verification hook', () => {
  const build = workflow.jobs.build.steps.find(step => step.name === 'Prepare, test and package official Linux sources').run
  assert.ok(build.includes('make package') && build.includes('make test'))
  assert.ok(build.indexOf('make package') < build.indexOf('make test'))
  assert.ok(build.includes('dsh-0.2.1-alpha.1'))
  for (const file of ['bridge-update', 'workflow', 'manifest']) assert.ok(build.includes(`tests/${file}.test.mjs`))
  assert.ok(workflow.jobs.build.steps.some(step => step.run?.includes('git fetch --depth=1 origin tag workbench-v0.2.1-alpha.1-r7')))
  assert.ok(workflow.jobs.build.steps.some(step => step.run?.includes('kernel.apparmor_restrict_unprivileged_userns=0')))
})

test('CI preflight validates feeds, permits unsigned branch builds and refuses release tags without signing keys', () => {
  const script = workflow.jobs.build.steps.find(step => step.name === 'Check release configuration').run
  const run = changes => execFileSync('bash', ['-euo', 'pipefail', '-c', script], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, GITHUB_REPOSITORY: 'TommyFang2077/dsh-linux-desktop', HAS_SIGNING_KEY: 'true',
      GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: `workbench-v${desktop.version}-r${desktop.linuxRevision}`, ...changes },
    stdio: 'pipe',
  })
  for (const channel of ['kernel', 'desktop']) {
    const suffix = desktop.dataEpoch === 'dsh-0.2.1-alpha.1' ? '' : `-${desktop.dataEpoch}`
    assert.equal(config[channel].url, `https://raw.githubusercontent.com/TommyFang2077/dsh-linux-desktop/update-feed/${channel}${suffix}-latest.json`)
  }
  assert.equal(config.desktopUpgrade.url, 'https://raw.githubusercontent.com/TommyFang2077/dsh-linux-desktop/update-feed/desktop-dsh-0.2.1-alpha.2-latest.json')
  assert.equal(config.desktopUpgrade.publicKey, config.desktop.publicKey)
  run({})
  run({ HAS_SIGNING_KEY: 'false', GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'main' })
  assert.throws(() => run({ HAS_SIGNING_KEY: 'false' }), /Command failed/)
  assert.throws(() => run({ GITHUB_REF_NAME: 'workbench-v999.0.0' }), /Command failed/)
  assert.throws(() => run({ GITHUB_REPOSITORY: 'untrusted/fork' }), /Command failed/)
})

test('CI preflight refuses relabelled alpha.2 source as an alpha.1 bridge', async t => {
  const directory = await mkdtemp('/tmp/workbench-ci-source-test-')
  t.after(() => rm(directory, { recursive: true, force: true }))
  await mkdir(join(directory, 'scripts'))
  await cp(new URL('../scripts/build-bridge.mjs', import.meta.url), join(directory, 'scripts/build-bridge.mjs'))
  const upstream = { ...JSON.parse(readFileSync(new URL('../upstream.json', import.meta.url), 'utf8')),
    version: '0.2.1-alpha.2', commit: 'd743267388641bc76f17c45ce8b4c231aed1d32c' }
  const legacy = { ...desktop, version: '0.2.1-alpha.1', dataEpoch: 'dsh-0.2.1-alpha.1', linuxRevision: 8 }
  const sources = structuredClone(config)
  for (const channel of ['kernel', 'desktop']) sources[channel].url = `https://raw.githubusercontent.com/TommyFang2077/dsh-linux-desktop/update-feed/${channel}-latest.json`
  await writeFile(join(directory, 'desktop.json'), JSON.stringify(legacy))
  await writeFile(join(directory, 'upstream.json'), JSON.stringify(upstream))
  await writeFile(join(directory, 'updates.json'), JSON.stringify(sources))
  const script = workflow.jobs.build.steps.find(step => step.name === 'Check release configuration').run
  const run = () => execFileSync('bash', ['-euo', 'pipefail', '-c', script], {
    cwd: directory, env: { ...process.env, GITHUB_REPOSITORY: 'TommyFang2077/dsh-linux-desktop', HAS_SIGNING_KEY: 'false', GITHUB_REF_TYPE: 'branch' }, stdio: 'pipe',
  })
  assert.throws(run, /Command failed/)
  await writeFile(join(directory, 'upstream.json'), JSON.stringify({ ...upstream, version: legacy.version, commit: '5badb15009ae1756c3afe0ae0cef1faafc290ccc', pnpm: '11.7.0' }))
  run()
})

test('CI rejects a private key that does not match the public keys shipped to users', async t => {
  const script = workflow.jobs.build.steps.find(step => step.name === 'Sign independent kernel and desktop feeds').run
    .match(/node --input-type=module - "\$key" <<'JS'\n([\s\S]*?)\nJS/)[1]
  const directory = await mkdtemp('/tmp/workbench-ci-key-test-')
  t.after(() => rm(directory, { recursive: true, force: true }))
  const pair = generateKeyPairSync('ed25519')
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' })
  const key = join(directory, 'key.pem')
  await writeFile(key, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  await writeFile(join(directory, 'updates.json'), JSON.stringify({ kernel: { publicKey }, desktop: { publicKey }, desktopUpgrade: { publicKey } }))
  const run = () => execFileSync(process.execPath, ['--input-type=module', '-', key], { input: script, cwd: directory, stdio: 'pipe' })
  run()
  const wrong = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' })
  await writeFile(join(directory, 'updates.json'), JSON.stringify({ kernel: { publicKey }, desktop: { publicKey: wrong }, desktopUpgrade: { publicKey } }))
  assert.throws(run, /Command failed/)
  await writeFile(join(directory, 'updates.json'), JSON.stringify({ kernel: { publicKey }, desktop: { publicKey }, desktopUpgrade: { publicKey: wrong } }))
  assert.throws(run, /Command failed/)
})
