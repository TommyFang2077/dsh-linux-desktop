import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { join, relative } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const cli = fileURLToPath(new URL('../scripts/whole-desktop-smoke.mjs', import.meta.url))
const invoke = (args, environment = {}) => spawnSync(process.execPath, [cli, ...args], {
  encoding: 'utf8', timeout: 10_000, env: { ...process.env, ...environment },
})

test('whole desktop smoke describes isolated artifacts without starting a desktop', () => {
  const result = invoke(['--help'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Usage:.*whole-desktop-smoke/su)
  assert.match(result.stdout, /--preflight-only/u)
  assert.match(result.stdout, /--bridge-archive/u)
  assert.match(result.stdout, /--desktop-archive/u)
})

test('durable user data fixture is explicit and requires a complete normal migration', () => {
  const help = invoke(['--help'])
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /--user-data-fixture/u)
  for (const args of [['--preflight-only', '--user-data-fixture'], ['--bridge-only', '--user-data-fixture'],
    ['--fault', 'cancel', '--user-data-fixture']]) {
    const result = invoke(args)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /User data fixture requires a complete normal migration/u)
    assert.equal(result.stdout, '')
  }
})

test('preflight confines every writable runtime path and leaves caller data untouched', async t => {
  const home = await fs.mkdtemp('/tmp/dsh-smoke-caller-')
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const sentinel = join(home, 'caller-data.txt')
  await fs.writeFile(sentinel, 'caller data remains here\n')
  const result = invoke(['--preflight-only'], {
    HOME: home, DSH_HOME: join(home, 'old-dsh'), XDG_RUNTIME_DIR: join(home, 'old-runtime'),
    DSH_WORKBENCH_UPDATE_CONFIG: join(home, 'production-config.json'),
    NODE_OPTIONS: '', TEST_API_KEY: 'test-sentinel-secret',
  })
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.mode, 'preflight-only')
  assert.equal(report.callerMetadataUnchanged, true)
  assert.match(report.root, /^\/tmp\/dsh-whole-desktop-smoke-/u)
  for (const key of ['HOME', 'DSH_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
    'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'TMPDIR']) {
    const path = relative(report.root, report.environment[key])
    assert.ok(path && !path.startsWith('..'), `${key} escapes disposable root`)
    assert.equal(report.permissions[key], 0o700)
  }
  for (const key of ['TEST_API_KEY', 'DSH_WORKBENCH_UPDATE_CONFIG', 'NODE_OPTIONS']) {
    assert.equal(report.environment[key], undefined)
  }
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'caller data remains here\n')
  await assert.rejects(fs.stat(report.root), { code: 'ENOENT' })
})

test('ambiguous options and untrusted artifacts fail before touching caller paths', async t => {
  const home = await fs.mkdtemp('/tmp/dsh-smoke-guard-')
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const archive = join(home, 'desktop.tar.gz')
  await fs.writeFile(archive, 'untrusted archive\n')
  for (const [args, diagnostic] of [
    [[], /Usage:/u],
    [['--temporary-root', home], /Unknown option: --temporary-root/u],
    [['--help', '--unexpected'], /Unknown option: --unexpected/u],
    [['--bridge-archive', archive], /Missing --bridge-sha256/u],
    [['--bridge-archive', archive, '--bridge-sha256', 'invalid'], /Invalid --bridge-sha256/u],
    [['--preflight-only', '--preflight-only'], /Duplicate option: --preflight-only/u],
    [['--fault', 'invented'], /Invalid --fault/u],
    [['--resume-transaction', '/tmp/not-a-transaction.json'], /Resume requires an owned private transaction/u],
    [['--corrupt-maps'], /--corrupt-maps requires --resume-transaction/u],
  ]) {
    const result = invoke(args, { HOME: home, DSH_HOME: join(home, 'dsh') })
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, diagnostic)
    assert.equal(result.stdout, '')
    assert.deepEqual(await fs.readdir(home), ['desktop.tar.gz'])
    assert.equal(await fs.readFile(archive, 'utf8'), 'untrusted archive\n')
  }
})

