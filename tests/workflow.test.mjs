import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import test from 'node:test'

const require = createRequire(new URL('../build/upstream/package.json', import.meta.url))
const workflow = require('js-yaml').load(readFileSync(new URL('../.github/workflows/linux-updates.yml', import.meta.url), 'utf8'))
const tagged = require('js-yaml').load(readFileSync(new URL('../.github/workflows/linux-release.yml', import.meta.url), 'utf8'))
const publication = require('js-yaml').load(readFileSync(new URL('../.github/workflows/publish-updates.yml', import.meta.url), 'utf8'))
const automation = require('js-yaml').load(readFileSync(new URL('../.github/workflows/upstream-release.yml', import.meta.url), 'utf8'))
const config = JSON.parse(readFileSync(new URL('../updates.json', import.meta.url), 'utf8'))
const desktop = JSON.parse(readFileSync(new URL('../desktop.json', import.meta.url), 'utf8'))

test('CI builds with read permission and publishes only explicit release tags, never signing keys', () => {
  assert.equal(workflow.permissions.contents, 'read')
  assert.deepEqual(tagged.on.push.tags, ['workbench-v*'])
  assert.equal(workflow.jobs.publish, undefined)
  assert.equal(workflow.on.push.tags, undefined)
  assert.equal(tagged.jobs.publish.permissions.contents, 'write')
  assert.doesNotMatch(JSON.stringify(workflow.jobs.build), /secrets|UPDATE_SIGNING_KEY/)
  assert.equal(tagged.jobs.publish.uses, './.github/workflows/publish-updates.yml')
  assert.equal(publication.jobs.publish.steps.find(step => step.name === 'Sign verified data only on a fresh runner').run, 'node scripts/sign-release.mjs artifacts')
  const upload = workflow.jobs.build.steps.find(step => step.uses === 'actions/upload-artifact@v4')
  assert.doesNotMatch(upload.with.path, /pem|key|RUNNER_TEMP/)
  for (const format of ['deb', 'rpm', 'tar.gz']) assert.ok(upload.with.path.includes(`linux-x64.${format}`))
  const sign = workflow.jobs.build.steps.find(step => step.name === 'Prepare unsigned release payloads with a disposable key').run
  assert.match(sign, /--deb /)
  assert.match(sign, /--rpm /)
  const publish = publication.jobs.publish.steps.find(step => step.run?.includes('python3 scripts/publish-release.py')).run
  assert.ok(publish.indexOf('python3 scripts/publish-release.py') < publish.indexOf('git -C "$feed" add'))
  assert.doesNotMatch(publish, /--force|--clobber/)
  const publisher = readFileSync(new URL('../scripts/publish-release.py', import.meta.url), 'utf8')
  for (const format of ['deb', 'rpm', 'tar.gz']) assert.ok(publisher.includes(`linux-x64.${format}`))
  assert.doesNotMatch(publisher, /--clobber|--force/)
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

test('CI preflight validates feeds, official pins and tag identity without access to signing keys', () => {
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
  run({ HAS_SIGNING_KEY: 'false' })
  assert.throws(() => run({ GITHUB_REF_NAME: 'workbench-v999.0.0' }), /Command failed/)
  assert.throws(() => run({ GITHUB_REPOSITORY: 'untrusted/fork' }), /Command failed/)
})

test('CI preflight refuses relabelled alpha.2 source as an alpha.1 bridge', async t => {
  const directory = await mkdtemp('/tmp/workbench-ci-source-test-')
  t.after(() => rm(directory, { recursive: true, force: true }))
  await mkdir(join(directory, 'scripts'))
  await cp(new URL('../scripts/build-bridge.mjs', import.meta.url), join(directory, 'scripts/build-bridge.mjs'))
  await cp(new URL('../scripts/upstream-policy.json', import.meta.url), join(directory, 'scripts/upstream-policy.json'))
  const upstream = { ...JSON.parse(readFileSync(new URL('../upstream.json', import.meta.url), 'utf8')),
    version: '0.2.1-alpha.2', commit: 'd743267388641bc76f17c45ce8b4c231aed1d32c' }
  const legacy = { ...desktop, version: '0.2.1-alpha.1', dataEpoch: 'dsh-0.2.1-alpha.1', linuxRevision: 9 }
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

test('scheduled automation invokes tests and publication explicitly, not suppressed token events', () => {
  assert.deepEqual(automation.on.schedule, [{ cron: '17 */6 * * *' }])
  assert.equal(automation.permissions.contents, 'read')
  assert.equal(automation.jobs.test.uses, './.github/workflows/linux-updates.yml')
  assert.deepEqual(automation.jobs.test.permissions, { contents: 'read' })
  assert.equal(automation.jobs.test.secrets, undefined)
  assert.equal(automation.jobs.promote.permissions.statuses, 'write')
  for (const job of Object.values(workflow.jobs)) assert.notEqual(job.permissions?.contents, 'write')
  assert.equal(automation.jobs.test.with.source_sha, '${{ needs.discover.outputs.head }}')
  assert.deepEqual(automation.jobs.promote.needs, ['discover', 'test'])
  assert.match(automation.jobs.promote.if, /success.*eligible/)
  assert.equal(automation.jobs.promote.steps[0].with.ref, '${{ github.sha }}')
  assert.equal(automation.jobs.publish.uses, './.github/workflows/publish-updates.yml')
  assert.equal(automation.jobs.publish.with.source_sha, '${{ needs.promote.outputs.sha }}')
  assert.equal(automation.jobs.publish.with.artifact, '${{ needs.test.outputs.artifact }}')
  assert.equal(publication.on.workflow_dispatch, undefined)
  assert.equal(publication.on.pull_request_target, undefined)
  assert.doesNotMatch(JSON.stringify(publication.jobs.publish.steps), /npm install|make package|build\/release-updates/)
  for (const job of ['discover', 'promote']) {
    assert.equal(automation.jobs[job].steps[0].with['persist-credentials'], false)
    assert.doesNotMatch(JSON.stringify(automation.jobs[job]), /secrets|needs.discover.outputs.head.*ref/)
  }
})

test('AI repair isolates model, validation, write control plane and untrusted build', () => {
  const manual = require('js-yaml').load(readFileSync(new URL('../.github/workflows/approve-ai-repair.yml', import.meta.url), 'utf8'))
  const service = JSON.parse(readFileSync(new URL('../scripts/upstream-repair-service.json', import.meta.url), 'utf8'))
  assert.deepEqual(service, { enabled: false, endpoint: '', model: '' })
  assert.match(automation.jobs.repair.if, /conflict.*enabled/)
  for (const name of ['probe', 'repair', 'validate-repair', 'submit-repair']) {
    const job = automation.jobs[name]
    assert.equal(job['timeout-minutes'], 10)
    assert.equal(job.steps[0].with.ref, '$' + '{{ github.sha }}')
    assert.equal(job.steps[0].with['persist-credentials'], false)
    assert.doesNotMatch(JSON.stringify(job), /actions[/]cache|secrets[.]UPDATE_SIGNING_KEY|secrets[.]DESKTOP_SIGNING_KEY/)
    if (name !== 'submit-repair') assert.ok(Object.values(job.permissions).every(value => value === 'read'))
    if (name !== 'repair') assert.doesNotMatch(JSON.stringify(job), /secrets./)
  }
  assert.deepEqual(automation.jobs['test-repair'].permissions, { contents: 'read' })
  assert.equal(automation.jobs['test-repair'].secrets, undefined)
  assert.equal(automation.jobs['test-repair'].with.unreviewed, true)
  assert.equal(automation.jobs['test-repair'].with.source_sha, '$' + '{{ needs.submit-repair.outputs.head }}')
  assert.equal(automation.jobs['test-repair'].needs, 'submit-repair')
  assert.equal(automation.jobs['submit-repair'].permissions.statuses, 'write')
  const record = automation.jobs['submit-repair'].steps.find(step => step.env?.MODE === 'record-provenance')
  assert.equal(record.env.ARTIFACT_ID, '$' + '{{ steps.provenance.outputs.artifact-id }}')
  assert.equal(record.env.ARTIFACT_DIGEST, '$' + '{{ steps.provenance.outputs.artifact-digest }}')
  assert.ok(automation.jobs['submit-repair'].steps.indexOf(record) > automation.jobs['submit-repair'].steps.findIndex(step => step.id === 'provenance'))
  assert.doesNotMatch(JSON.stringify(automation.jobs.promote.needs), /repair/)
  assert.doesNotMatch(JSON.stringify(automation.jobs.publish.needs), /repair/)
  assert.deepEqual(Object.keys(manual.on), ['workflow_dispatch'])
  const approval = Object.values(manual.jobs)[0]
  assert.deepEqual(approval.permissions, { contents: 'read', 'pull-requests': 'read', statuses: 'write', actions: 'read' })
  assert.match(approval.if, /default_branch/)
  assert.doesNotMatch(JSON.stringify(manual), /secrets|[/]merge|publish-updates|refs[/]tags/)
  const controller = readFileSync(new URL('../scripts/upstream-repair.py', import.meta.url), 'utf8')
  assert.doesNotMatch(controller, /[/]pulls[/].*[/]merge|refs[/]tags[/]/)
})

test('the pinned release keeps its approved historical migration feed and rejects an unauthorized URL', async t => {
  const directory = await mkdtemp('/tmp/dsh-workflow-migration-')
  t.after(() => rm(directory, { recursive: true, force: true }))
  await mkdir(join(directory, 'scripts'))
  for (const name of ['scripts/build-bridge.mjs', 'scripts/upstream-policy.json', 'desktop.json', 'upstream.json']) await cp(new URL('../' + name, import.meta.url), join(directory, name))
  const source = structuredClone(config)
  assert.ok(source.kernel.url.endsWith(`/kernel-${desktop.dataEpoch}-latest.json`))
  assert.ok(source.desktop.url.endsWith(`/desktop-${desktop.dataEpoch}-latest.json`))
  const script = workflow.jobs.build.steps.find(step => step.name === 'Check release configuration').run
  const run = () => execFileSync('bash', ['-euo', 'pipefail', '-c', script], {
    cwd: directory, env: { ...process.env, ALLOW_UNREVIEWED: 'false', GITHUB_REPOSITORY: 'TommyFang2077/dsh-linux-desktop', GITHUB_REF_TYPE: 'branch' }, stdio: 'pipe',
  })
  await writeFile(join(directory, 'updates.json'), JSON.stringify(source))
  run()
  source.desktopUpgrade.url = source.desktop.url
  await writeFile(join(directory, 'updates.json'), JSON.stringify(source))
  assert.throws(run, /Command failed/)
  source.desktopUpgrade.url = 'https://attacker.example/desktop-dsh-0.2.1-alpha.2-latest.json'
  await writeFile(join(directory, 'updates.json'), JSON.stringify(source))
  assert.throws(run, /Command failed/)
})
