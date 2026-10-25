import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import publicTest from 'node:test'
import { startWholeDesktopUpgrade, assertWholeDesktopStartupAllowed } from '../build/whole-desktop.mjs'
import { installUserDesktop } from '../build/user-install.mjs'
import { extractKernel, inventory, UpdateManager } from '../build/update-core.mjs'

const require = createRequire(new URL('../build/upstream/package.json', import.meta.url))
const tar = require('tar')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
// Isolate the real /proc view, not the production writer inspector. Missing namespace support fails the suite.
const isolated = process.env.DSH_WHOLE_DESKTOP_TEST_NAMESPACE === '1'
const test = isolated ? publicTest : () => {}

async function fixture(t, { acknowledge = true, rootMismatch, kernelMigration = false, writeBeforeFailure = false,
  kernelNodeVersion = '24.21.0', invalidKernelHealth = false } = {}) {
  const base = await fs.mkdtemp('/tmp/dsh-whole-desktop-test-')
  const reports = []
  t.after(async () => {
    for (const path of reports) {
      let status
      try { status = JSON.parse(await fs.readFile(path, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error; continue }
      for (const identity of [status.worker, status.newDesktopIdentity].filter(Boolean)) {
        const deadline = Date.now() + 5_000
        let stopped = false
        while (Date.now() < deadline) {
          try {
            const stat = await fs.readFile(`/proc/${identity.pid}/stat`, 'utf8')
            const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
            if (fields[0] === 'Z' || fields[19] !== identity.startTime) { stopped = true; break }
          } catch (error) { if (error.code === 'ENOENT') { stopped = true; break } throw error }
          await new Promise(resolve => setTimeout(resolve, 20))
        }
        assert.ok(stopped, `fixture process ${identity.pid} still owns its lifecycle; preserving HOME`)
      }
    }
    await fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })
  const home = join(base, 'home')
  await fs.mkdir(home, { mode: 0o700 })
  const root = join(home, 'Applications/dsh-linux-desktop')
  const dshHome = join(home, '.dsh')
  const userData = join(home, '.config/dsh-workbench')
  for (const path of [dshHome, userData]) await fs.mkdir(path, { recursive: true, mode: 0o700 })
  await fs.writeFile(join(dshHome, 'session.json'), '{"epoch":"old","text":"saved"}', { mode: 0o600 })
  await fs.writeFile(join(userData, 'settings.json'), '{"theme":"dark"}', { mode: 0o600 })
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  async function archive(version, dataEpoch, runtimeVersion = version) {
    const input = join(base, version)
    const app = join(input, 'app')
    const metadata = { version, linuxRevision: 7, protocol: 4, dataEpoch, desktopRange: '>=1 <3',
      nodeRange: '>=24 <25', kernelRange: '>=1 <2', nodeVersion: '24.21.0', electronVersion: '44.5.1' }
    const application = `import fs from 'node:fs/promises';
      import { assertWholeDesktopStartupAllowed, markWholeDesktopHealthy, validateKernelMigration } from ${JSON.stringify(new URL('../build/whole-desktop.mjs', import.meta.url).href)};
      await assertWholeDesktopStartupAllowed({ home: process.env.HOME, executable: process.env.DSH_FIXTURE_EXECUTABLE,
        dshHome: ${rootMismatch === 'dshHome' ? 'process.env.HOME + "/unexpected-runtime-home"' : 'process.env.DSH_HOME'},
        userData: process.env.HOME + ${JSON.stringify(rootMismatch === 'userData' ? '/unexpected-runtime-userData' : '/.config/dsh-workbench')} });
      ${kernelMigration ? `const state = JSON.parse(await fs.readFile(process.env.HOME + '/.config/dsh-workbench/updates/state.json', 'utf8'));
        const envelope = JSON.parse(await fs.readFile(process.env.HOME + '/.config/dsh-workbench/updates/kernels/' + state.active + '/release.json', 'utf8'));
        const release = JSON.parse(Buffer.from(envelope.payload, 'base64'));
        const kernel = { id: state.active, version: release.version, dataEpoch: release.dataEpoch };
        await validateKernelMigration({ home: process.env.HOME, userData: process.env.HOME + '/.config/dsh-workbench',
          kernelRoot: process.env.HOME + '/.config/dsh-workbench/updates', migration: state.migration,
          release: { version: kernel.version, dataEpoch: kernel.dataEpoch, asset: { sha256: kernel.id } } });` : ''}
      if (process.env.DSH_FIXTURE_REFUSE_KERNEL_HEALTH === '1') {
        await fs.writeFile(process.env.DSH_HOME + '/session.json', '{"epoch":"third","provider":"new-provider"}');
        process.exit(1);
      }
      ${writeBeforeFailure ? `await fs.writeFile(process.env.DSH_HOME + '/session.json', '{"epoch":"new","provider":"deepseek-search-api"}');` : ''}
      ${acknowledge ? `await markWholeDesktopHealthy({ home: process.env.HOME, version: ${JSON.stringify(version)}, executable: process.env.DSH_FIXTURE_EXECUTABLE${kernelMigration ? `, kernel: ${invalidKernelHealth ? "{ ...kernel, dataEpoch: 'incorrect-epoch' }" : 'kernel'}` : ''} });` : ''}
      ${acknowledge ? `if (process.env.DSH_WHOLE_DESKTOP_TRANSACTION !== undefined) throw new Error('Committed migration identity leaked into future restarts');
        await markWholeDesktopHealthy({ home: process.env.HOME, version: ${JSON.stringify(version)}, executable: process.env.DSH_FIXTURE_EXECUTABLE });` : ''}
      await fs.writeFile(process.env.HOME + '/new-started', process.env.DSH_WHOLE_DESKTOP_FAILED ?? 'started');`
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
    const files = {
      'dsh-workbench': `#!/bin/sh\nif [ "$ELECTRON_RUN_AS_NODE" = 1 ]; then printf "44.5.1\\n"; exit 0; fi\nexport DSH_FIXTURE_EXECUTABLE="$0"\nexec ${quote(process.execPath)} --input-type=module -e ${quote(application)}\n`,
      'resources/app/package.json': JSON.stringify({ name: 'dsh-workbench', version, linuxRevision: 7 }),
      'resources/app/help.dat': 'x'.repeat(32 * 1024),
      'resources/app/workbench/desktop.json': JSON.stringify(metadata),
      'resources/runtime/primary-runtime/runtime.json': JSON.stringify({ platform: 'linux', arch: 'x64', node: '24.21.0' }),
      'resources/runtime/primary-runtime/dependencies/node/bin/node': '#!/bin/sh\nprintf "v24.21.0\\n"\n',
    }
    const sharedPackages = ['dsh', 'dsh-desktop-host'].map(name => ({ name: `@deepseek-ai/${name}`,
      version: runtimeVersion, path: `node_modules/@deepseek-ai/${name}` }))
    const inventory = []
    for (const entry of sharedPackages) {
      const path = `${entry.path}/package.json`
      const bytes = Buffer.from(JSON.stringify({ name: entry.name, version: entry.version }))
      files[`resources/app/dsh/${path}`] = bytes
      inventory.push({ path, bytes: bytes.length, sha256: digest(bytes), executable: false })
    }
    files['resources/app/dsh/desktop-runtime.json'] = JSON.stringify({ schemaVersion: 1, platform: 'linux', arch: 'x64',
      release: { schemaVersion: 1, version: runtimeVersion, hostProtocolVersion: 4, nodeVersion: '24.18.1', pnpmVersion: '11.7.0' },
      sharedPackages, files: inventory.sort((a, b) => a.path < b.path ? -1 : 1) })
    for (const [path, bytes] of Object.entries(files)) {
      const absolute = join(app, path)
      await fs.mkdir(join(absolute, '..'), { recursive: true, mode: 0o755 })
      await fs.writeFile(absolute, bytes, { mode: path === 'dsh-workbench' || path.endsWith('/bin/node') ? 0o755 : 0o644 })
    }
    const path = join(base, `${version}.tar.gz`)
    await tar.c({ file: path, cwd: input, gzip: true, portable: true }, ['app'])
    const release = { schemaVersion: 2, channel: 'desktop', platform: 'linux', arch: 'x64', format: 'tar.gz', ...metadata,
      asset: { url: 'https://fixture.invalid/desktop.tar.gz', size: (await fs.stat(path)).size, sha256: digest(await fs.readFile(path)) } }
    const payload = Buffer.from(JSON.stringify(release))
    return { path, release, envelope: { payload: payload.toString('base64'), signature: sign(null, payload, privateKey).toString('base64') } }
  }
  const old = await archive('1.1.0', 'old-epoch')
  const installed = await installUserDesktop({ archive: old.path, sha256: old.release.asset.sha256,
    version: old.release.version, linuxRevision: 7, home, root, xdgDataHome: join(home, '.local/share') })
  const next = await archive('1.2.0', 'new-epoch')
  const request = { archive: next.path, envelope: next.envelope, publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    home, root, dshHome, userData, xdgDataHome: join(home, '.local/share'), oldExecutable: installed.executable,
    node: process.execPath, python: '/usr/bin/python3', workerPath: new URL('../build/migration-worker.mjs', import.meta.url).pathname }
  async function kernelArchive(version, dataEpoch) {
    const payloadRoot = join(base, `kernel-${version}`)
    await fs.mkdir(payloadRoot)
    await fs.cp(join(base, version, 'app/resources/app/dsh'), join(payloadRoot, 'dsh'), { recursive: true })
    await fs.cp(join(base, version, 'app/resources/runtime'), join(payloadRoot, 'runtime'), { recursive: true })
    await fs.writeFile(join(payloadRoot, 'runtime/primary-runtime/runtime.json'), JSON.stringify({ platform: 'linux', arch: 'x64', node: kernelNodeVersion }))
    const metadata = { version, dataEpoch, protocol: 4, desktopRange: '>=1 <3', nodeRange: '>=24 <25' }
    const manifest = Buffer.from(JSON.stringify({ ...metadata, files: await inventory(payloadRoot) }))
    await fs.writeFile(join(payloadRoot, 'kernel.json'), manifest)
    const path = join(base, `kernel-${version}.tar.gz`)
    await tar.c({ cwd: payloadRoot, file: path, gzip: true }, ['kernel.json', 'dsh', 'runtime'])
    const release = { schemaVersion: 1, channel: 'kernel', platform: 'linux', arch: 'x64', ...metadata,
      manifestSha256: digest(manifest), asset: { url: 'https://fixture.invalid/kernel.tar.gz', sha256: digest(await fs.readFile(path)), size: (await fs.stat(path)).size } }
    const bytes = Buffer.from(JSON.stringify(release))
    return { archive: path, envelope: { payload: bytes.toString('base64'), signature: sign(null, bytes, privateKey).toString('base64') } }
  }
  if (kernelMigration) Object.assign(request, await kernelArchive('1.2.0', 'new-epoch'), {
    kind: 'kernel', kernelRoot: join(userData, 'updates'), desktop: { ...old.release, followOfficial: true } })
  return { base, home, root, dshHome, userData, old, next, request, createArchive: archive, createKernelArchive: kernelArchive, reports }
}

test('an unauthenticated whole desktop never stops the running Host', async () => {
  const { publicKey } = generateKeyPairSync('ed25519')
  let stopped = false
  await assert.rejects(startWholeDesktopUpgrade({
    envelope: { payload: 'e30=', signature: Buffer.alloc(64).toString('base64') },
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
  }, { prepareRestart: async () => { stopped = true; return true } }), /signature|签名/)
  assert.equal(stopped, false)
})

test('canceling a verified whole desktop leaves the old program and every data root active', async t => {
  const f = await fixture(t)
  const result = await startWholeDesktopUpgrade(f.request, {
    prepareRestart: async () => false,
    recover: async () => {},
    quitWithoutRelaunch: () => assert.fail('cancel must keep Electron running'),
  })
  assert.deepEqual(result, { kind: 'cancelled' })
  assert.equal(await fs.readlink(join(f.root, 'current')), `versions/${f.old.release.asset.sha256}`)
  assert.equal(await fs.readFile(join(f.dshHome, 'session.json'), 'utf8'), '{"epoch":"old","text":"saved"}')
})

async function handoff(f, options = {}) {
  const requestFile = join(f.base, 'request.json')
  await fs.writeFile(requestFile, JSON.stringify(f.request), { mode: 0o600 })
  const program = `import fs from 'node:fs/promises';
    import { spawn } from 'node:child_process';
    import { startWholeDesktopUpgrade } from ${JSON.stringify(new URL('../build/whole-desktop.mjs', import.meta.url).href)};
    const request = JSON.parse(await fs.readFile(process.argv[1], 'utf8'));
    ${options.helper ? `const helperPath = process.env.DSH_HOME + '/plugin-helper.mjs';
      await fs.writeFile(helperPath, "import fs from 'node:fs/promises'; const handle = await fs.open(process.env.DSH_HOME + '/session.json', 'r+'); process.send('ready'); setInterval(() => void handle.fd, 1000)");
      const helper = spawn(request.activeRuntime ? request.activeRuntime + '/node' : process.execPath, [helperPath],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      await new Promise(resolve => helper.once('message', resolve));` : ''}
    try {
      const result = await startWholeDesktopUpgrade(request, {
        prepareRestart: async () => { ${options.makeFallbackFail ? "await fs.chmod(request.oldExecutable, 0o600);" : ''} return true }, recover: async () => {},
        quitWithoutRelaunch: () => setTimeout(() => process.exit(0), ${options.exitDelay ?? 50})
      });
      process.send(result);
    } catch (error) { process.send({ error: error.message }); process.exit(1) }`
  const child = spawn(process.execPath, ['--input-type=module', '-e', program, requestFile], {
    env: { ...process.env, HOME: f.home, DSH_HOME: f.dshHome, XDG_CONFIG_HOME: join(f.home, '.config'),
      XDG_DATA_HOME: join(f.home, '.local/share'), XDG_CACHE_HOME: join(f.home, '.cache'), ...options.environment },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  let errors = ''
  child.stderr.on('data', chunk => { errors += chunk })
  const result = await new Promise((resolve, reject) => {
    child.once('message', resolve)
    child.once('error', reject)
    child.once('exit', code => { if (code) reject(new Error(errors || `handoff exited ${code}`)) })
  })
  if (result.error) throw new Error(result.error)
  f.reports.push(result.reportPath)
  return { child, result }
}

async function completed(path, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = JSON.parse(await fs.readFile(path, 'utf8'))
    if (['healthy', 'failed'].includes(value.phase)) return value
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  throw new Error('migration did not produce a terminal report')
}

async function mappedAliasActor(f, mode = 'shared-write', aliasName = 'outside-home-data-alias') {
  const alias = join(f.base, aliasName)
  const ready = join(f.base, 'mapping-ready')
  const executable = join(f.base, 'mmap-writer')
  await fs.link(join(f.dshHome, 'session.json'), alias)
  const compiler = spawn('cc', ['-x', 'c', '-', '-o', executable], { stdio: ['pipe', 'ignore', 'pipe'] })
  let compilerError = ''
  compiler.stderr.on('data', bytes => { compilerError += bytes })
  const compiled = new Promise((resolve, reject) => {
    compiler.once('error', reject)
    compiler.once('exit', code => code === 0 ? resolve() : reject(new Error(compilerError)))
  })
  compiler.stdin.end(`#include <sys/mman.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <string.h>
int main(int argc, char **argv) {
  if (argc != 4) return 4;
  struct stat info;
  int readonly = !strcmp(argv[3], "shared-read");
  int private = !strcmp(argv[3], "private-write");
  int fd = open(argv[1], readonly ? O_RDONLY : O_RDWR);
  if (fd < 0 || fstat(fd, &info)) return 1;
  void *mapping = mmap(0, info.st_size, PROT_READ | (readonly ? 0 : PROT_WRITE), private ? MAP_PRIVATE : MAP_SHARED, fd, 0);
  if (mapping == MAP_FAILED || close(fd)) return 2;
  int ready = open(argv[2], O_WRONLY | O_CREAT | O_EXCL, 0600);
  if (ready < 0 || write(ready, "ready", 5) != 5 || close(ready)) return 3;
  for (;;) pause();
}
`)
  await compiled
  const actor = spawn(executable, [alias, ready, mode], { stdio: 'ignore' })
  let actorError
  actor.once('error', error => { actorError = error })
  const stop = async () => {
    if (actor.exitCode !== null || actor.signalCode !== null) return
    const exited = new Promise(resolve => actor.once('exit', resolve))
    assert.ok(actor.kill('SIGTERM'), 'stop only this test-owned mmap actor')
    await exited
  }
  try {
    const deadline = Date.now() + 5_000
    while (true) {
      if (actorError) throw actorError
      if (actor.exitCode !== null) throw new Error(`mmap actor exited ${actor.exitCode}`)
      try { await fs.access(ready); break } catch (error) { if (error.code !== 'ENOENT') throw error }
      if (Date.now() >= deadline) throw new Error('mmap actor did not close its data descriptor and become ready')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    return { actor, alias, stop }
  } catch (error) { await stop(); throw error }
}

test('a shared writable hardlink mapping outside HOME remains a writer after closing its descriptor', async t => {
  const f = await fixture(t)
  const writer = await mappedAliasActor(f)
  try {
    const maps = await fs.readFile(`/proc/${writer.actor.pid}/maps`, 'utf8')
    assert.ok(maps.split('\n').some(line => /\srw-s\s/.test(line) && line.endsWith(writer.alias)), 'the real actor holds the outside-alias shared writable mapping')
    for (const fd of await fs.readdir(`/proc/${writer.actor.pid}/fd`)) {
      assert.notEqual(await fs.readlink(`/proc/${writer.actor.pid}/fd/${fd}`), writer.alias, 'the data descriptor is already closed')
    }
    assert.equal((await fs.stat(join(f.dshHome, 'session.json'))).nlink, 2)
    const { result } = await handoff(f)
    const status = await completed(result.reportPath)
    assert.equal(status.phase, 'failed', 'a closed-FD MAP_SHARED|PROT_WRITE alias must stop the real worker before cutover')
    assert.match(status.error, /Shared writable data mapping/)
    assert.equal(status.activated, false)
    assert.ok(status.events.every(event => event.phase !== 'backup-verified'))
    assert.equal(await fs.readlink(join(f.root, 'current')), `versions/${f.old.release.asset.sha256}`)
    assert.equal(await fs.readFile(join(f.dshHome, 'session.json'), 'utf8'), '{"epoch":"old","text":"saved"}')
    assert.equal(await fs.readFile(join(f.userData, 'settings.json'), 'utf8'), '{"theme":"dark"}')
  } finally { await writer.stop() }
})

test('a deleted outside-HOME hardlink alias still exposes its live shared writable mapping inode', async t => {
  const f = await fixture(t)
  const writer = await mappedAliasActor(f)
  try {
    await fs.unlink(writer.alias)
    assert.equal((await fs.stat(join(f.dshHome, 'session.json'))).nlink, 1)
    const maps = await fs.readFile(`/proc/${writer.actor.pid}/maps`, 'utf8')
    assert.ok(maps.split('\n').some(line => /\srw-s\s/.test(line) && line.endsWith(`${writer.alias} (deleted)`)))
    const { result } = await handoff(f)
    const status = await completed(result.reportPath)
    assert.equal(status.phase, 'failed', status.error)
    assert.match(status.error, /Shared writable data mapping/)
    assert.equal(status.activated, false)
    assert.ok(status.events.every(event => event.phase !== 'backup-verified'))
    assert.equal(await fs.readlink(join(f.root, 'current')), `versions/${f.old.release.asset.sha256}`)
    assert.equal(await fs.readFile(join(f.dshHome, 'session.json'), 'utf8'), '{"epoch":"old","text":"saved"}')
  } finally { await writer.stop() }
})

test('private writable and shared read-only closed-FD alias mappings preserve normal migration', async t => {
  for (const mode of ['private-write', 'shared-read']) await t.test(mode, async child => {
    const f = await fixture(child)
    const writer = await mappedAliasActor(f, mode)
    try {
      const maps = await fs.readFile(`/proc/${writer.actor.pid}/maps`, 'utf8')
      const permissions = mode === 'private-write' ? /\srw-p\s/ : /\sr--s\s/
      assert.ok(maps.split('\n').some(line => permissions.test(line) && line.endsWith(writer.alias)))
      assert.equal((await fs.stat(join(f.dshHome, 'session.json'))).nlink, 2)
      const { result } = await handoff(f)
      const status = await completed(result.reportPath)
      assert.equal(status.phase, 'healthy', status.error)
      assert.equal(await fs.readlink(join(f.root, 'current')), `versions/${f.next.release.asset.sha256}`)
      assert.equal(await fs.readFile(join(dirname(result.reportPath), 'backup/dshHome/session.json'), 'utf8'), '{"epoch":"old","text":"saved"}')
      assert.equal(await fs.readFile(join(f.dshHome, 'session.json'), 'utf8'), '{"epoch":"old","text":"saved"}')
    } finally { await writer.stop() }
  })
})

test('a valid private mapping pathname containing a Unicode line separator is not malformed proc data', async t => {
  const f = await fixture(t)
  const writer = await mappedAliasActor(f, 'private-write', 'private-alias-\u2028name')
  try {
    const maps = await fs.readFile(`/proc/${writer.actor.pid}/maps`, 'utf8')
    assert.ok(maps.split('\n').some(line => /\srw-p\s/.test(line) && line.endsWith(writer.alias)))
    const { result } = await handoff(f)
    const status = await completed(result.reportPath)
    assert.equal(status.phase, 'healthy', status.error)
    assert.equal(await fs.readlink(join(f.root, 'current')), `versions/${f.next.release.asset.sha256}`)
    assert.equal(await fs.readFile(join(f.dshHome, 'session.json'), 'utf8'), '{"epoch":"old","text":"saved"}')
  } finally { await writer.stop() }
})

test('the production worker backs up complete data after actual parent exit before activating the signed desktop', async t => {
  const f = await fixture(t)
  await fs.symlink('session.json', join(f.dshHome, 'saved-link'))
  const { child, result } = await handoff(f)
  assert.equal(result.kind, 'handed-off')
  await fs.rm(f.next.path)
  const status = await completed(result.reportPath)
  assert.equal(status.phase, 'healthy', status.error)
  assert.equal(child.exitCode, 0)
  assert.equal(await fs.readlink(join(f.root, 'current')), `versions/${f.next.release.asset.sha256}`)
  const directory = join(f.home, 'Backups/dsh-workbench', result.transactionId)
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700)
  assert.equal(await fs.readFile(join(directory, 'backup/dshHome/session.json'), 'utf8'), '{"epoch":"old","text":"saved"}')
  assert.equal(await fs.readlink(join(directory, 'backup/dshHome/saved-link')), 'session.json')
  assert.equal(await fs.readFile(join(directory, 'backup/userData/settings.json'), 'utf8'), '{"theme":"dark"}')
  assert.equal((await fs.stat(join(directory, 'backup/dshHome/session.json'))).mode & 0o777, 0o600)
  assert.ok(status.installBytes >= 32 * 1024, 'space preflight includes actual uncompressed candidate bytes')
  assert.deepEqual(status.events.map(event => event.phase), ['prepared', 'ready', 'waiting-parent', 'backup', 'verifying-backup', 'backup-verified', 'installing', 'spawned', 'healthy'])
})

test('a real cross-epoch kernel transaction keeps the shell and binds health to the selected kernel', async t => {
  const f = await fixture(t, { kernelMigration: true })
  const { result } = await handoff(f)
  const status = await completed(result.reportPath)
  assert.equal(status.phase, 'healthy', status.error)
  const state = JSON.parse(await fs.readFile(join(f.request.kernelRoot, 'state.json'), 'utf8'))
  const release = JSON.parse(Buffer.from(f.request.envelope.payload, 'base64'))
  assert.equal(state.active, release.asset.sha256)
  assert.equal(state.dataEpoch, 'new-epoch')
  assert.equal(state.migration, result.transactionId)
  assert.equal(await fs.readlink(join(f.root, 'current')), `versions/${f.old.release.asset.sha256}`)
  const directory = dirname(result.reportPath)
  assert.equal(await fs.readFile(join(directory, 'backup/dshHome/session.json'), 'utf8'), '{"epoch":"old","text":"saved"}')
  assert.ok(Date.parse(status.backupVerifiedAt) >= Date.parse(status.originalExitObservedAt))
  assert.ok(Date.parse(status.activatedAt) >= Date.parse(status.backupVerifiedAt))
  const manager = new UpdateManager({ root: f.request.kernelRoot,
    config: { kernel: { url: 'https://fixture.invalid/kernel.json', publicKey: f.request.publicKey } },
    desktop: f.request.desktop, bundled: { ...f.request.desktop, dsh: '/bundled/dsh', runtime: '/bundled/runtime' },
    migration: f.request, verifyKernel: async () => {} })
  assert.equal((await manager.boot()).version, release.version)
  assert.equal(manager.dataEpoch, release.dataEpoch)
  assert.equal(manager.state.pending, null, 'the actual healthy worker receipt finalizes an interrupted state commit')
  assert.equal(await manager.rollback(), false)
  const desktop = { ...f.request.desktop, version: '1.3.0', protocol: 5, dataEpoch: 'third-epoch' }
  const upgraded = new UpdateManager({ ...manager, desktop, bundled: { ...desktop, dsh: '/new-bundled/dsh', runtime: '/new-bundled/runtime' },
    verifyKernel: async () => assert.fail('a full desktop upgrade must not execute its superseded old-epoch kernel') })
  assert.equal((await upgraded.boot()).version, desktop.version)
  assert.equal(upgraded.dataEpoch, desktop.dataEpoch)
  assert.equal(upgraded.selected.protocol, desktop.protocol)
})

test('new kernel writes followed by a failed health check keep the lock and permit explicit whole-group restore', async t => {
  const f = await fixture(t, { kernelMigration: true, acknowledge: false, writeBeforeFailure: true })
  const { result } = await handoff(f)
  const status = await completed(result.reportPath)
  assert.equal(status.phase, 'failed')
  assert.equal(status.activated, true)
  const source = await fs.readFile(join(f.dshHome, 'session.json'), 'utf8')
  assert.match(source, /deepseek-search-api/)
  await assert.rejects(assertWholeDesktopStartupAllowed({ home: f.home, dshHome: f.dshHome, userData: f.userData,
    executable: f.request.oldExecutable }), /blocks startup/)
  const destination = join(f.base, 'restored-kernel-home')
  const transaction = join(dirname(result.reportPath), 'transaction.json')
  const restored = JSON.parse((await promisify(execFile)(process.execPath,
    [f.request.workerPath, 'restore', transaction, destination])).stdout)
  assert.equal(restored.restored, true)
  assert.equal(await fs.readFile(join(destination, '.dsh/session.json'), 'utf8'), '{"epoch":"old","text":"saved"}')
  assert.equal(await fs.readFile(join(f.dshHome, 'session.json'), 'utf8'), source)
})

test('a kernel with a mismatched real Node identity is refused before stopping the Host', async t => {
  const f = await fixture(t, { kernelMigration: true, kernelNodeVersion: '24.18.1' })
  await assert.rejects(startWholeDesktopUpgrade(f.request, {
    prepareRestart: async () => assert.fail('Node mismatch must precede Host stop'), recover: async () => {},
  }), /Node 身份不匹配/)
  assert.equal(await fs.readlink(join(f.root, 'current')), `versions/${f.old.release.asset.sha256}`)
})

test('the manager probes real signed migration bytes and reuses its bounded extractor before cancellable handoff', async t => {
  const f = await fixture(t, { kernelMigration: true })
  let probes = 0, extractions = 0
  const manager = new UpdateManager({ root: f.request.kernelRoot,
    config: { kernel: { url: 'https://fixture.invalid/kernel.json', publicKey: f.request.publicKey } },
    desktop: f.request.desktop, bundled: { ...f.request.desktop, dsh: '/bundled/dsh', runtime: '/bundled/runtime' },
    migration: f.request, verifyKernel: async () => {},
    extract: async (...args) => { extractions++; await extractKernel(...args) },
    probeKernel: async ({ dsh, runtime }) => {
      probes++
      assert.equal(JSON.parse(await fs.readFile(join(dsh, 'desktop-runtime.json'), 'utf8')).release.version, '1.2.0')
      assert.equal(JSON.parse(await fs.readFile(join(runtime, 'primary-runtime/runtime.json'), 'utf8')).node, '24.21.0')
    }, fetch: async url => new Response(url.endsWith('/kernel.json') ? JSON.stringify(f.request.envelope) : await fs.readFile(f.request.archive)) })
  await manager.boot()
  await manager.check('kernel')
  const result = await manager.installKernelMigration(f.request, {
    prepareRestart: async () => { assert.equal(probes, 1); return false }, recover: async () => {},
    quitWithoutRelaunch: () => assert.fail('cancel must keep the shell running'),
  })
  assert.deepEqual(result, { kind: 'cancelled' })
  assert.equal(extractions, 2)
  assert.equal(manager.state.active, null)
  assert.equal(await fs.readlink(join(f.root, 'current')), `versions/${f.old.release.asset.sha256}`)
})

test('kernel health cannot be acknowledged using a different epoch', async t => {
  const f = await fixture(t, { kernelMigration: true, invalidKernelHealth: true })
  const { result } = await handoff(f)
  const status = await completed(result.reportPath)
  assert.equal(status.phase, 'failed')
  assert.equal(status.activated, true)
  assert.match(status.error, /healthy acknowledgement/)
  await assert.rejects(assertWholeDesktopStartupAllowed({ home: f.home, dshHome: f.dshHome, userData: f.userData,
    executable: f.request.oldExecutable }), /blocks startup/)
})

test('after a second kernel fails, whole-group restore boots the previous kernel without its old Backups tree', async t => {
  const f = await fixture(t, { kernelMigration: true })
  const first = await handoff(f)
  assert.equal((await completed(first.result.reportPath)).phase, 'healthy')
  await f.createArchive('1.3.0', 'third-epoch')
  Object.assign(f.request, await f.createKernelArchive('1.3.0', 'third-epoch'))
  const second = await handoff(f, { environment: { DSH_FIXTURE_REFUSE_KERNEL_HEALTH: '1' } })
  const failed = await completed(second.result.reportPath)
  assert.equal(failed.phase, 'failed')
  assert.equal(failed.activated, true)
  const destination = join(f.base, 'second-kernel-restored-home')
  await promisify(execFile)(process.execPath, [f.request.workerPath, 'restore',
    join(dirname(second.result.reportPath), 'transaction.json'), destination])
  await assert.rejects(fs.stat(join(destination, 'Backups')), { code: 'ENOENT' })
  const userData = join(destination, '.config/dsh-workbench')
  const manager = new UpdateManager({ root: join(userData, 'updates'),
    config: { kernel: { url: 'https://fixture.invalid/kernel.json', publicKey: f.request.publicKey } },
    desktop: f.request.desktop, bundled: { ...f.request.desktop, dsh: '/bundled/dsh', runtime: '/bundled/runtime' },
    migration: { home: destination, dshHome: join(destination, '.dsh'), userData }, verifyKernel: async () => {} })
  assert.equal((await manager.boot()).version, '1.2.0')
  assert.equal(manager.dataEpoch, 'new-epoch')
  assert.equal(await fs.readFile(join(destination, '.dsh/session.json'), 'utf8'), '{"epoch":"old","text":"saved"}')
  assert.match(await fs.readFile(join(f.dshHome, 'session.json'), 'utf8'), /third/)
})

test('a correctly signed desktop with the previous official bundled runtime is rejected before Host quiescence', async t => {
  const f = await fixture(t)
  const mixed = await f.createArchive('1.2.0', 'new-epoch', '1.1.0')
  let stopped = false
  await assert.rejects(startWholeDesktopUpgrade({ ...f.request, archive: mixed.path, envelope: mixed.envelope }, {
    prepareRestart: async () => { stopped = true; return false }, recover: async () => {},
  }), /bundled official release/)
  assert.equal(stopped, false)
  assert.equal(await fs.readlink(join(f.root, 'current')), `versions/${f.old.release.asset.sha256}`)
})

test('the public worker verifies and explicitly restores the whole old program and data group to an empty HOME', async t => {
  const f = await fixture(t)
  await fs.symlink('session.json', join(f.dshHome, 'relative-session-link'))
  await fs.symlink('/external-reference-not-followed', join(f.dshHome, 'external-link'))
  const previous = await f.createArchive('1.0.0', 'old-epoch')
  for (const archive of [previous, f.old]) await installUserDesktop({ archive: archive.path, sha256: archive.release.asset.sha256,
    version: archive.release.version, linuxRevision: 7, home: f.home, root: f.root, xdgDataHome: f.request.xdgDataHome })
  const { result } = await handoff(f)
  const status = await completed(result.reportPath)
  assert.equal(status.phase, 'healthy', status.error)
  const transaction = join(f.home, 'Backups/dsh-workbench', result.transactionId, 'transaction.json')
  const run = promisify(execFile)
  const checked = JSON.parse((await run(process.execPath, [f.request.workerPath, 'verify', transaction])).stdout)
  assert.equal(checked.verified, true)
  await t.test('a previous pointer must target its captured old version rather than another backed program', async () => {
    const manifestPath = join(dirname(transaction), 'backup/manifest.json')
    const original = await fs.readFile(manifestPath, 'utf8')
    const manifest = JSON.parse(original)
    manifest.installation.find(entry => entry.path === join(f.root, 'previous')).target = `versions/${f.old.release.asset.sha256}`
    const rejected = join(f.base, 'rejected-wrong-previous')
    try {
      await fs.writeFile(manifestPath, JSON.stringify(manifest))
      await assert.rejects(run(process.execPath, [f.request.workerPath, 'verify', transaction]), /mapping/)
      await assert.rejects(run(process.execPath, [f.request.workerPath, 'restore', transaction, rejected]), /mapping/)
      await assert.rejects(fs.lstat(rejected), { code: 'ENOENT' })
    } finally { await fs.writeFile(manifestPath, original) }
  })
  const destination = join(f.base, 'recovered-home')
  const restored = JSON.parse((await run(process.execPath, [f.request.workerPath, 'restore', transaction, destination])).stdout)
  assert.equal(restored.restored, true)
  assert.equal(await fs.readFile(join(destination, '.dsh/session.json'), 'utf8'), '{"epoch":"old","text":"saved"}')
  assert.equal(await fs.realpath(join(destination, '.dsh/relative-session-link')), join(destination, '.dsh/session.json'))
  assert.equal(await fs.readlink(join(destination, '.dsh/external-link')), '/external-reference-not-followed')
  assert.equal(await fs.readFile(join(destination, '.config/dsh-workbench/settings.json'), 'utf8'), '{"theme":"dark"}')
  assert.equal(await fs.readlink(join(destination, 'Applications/dsh-linux-desktop/current')), `versions/${f.old.release.asset.sha256}`)
  assert.equal(await fs.readlink(join(destination, 'Applications/dsh-linux-desktop/previous')), `versions/${previous.release.asset.sha256}`)
  assert.equal(await fs.readFile(join(destination, 'Applications/dsh-linux-desktop/versions', previous.release.asset.sha256,
    'resources/app/help.dat'), 'utf8'), 'x'.repeat(32 * 1024))
  assert.equal(JSON.parse(await fs.readFile(join(destination, 'Applications/dsh-linux-desktop/current/resources/app/package.json'), 'utf8')).version, '1.1.0')
  assert.match(await fs.readFile(join(destination, '.local/bin/dsh-workbench'), 'utf8'), new RegExp(destination.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.equal(await fs.readlink(join(f.root, 'current')), `versions/${f.next.release.asset.sha256}`, 'explicit isolated restore never silently rolls back the source HOME')
  await fs.utimes(join(dirname(transaction), 'backup/dshHome/session.json'), 0, 0)
  await assert.rejects(run(process.execPath, [f.request.workerPath, 'verify', transaction]), /timestamp/)
})

test('public recovery rejects corrupt mappings before creating or writing outside the recovery HOME', async t => {
  const f = await fixture(t)
  const { result } = await handoff(f)
  const status = await completed(result.reportPath)
  assert.equal(status.phase, 'healthy', status.error)
  const transaction = join(dirname(result.reportPath), 'transaction.json')
  const manifestPath = join(dirname(result.reportPath), 'backup/manifest.json')
  const original = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  const run = promisify(execFile)
  for (const kind of ['root-traversal', 'installation-traversal', 'unexpected-data-source', 'unexpected-installation-path', 'installation-state-mismatch', 'current-link-escape', 'current-link-subdirectory', 'current-pointer-file', 'unrecorded-previous-link']) {
    await t.test(kind, async () => {
      const manifest = structuredClone(original)
      const escaped = `escaped-${kind}`
      if (kind === 'root-traversal') manifest.roots[0].source = `${f.home}/../../${escaped}`
      if (kind === 'installation-traversal') manifest.installation[3].path = `${f.home}/../../${escaped}`
      if (kind === 'unexpected-data-source') manifest.roots[0].source = join(f.home, escaped)
      if (kind === 'unexpected-installation-path') manifest.installation[3].path = join(f.userData, escaped)
      if (kind === 'current-link-escape') manifest.installation.find(entry => entry.path === join(f.root, 'current')).target = '../../../outside-probe'
      if (kind === 'current-link-subdirectory') manifest.installation.find(entry => entry.path === join(f.root, 'current')).target = `versions/${f.old.release.asset.sha256}/resources/app`
      if (kind === 'current-pointer-file') manifest.installation.find(entry => entry.path === join(f.root, 'current')).type = 'file'
      if (kind === 'unrecorded-previous-link') Object.assign(manifest.installation.find(entry => entry.path === join(f.root, 'previous')),
        { type: 'link', target: `versions/${f.old.release.asset.sha256}` })
      if (kind === 'installation-state-mismatch') {
        const state = JSON.parse(manifest.installation[0].text)
        state.current = f.next.release.asset.sha256
        manifest.installation[0].text = JSON.stringify(state)
      }
      await fs.writeFile(manifestPath, JSON.stringify(manifest))
      // Keep a vulnerable implementation's projected writes inside this owned test fixture.
      const destination = join(f.base, 'targets/nested', kind)
      await assert.rejects(run(process.execPath, [f.request.workerPath, 'verify', transaction]), /mapping/)
      await assert.rejects(run(process.execPath, [f.request.workerPath, 'restore', transaction, destination]), /mapping/)
      await assert.rejects(fs.lstat(destination), { code: 'ENOENT' })
      await assert.rejects(fs.lstat(join(f.base, escaped)), { code: 'ENOENT' })
      assert.equal(await fs.readFile(join(f.dshHome, 'session.json'), 'utf8'), '{"epoch":"old","text":"saved"}')
    })
  }
  await fs.writeFile(manifestPath, JSON.stringify(original))
  const checked = JSON.parse((await run(process.execPath, [f.request.workerPath, 'verify', transaction])).stdout)
  assert.equal(checked.verified, true)
  const destination = join(f.base, 'normal-recovery')
  const restored = JSON.parse((await run(process.execPath, [f.request.workerPath, 'restore', transaction, destination])).stdout)
  assert.equal(restored.restored, true)
  assert.equal(await fs.readFile(join(destination, '.dsh/session.json'), 'utf8'), '{"epoch":"old","text":"saved"}')
})

test('a worker that never becomes READY recovers the Host without quitting or activating anything', async t => {
  const f = await fixture(t)
  const badWorker = join(f.base, 'bad-worker.mjs')
  await fs.writeFile(badWorker, 'process.exit(9)\n', { mode: 0o600 })
  let recovered = 0, quit = 0
  await assert.rejects(startWholeDesktopUpgrade({ ...f.request, workerPath: badWorker }, {
    prepareRestart: async () => true,
    recover: async () => { recovered++ },
    quitWithoutRelaunch: () => { quit++ },
  }), /before READY/)
  assert.equal(recovered, 1)
  assert.equal(quit, 0)
  assert.equal(await fs.readlink(join(f.root, 'current')), `versions/${f.old.release.asset.sha256}`)
  assert.equal(await fs.readFile(join(f.dshHome, 'session.json'), 'utf8'), '{"epoch":"old","text":"saved"}')
})

test('a normal existing Backups parent need not expose private transaction data', async t => {
  const f = await fixture(t)
  await fs.mkdir(join(f.home, 'Backups'), { mode: 0o755 })
  const result = await startWholeDesktopUpgrade(f.request, { prepareRestart: async () => false, recover: async () => {} })
  assert.deepEqual(result, { kind: 'cancelled' })
  assert.equal((await fs.stat(join(f.home, 'Backups/dsh-workbench'))).mode & 0o777, 0o700)
})

test('an interrupted admission gate without an owner never permits startup', async t => {
  const f = await fixture(t)
  await fs.mkdir(join(f.home, 'Backups/dsh-workbench/.migration-lock'), { recursive: true, mode: 0o700 })
  await assert.rejects(assertWholeDesktopStartupAllowed({ home: f.home }))
})

test('a new desktop that exits without real Host health keeps the new program and complete snapshot for explicit recovery', async t => {
  const f = await fixture(t, { acknowledge: false })
  const { result } = await handoff(f)
  const status = await completed(result.reportPath)
  assert.equal(status.phase, 'failed')
  assert.equal(status.activated, true)
  assert.match(status.error, /healthy acknowledgement/)
  assert.equal(await fs.readlink(join(f.root, 'current')), `versions/${f.next.release.asset.sha256}`)
  assert.equal(await fs.readFile(join(dirname(result.reportPath), 'backup/dshHome/session.json'), 'utf8'), '{"epoch":"old","text":"saved"}')
  await assert.rejects(assertWholeDesktopStartupAllowed({ home: f.home }), /blocks startup/)
})

test('the real user installer journals the old and new program group through its public restart boundary', async t => {
  const f = await fixture(t)
  await installUserDesktop({ archive: f.next.path, sha256: f.next.release.asset.sha256,
    version: f.next.release.version, linuxRevision: 7, home: f.home, root: f.root,
    xdgDataHome: f.request.xdgDataHome, restart: async executable => {
      const journal = JSON.parse(await fs.readFile(join(f.root, '.activation.json'), 'utf8'))
      assert.equal(journal.before.current, f.old.release.asset.sha256)
      assert.equal(journal.next.current, f.next.release.asset.sha256)
      assert.equal(journal.phase, 'activated')
      assert.equal(executable, join(f.root, 'versions', f.next.release.asset.sha256, 'dsh-workbench'))
    } })
  await assert.rejects(fs.lstat(join(f.root, '.activation.json')), { code: 'ENOENT' })
})

test('a background helper finishing after its main process exits settles before the verified backup', async t => {
  const f = await fixture(t)
  const settings = join(f.userData, 'settings.json')
  const writer = spawn(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs/promises';
    const handle = await fs.open(${JSON.stringify(settings)}, 'r+');
    process.send('ready');
    process.once('message', async ({ parent }) => {
      while (await fs.stat('/proc/' + parent).then(() => true, () => false))
        await new Promise(resolve => setTimeout(resolve, 20));
      await new Promise(resolve => setTimeout(resolve, 7_500));
      await handle.truncate(0);
      await handle.writeFile('{"theme":"light"}');
      await handle.close();
      process.disconnect();
    });`], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  const exited = new Promise(resolve => writer.once('exit', resolve))
  t.after(async () => { if (writer.exitCode === null && writer.signalCode === null) writer.kill(); await exited })
  await new Promise((resolve, reject) => { writer.once('message', resolve); writer.once('error', reject) })
  const { child, result } = await handoff(f)
  writer.send({ parent: child.pid })
  const status = await completed(result.reportPath)
  await exited
  assert.equal(status.phase, 'healthy', status.error)
  assert.equal(await fs.readFile(join(dirname(result.reportPath), 'backup/userData/settings.json'), 'utf8'), '{"theme":"light"}')
})

for (const separateRuntime of [false, true]) test(`the real migration stops a captured orphan helper (${separateRuntime ? 'active kernel runtime' : 'bundled runtime'}) before backup`, async t => {
  const f = await fixture(t)
  if (separateRuntime) {
    f.request.activeRuntime = join(f.base, 'active-runtime')
    await fs.mkdir(f.request.activeRuntime)
    await fs.copyFile(process.execPath, join(f.request.activeRuntime, 'node'))
  }
  const { result } = await handoff(f, { helper: true })
  const status = await completed(result.reportPath)
  assert.equal(status.phase, 'healthy', status.error)
  assert.ok(status.processActions.some(action => action.action === 'SIGTERM' && action.result === 'exited'))
  assert.equal(await fs.readFile(join(dirname(result.reportPath), 'backup/dshHome/session.json'), 'utf8'), '{"epoch":"old","text":"saved"}')
  assert.ok(status.events.findIndex(event => event.phase === 'stopping-processes') < status.events.findIndex(event => event.phase === 'backup-verified'))
})

test('process shutdown failure and old desktop restart failure remain explicit in the report', async t => {
  const f = await fixture(t)
  f.request.python = '/missing-bundled-python'
  const { result } = await handoff(f, { helper: true, makeFallbackFail: true })
  const deadline = Date.now() + 10_000
  let status
  do {
    status = JSON.parse(await fs.readFile(result.reportPath, 'utf8'))
    if (status.fallbackError) break
    await new Promise(resolve => setTimeout(resolve, 20))
  } while (Date.now() < deadline)
  const transaction = JSON.parse(await fs.readFile(join(dirname(result.reportPath), 'transaction.json'), 'utf8'))
  const { stopProcesses } = await import('../updates/migration-processes.mjs')
  await stopProcesses('/usr/bin/python3', transaction.shutdownProcesses)
  assert.equal(status.phase, 'failed')
  assert.match(status.error, /ENOENT|missing-bundled-python/)
  assert.match(status.fallbackError, /无法重新打开原版本.*EACCES/)
  assert.equal(status.activated, false)
  await assert.rejects(fs.lstat(join(dirname(result.reportPath), 'backup')), { code: 'ENOENT' })
})

test('a missing progress window stops the upgrade before shutting down the Host', async t => {
  const f = await fixture(t)
  let stopped = false
  await assert.rejects(startWholeDesktopUpgrade(f.request, {
    openProgress: async () => { throw new Error('progress window failed') },
    prepareRestart: async () => { stopped = true; return true }, recover: async () => {},
  }), /progress window failed/)
  assert.equal(stopped, false)
  const directory = (await fs.readdir(join(f.home, 'Backups/dsh-workbench'))).find(name => name !== '.migration-lock')
  const status = JSON.parse(await fs.readFile(join(f.home, 'Backups/dsh-workbench', directory, 'report.json'), 'utf8'))
  assert.equal(status.phase, 'failed')
  assert.match(status.error, /progress window failed/)
})

test('a known CLI appearing during backup is stopped and the snapshot is rebuilt from current data', async t => {
  const f = await fixture(t)
  const files = join(f.dshHome, 'many-files')
  await fs.mkdir(files)
  for (let index = 0; index < 500; index++) await fs.writeFile(join(files, String(index)), 'saved data')
  const packageRoot = join(f.base, 'cli-package')
  await fs.mkdir(join(packageRoot, 'lib'), { recursive: true })
  await fs.writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', type: 'module' }))
  const entry = join(packageRoot, 'lib/bin.js')
  await fs.writeFile(entry, `import fs from 'node:fs/promises';
    await fs.writeFile(process.env.DSH_HOME + '/session.json', '{"epoch":"old","text":"late saved data"}');
    const handle = await fs.open(process.env.DSH_HOME + '/session.json', 'r+');
    setInterval(() => void handle.fd, 1000);`)
  const { result } = await handoff(f, { exitDelay: 500 })
  const actor = spawn(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs/promises'; import {spawn} from 'node:child_process';
    while (!await fs.stat(${JSON.stringify(join(dirname(result.reportPath), 'backup.staging'))}).then(() => true, () => false))
      await new Promise(resolve => setTimeout(resolve, 1));
    const cli = spawn(process.execPath, [${JSON.stringify(entry)}], { env: {...process.env, DSH_HOME: ${JSON.stringify(f.dshHome)}}, stdio: 'ignore' });
    await new Promise(resolve => cli.once('exit', resolve));`], { stdio: 'ignore' })
  const exited = new Promise(resolve => actor.once('exit', resolve))
  t.after(async () => { if (actor.exitCode === null) actor.kill(); await exited })
  const status = await completed(result.reportPath)
  assert.equal(status.phase, 'healthy', status.error)
  assert.ok(status.backupRetry >= 1, 'a writer discovered after snapshot creation must cause a fresh snapshot')
  assert.equal(await fs.readFile(join(dirname(result.reportPath), 'backup/dshHome/session.json'), 'utf8'), '{"epoch":"old","text":"late saved data"}')
  await exited
})

test('a persistent writer in desktop data still blocks migration before any backup or activation', async t => {
  const f = await fixture(t)
  const writer = spawn(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs/promises';
    const handle = await fs.open(${JSON.stringify(join(f.userData, 'settings.json'))}, 'r+');
    process.send('ready'); setInterval(() => void handle.fd, 1000);
  `], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  const exited = new Promise(resolve => writer.once('exit', resolve))
  t.after(async () => { writer.kill(); await exited })
  await new Promise((resolve, reject) => { writer.once('message', resolve); writer.once('error', reject) })
  const { result } = await handoff(f)
  const status = await completed(result.reportPath, 45_000)
  assert.equal(status.phase, 'failed')
  assert.match(status.error, /Data writer must be closed/)
  assert.equal(status.activated, false)
  await assert.rejects(fs.lstat(join(dirname(result.reportPath), 'backup.staging')), { code: 'ENOENT' })
  await assert.rejects(fs.lstat(join(dirname(result.reportPath), 'backup')), { code: 'ENOENT' })
  assert.equal(await fs.readlink(join(f.root, 'current')), `versions/${f.old.release.asset.sha256}`)
  assert.equal(await fs.readFile(join(f.userData, 'settings.json'), 'utf8'), '{"theme":"dark"}')
})

test('an unrelated process with a writable hard-link alias stops migration without any program or data cutover', async t => {
  const f = await fixture(t)
  const alias = join(f.base, 'external-data-alias')
  await fs.link(join(f.dshHome, 'session.json'), alias)
  const writer = spawn(process.execPath, ['--input-type=module', '-e',
    `import fs from 'node:fs/promises'; const handle = await fs.open(${JSON.stringify(alias)}, 'r+'); process.send('ready'); setInterval(() => void handle.fd, 1000);`],
  { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  await new Promise((resolve, reject) => { writer.once('message', resolve); writer.once('error', reject) })
  try {
    const { result } = await handoff(f)
    const status = await completed(result.reportPath)
    assert.equal(status.phase, 'failed')
    assert.match(status.error, /Data writer must be closed/)
    assert.equal(await fs.readlink(join(f.root, 'current')), `versions/${f.old.release.asset.sha256}`)
    assert.equal(await fs.readFile(join(f.dshHome, 'session.json'), 'utf8'), '{"epoch":"old","text":"saved"}')
    const deadline = Date.now() + 10_000
    let relaunched
    while (!relaunched && Date.now() < deadline) {
      relaunched = await fs.readFile(join(f.home, 'new-started'), 'utf8').catch(() => undefined)
      await new Promise(resolve => setTimeout(resolve, 30))
    }
    assert.equal(relaunched, status.error, 'the untouched old desktop reopens and receives the failure')
  } finally {
    const exited = new Promise(resolve => writer.once('exit', resolve))
    writer.kill()
    await exited
  }
})

test('the selected desktop with different resolved data roots fails before opening settings or starting a Host', async t => {
  for (const rootMismatch of ['dshHome', 'userData']) await t.test(rootMismatch, async child => {
    const f = await fixture(child, { rootMismatch })
    const { result } = await handoff(f)
    const status = await completed(result.reportPath)
    assert.equal(status.phase, 'failed')
    assert.match(status.error, /data roots mismatch/)
    assert.equal(status.activated, true)
    assert.equal(await fs.readlink(join(f.root, 'current')), `versions/${f.next.release.asset.sha256}`)
    assert.equal(await fs.readFile(join(dirname(result.reportPath), 'backup/dshHome/session.json'), 'utf8'), '{"epoch":"old","text":"saved"}')
    assert.equal(await fs.readFile(join(dirname(result.reportPath), 'backup/userData/settings.json'), 'utf8'), '{"theme":"dark"}')
    await assert.rejects(fs.lstat(join(f.home, 'new-started')), { code: 'ENOENT' })
    await assert.rejects(fs.lstat(join(f.home, 'unexpected-runtime-home')), { code: 'ENOENT' })
    await assert.rejects(fs.lstat(join(f.home, 'unexpected-runtime-userData')), { code: 'ENOENT' })
    await assert.rejects(assertWholeDesktopStartupAllowed({ home: f.home }), /blocks startup/)
  })
})

test('explicit recovery does not report success while HOME-internal absolute links still reference the source HOME', async t => {
  for (const link of ['installation', 'data', 'relative-unbacked-installation', 'external-installation']) await t.test(link, async child => {
    const f = await fixture(child)
    if (link === 'installation') {
      await fs.unlink(join(f.root, 'current'))
      await fs.symlink(join(f.root, 'versions', f.old.release.asset.sha256), join(f.root, 'current'))
    }
    const { result } = await handoff(f)
    const status = await completed(result.reportPath)
    assert.equal(status.phase, 'healthy', status.error)
    const transaction = join(dirname(result.reportPath), 'transaction.json')
    const destination = join(f.base, 'recovered-home')
    if (link !== 'installation') {
      // Historical public snapshots can contain links that new migrations now stop before activation.
      const manifestPath = join(dirname(result.reportPath), 'backup/manifest.json')
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
      if (link === 'data') {
        const directory = join(dirname(result.reportPath), 'backup/dshHome')
        const target = join(f.dshHome, 'session.json')
        await fs.symlink(target, join(directory, 'absolute-session-link'))
        const info = await fs.lstat(join(directory, 'absolute-session-link'), { bigint: true })
        const root = manifest.roots.find(root => root.name === 'dshHome')
        root.entries.push({ path: 'absolute-session-link', type: 'link', target, mode: Number(info.mode) & 0o777,
          mtimeNs: String(info.mtimeNs), ctimeNs: String(info.ctimeNs), inode: `${info.dev}:${info.ino}`, size: Number(info.size) })
        root.entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
        root.entries[0].mtimeNs = String((await fs.lstat(directory, { bigint: true })).mtimeNs)
      } else {
        manifest.installation.find(entry => entry.path === join(f.root, 'current')).target =
          link === 'external-installation' ? join(f.base, 'external-old-desktop') : '../../unbacked-old-desktop'
      }
      await fs.writeFile(manifestPath, JSON.stringify(manifest))
      if (link.endsWith('-installation')) {
        await assert.rejects(promisify(execFile)(process.execPath, [f.request.workerPath, 'verify', transaction]), /mapping/)
      } else {
        const verified = JSON.parse((await promisify(execFile)(process.execPath, [f.request.workerPath, 'verify', transaction])).stdout)
        assert.equal(verified.verified, true)
      }
    }
    if (link.endsWith('-installation')) {
      await assert.rejects(promisify(execFile)(process.execPath,
        [f.request.workerPath, 'restore', transaction, destination]), /mapping/)
      await assert.rejects(fs.lstat(destination), { code: 'ENOENT' })
      return
    }
    if (link === 'data') {
      await assert.rejects(promisify(execFile)(process.execPath,
        [f.request.workerPath, 'restore', transaction, destination]), /absolute data symlink requires explicit relocation/)
      await assert.rejects(fs.lstat(destination), { code: 'ENOENT' })
      assert.equal(await fs.readlink(join(dirname(result.reportPath), 'backup/dshHome/absolute-session-link')), join(f.dshHome, 'session.json'))
      assert.equal(await fs.readFile(join(f.dshHome, 'session.json'), 'utf8'), '{"epoch":"old","text":"saved"}')
      return
    }
    const restored = JSON.parse((await promisify(execFile)(process.execPath,
      [f.request.workerPath, 'restore', transaction, destination])).stdout)
    assert.equal(restored.restored, true)
    const actual = link === 'installation'
      ? await fs.realpath(join(destination, 'Applications/dsh-linux-desktop/current'))
      : await fs.realpath(join(destination, '.dsh/absolute-session-link'))
    const expected = link === 'installation'
      ? join(destination, 'Applications/dsh-linux-desktop/versions', f.old.release.asset.sha256)
      : join(destination, '.dsh/session.json')
    assert.equal(actual, expected)
  })
})

test('unsupported HOME-internal data links stop a new whole migration before backup and activation', async t => {
  const f = await fixture(t)
  await fs.symlink(join(f.dshHome, 'session.json'), join(f.dshHome, 'absolute-session-link'))
  const { result } = await handoff(f)
  const status = await completed(result.reportPath)
  assert.equal(status.phase, 'failed')
  assert.equal(status.activated, false)
  assert.match(status.error, /absolute data symlink requires explicit relocation/)
  assert.equal(await fs.readlink(join(f.root, 'current')), `versions/${f.old.release.asset.sha256}`)
  assert.equal(await fs.readlink(join(f.dshHome, 'absolute-session-link')), join(f.dshHome, 'session.json'))
  assert.equal(await fs.readFile(join(f.dshHome, 'session.json'), 'utf8'), '{"epoch":"old","text":"saved"}')
  await assert.rejects(fs.lstat(join(dirname(result.reportPath), 'backup')), { code: 'ENOENT' })
})

test('unbacked installation aliases stop a new whole migration before backup and activation', async t => {
  for (const external of [false, true]) await t.test(external ? 'external' : 'relative-unbacked', async child => {
    const f = await fixture(child)
    const alias = external ? join(f.base, 'external-old-desktop') : join(f.home, 'unbacked-old-desktop')
    await fs.symlink(join(f.root, 'versions', f.old.release.asset.sha256), alias)
    await fs.unlink(join(f.root, 'current'))
    const target = external ? alias : '../../unbacked-old-desktop'
    await fs.symlink(target, join(f.root, 'current'))
    const { result } = await handoff(f)
    const status = await completed(result.reportPath)
    assert.equal(status.phase, 'failed')
    assert.equal(status.activated, false)
    assert.match(status.error, /outside its backed-up program/)
    assert.equal(await fs.readlink(join(f.root, 'current')), target)
    assert.equal(await fs.realpath(join(f.root, 'current')), join(f.root, 'versions', f.old.release.asset.sha256))
    await assert.rejects(fs.lstat(join(dirname(result.reportPath), 'backup')), { code: 'ENOENT' })
  })
})

if (!isolated) {
  publicTest('whole desktop public integration scenarios use a real non-root process namespace', async () => {
    const environment = { ...process.env, DSH_WHOLE_DESKTOP_TEST_NAMESPACE: '1' }
    delete environment.NODE_TEST_CONTEXT
    // unshare --fork ignores SIGTERM, so the timeout must SIGKILL it and --kill-child tears down the namespace.
    const result = await promisify(execFile)('unshare', ['--user', '--map-current-user', '--pid', '--fork', '--mount-proc', '--kill-child',
      process.execPath, '--test', new URL(import.meta.url).pathname], {
      env: environment, timeout: 120_000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 ** 2,
    })
    assert.match(result.stdout, /production worker backs up complete data/)
    console.log(result.stdout.trim())
  })

  publicTest('host writer inspection skips uninspectable session processes or fails closed without changing data', async t => {
    const f = await fixture(t)
    const { result } = await handoff(f)
    const status = await completed(result.reportPath)
    if (status.phase === 'healthy') { t.skip('This host has no shared writer; the scanner skipped uninspectable non-dsh processes'); return }
    assert.equal(status.phase, 'failed')
    assert.match(status.error, /Shared writer inspection|Shared DSH process|Data writer/)
    assert.equal(status.activated, false)
    assert.equal(await fs.readlink(join(f.root, 'current')), `versions/${f.old.release.asset.sha256}`)
    assert.equal(await fs.readFile(join(f.dshHome, 'session.json'), 'utf8'), '{"epoch":"old","text":"saved"}')
    assert.equal(await fs.readFile(join(f.userData, 'settings.json'), 'utf8'), '{"theme":"dark"}')
    console.log(`Production host scanner preserved fixture data: ${status.error}`)
  })
}