test('preflight verifies recorded archive bytes and rejects linked inputs before setup', async t => {
  const home = await fs.mkdtemp('/tmp/dsh-smoke-hash-')
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const archive = join(home, 'fixture.tar.gz'), link = join(home, 'linked.tar.gz')
  await fs.writeFile(archive, 'abc')
  await fs.symlink(archive, link)
  const sha256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  const args = path => ['--preflight-only', '--bridge-archive', path, '--bridge-sha256', sha256]
  const good = invoke(args(archive), { HOME: home })
  assert.equal(good.status, 0, good.stderr)
  assert.deepEqual(JSON.parse(good.stdout).artifacts, [{ kind: 'bridge', path: archive, sha256, size: 3 }])
  for (const [input, diagnostic] of [
    [args(link), /Archive must be a regular unlinked file/u],
    [[...args(archive).slice(0, -1), '0'.repeat(64)], /Archive SHA-256 differs from recorded trust/u],
  ]) {
    const result = invoke(input, { HOME: home })
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, diagnostic)
    assert.equal(result.stdout, '')
    assert.deepEqual(await fs.readdir(home), ['fixture.tar.gz', 'linked.tar.gz'])
  }
})

test('full smoke rejects malformed physical archives before running any desktop', async t => {
  const home = await fs.mkdtemp('/tmp/dsh-smoke-invalid-archive-')
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const archive = join(home, 'fixture.tar.gz')
  await fs.writeFile(archive, 'abc')
  const hash = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  const result = invoke(['--bridge-archive', archive, '--bridge-sha256', hash,
    '--desktop-archive', archive, '--desktop-sha256', hash], { HOME: home })
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /Archive identity verification failed/u)
  assert.equal(result.stdout, '')
  assert.deepEqual(await fs.readdir(home), ['fixture.tar.gz'])
})

test('bridge-only accepts only the real alpha one revision eight artifact identity', async t => {
  const home = await fs.mkdtemp('/tmp/dsh-smoke-wrong-epoch-')
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const metadata = join(home, 'app/resources/app/workbench')
  await fs.mkdir(metadata, { recursive: true })
  await fs.writeFile(join(metadata, 'desktop.json'), JSON.stringify({ version: '0.2.1-alpha.2',
    linuxRevision: 2, dataEpoch: 'dsh-0.2.1-alpha.2', nodeVersion: '24.21.0' }))
  const archive = join(home, 'wrong-bridge.tar.gz')
  const tar = spawnSync('tar', ['-czf', archive, '-C', home, 'app'], { encoding: 'utf8' })
  assert.equal(tar.status, 0, tar.stderr)
  const sha = createHash('sha256').update(await fs.readFile(archive)).digest('hex')
  const result = invoke(['--bridge-only', '--bridge-archive', archive, '--bridge-sha256', sha], { HOME: home })
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /bridge archive identity differs/u)
})

test('preflight copies only a private temporary Xvfb authority into its disposable root', async t => {
  const home = await fs.mkdtemp('/tmp/dsh-smoke-display-')
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const authority = join(home, 'Xauthority')
  await fs.writeFile(authority, 'temporary-display-fixture', { mode: 0o600 })
  const result = invoke(['--preflight-only', '--keep'], { HOME: home, XAUTHORITY: authority })
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  t.after(() => fs.rm(report.root, { recursive: true, force: true }))
  assert.equal(report.environment.XAUTHORITY, join(report.root, 'test-Xauthority'))
  assert.equal(await fs.readFile(report.environment.XAUTHORITY, 'utf8'), 'temporary-display-fixture')
  assert.equal((await fs.stat(report.environment.XAUTHORITY)).mode & 0o777, 0o600)
  assert.equal(await fs.readFile(authority, 'utf8'), 'temporary-display-fixture')
})

