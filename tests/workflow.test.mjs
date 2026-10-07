import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
  const publish = workflow.jobs.publish.steps.find(step => step.run?.includes('gh release create')).run
  assert.ok(publish.indexOf('gh release create') < publish.indexOf('git -C "$feed" add'))
  assert.doesNotMatch(publish, /--force|--clobber/)
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
    assert.equal(config[channel].url, `https://raw.githubusercontent.com/TommyFang2077/dsh-linux-desktop/update-feed/${channel}-latest.json`)
  }
  run({})
  run({ HAS_SIGNING_KEY: 'false', GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'main' })
  assert.throws(() => run({ HAS_SIGNING_KEY: 'false' }), /Command failed/)
  assert.throws(() => run({ GITHUB_REF_NAME: 'workbench-v999.0.0' }), /Command failed/)
  assert.throws(() => run({ GITHUB_REPOSITORY: 'untrusted/fork' }), /Command failed/)
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
  await writeFile(join(directory, 'updates.json'), JSON.stringify({ kernel: { publicKey }, desktop: { publicKey } }))
  const run = () => execFileSync(process.execPath, ['--input-type=module', '-', key], { input: script, cwd: directory, stdio: 'pipe' })
  run()
  const wrong = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' })
  await writeFile(join(directory, 'updates.json'), JSON.stringify({ kernel: { publicKey }, desktop: { publicKey: wrong } }))
  assert.throws(run, /Command failed/)
})