test('an isolated driver still records its explicitly protected HOME metadata guard', async t => {
  const home = await fs.mkdtemp('/tmp/dsh-smoke-protected-')
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const result = invoke(['--preflight-only'], { DSH_SMOKE_PROTECTED_HOME: home })
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.protectedHome, home)
  assert.equal(report.callerMetadataUnchanged, true)
})

if (process.env.DSH_SMOKE_REAL_DATA === '1') {
  test('real signed migration preserves public session history and custom settings through new Host and complete restore', async t => {
    const driver = await fs.mkdtemp('/tmp/dsh-smoke-real-data-driver-')
    t.after(() => fs.rm(driver, { recursive: true, force: true }))
    const directories = { HOME: 'home', DSH_HOME: 'home/dsh', XDG_CONFIG_HOME: 'home/config', XDG_DATA_HOME: 'home/data',
      XDG_CACHE_HOME: 'home/cache', XDG_STATE_HOME: 'home/state', XDG_RUNTIME_DIR: 'runtime', TMPDIR: 'tmp' }
    const environment = { PATH: process.env.PATH, LANG: 'C.UTF-8',
      DSH_SMOKE_PROTECTED_HOME: process.env.DSH_SMOKE_PROTECTED_HOME ?? process.env.HOME }
    for (const [name, path] of Object.entries(directories)) {
      environment[name] = join(driver, path)
      await fs.mkdir(environment[name], { recursive: true, mode: 0o700 })
    }
    const options = []
    for (const [flag, variable] of [['--bridge-archive', 'DSH_SMOKE_BRIDGE_ARCHIVE'], ['--bridge-sha256', 'DSH_SMOKE_BRIDGE_SHA256'],
      ['--desktop-archive', 'DSH_SMOKE_DESKTOP_ARCHIVE'], ['--desktop-sha256', 'DSH_SMOKE_DESKTOP_SHA256']]) {
      assert.ok(process.env[variable], `Real data smoke requires ${variable}`)
      options.push(flag, process.env[variable])
    }
    const result = spawnSync('xvfb-run', ['-a', 'unshare', '--user', '--map-current-user', '--pid', '--fork', '--mount-proc',
      process.execPath, cli, '--user-data-fixture', '--keep', ...options], {
      env: environment, encoding: 'utf8', timeout: 600_000, maxBuffer: 16 * 1024 ** 2,
    })
    assert.equal(result.status, 0, result.stderr || result.stdout.slice(-4000))
    const report = JSON.parse(result.stdout.split('\n').findLast(line => line.startsWith('{"mode":')))
    console.error(`Real data evidence: ${report.root}; transaction ${report.migration.report.transactionId}`)
    const fixture = report.migration.publicUserData
    assert.ok(fixture, 'The admitted fixture must perform real public data validation')
    assert.equal(fixture.kind, 'public-metadata-history')
    assert.equal(fixture.modelExecution.performed, false)
    assert.deepEqual(fixture.modelExecution.requests, [])
    assert.ok(fixture.old.page.records.some(record => record.type === 'event' && record.event.seq === fixture.old.rename.seq))
    assert.deepEqual(fixture.upgraded.page.records, fixture.old.page.records)
    assert.deepEqual(report.migration.recovery.publicUserData.page.records, fixture.old.page.records)
    assert.equal(fixture.upgraded.projections.kind, 'sequenced')
    assert.equal(fixture.upgraded.settings.user.baseURL, fixture.old.settings.user.baseURL)
    assert.deepEqual(fixture.upgraded.settings.user.models, fixture.old.settings.user.models)
    assert.deepEqual(fixture.upgraded.inspector.identity.argv, [report.migration.report.executable])
    assert.equal(fixture.upgraded.inspector.identity.pid, report.migration.report.newDesktopPid)
    assert.equal(report.migration.backupComplete, true)
    assert.equal(report.migration.recovery.completeTreeVerifiedBeforeBoot, true)
    assert.equal(report.callerMetadataUnchanged, true)
  })
}
