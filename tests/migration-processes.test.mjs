import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import publicTest from 'node:test'
import { processIdentity, originalAlive, captureMigrationProcesses, stopProcesses, stopMigrationProcesses } from '../updates/migration-processes.mjs'

const isolated = process.env.DSH_PROCESS_TEST_NAMESPACE === '1'
const test = isolated ? publicTest : () => {}
async function actor(t, program = '', options = {}) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `${program}; process.send('ready'); setInterval(() => {}, 1000)`], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'], ...options,
  })
  const exited = new Promise(resolve => child.once('exit', resolve))
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited })
  await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject) })
  return { child, exited, identity: await processIdentity(child.pid) }
}

test('pidfd stops the exact target and escalates a TERM-resistant helper', async t => {
  const normal = await actor(t)
  const resistant = await actor(t, "process.on('SIGTERM', () => {})")
  const actions = await stopProcesses('/usr/bin/python3', [normal.identity, resistant.identity])
  await Promise.all([normal.exited, resistant.exited])
  assert.deepEqual(actions.map(item => item.action), ['SIGTERM', 'SIGKILL'])
  assert.equal(await originalAlive(normal.identity), false)
  assert.equal(await originalAlive(resistant.identity), false)
})

test('a stale identity never signals a reused PID and missing pidfd support is explicit', async t => {
  const target = await actor(t)
  assert.deepEqual(await stopProcesses('/usr/bin/python3', [{ ...target.identity, startTime: '0' }]), [])
  assert.deepEqual(await stopProcesses('/usr/bin/python3', [{ ...target.identity, executable: '/wrong-executable', entry: 'wrong', dshHome: '/tmp/wrong' }]), [])
  assert.equal(await originalAlive(target.identity), true)
  await assert.rejects(stopProcesses('/no-such-bundled-python', [target.identity]), /ENOENT/)
  assert.equal(await originalAlive(target.identity), true)
})

test('a TERM handler that execs another program is never followed by KILL of the new program', async t => {
  const target = await actor(t, "process.on('SIGTERM', () => process.execve('/bin/sleep', ['sleep', '60'], process.env))",
    { env: { ...process.env, DSH_HOME: '/tmp/dsh-exec-change-test' } })
  await assert.rejects(stopProcesses('/usr/bin/python3', [{ ...target.identity,
    executable: await fs.readlink(`/proc/${target.child.pid}/exe`), entry: '--input-type=module', dshHome: '/tmp/dsh-exec-change-test' }]), /identity changed/)
  assert.equal(await originalAlive(target.identity), true)
  assert.match(await fs.readlink(`/proc/${target.child.pid}/exe`), /\/sleep$/)
})

test('arbitrary bundled Node scripts are not captured and upgrade facilities survive', async t => {
  const helper = await actor(t, '', { env: { ...process.env, DSH_HOME: '/tmp/example/.dsh' } })
  const viewer = await actor(t)
  const request = { node: process.execPath, python: '/usr/bin/python3', oldExecutable: '/tmp/example/dsh-workbench', dshHome: '/tmp/example/.dsh' }
  const captured = await captureMigrationProcesses(request)
  assert.ok(!captured.some(item => item.pid === helper.child.pid))
  const actions = await stopMigrationProcesses({ ...request, shutdownProcesses: [...captured, helper.identity, await processIdentity(process.pid)],
    progressIdentity: viewer.identity }, async () => {})
  // The direct caller is also an upgrade facility, so all of its live descendants are protected.
  assert.deepEqual(actions, [])
  assert.equal(await originalAlive(viewer.identity), true)
  assert.equal(await originalAlive(helper.identity), true)
})

test('only actual dsh entries sharing DSH_HOME are stopped; dsh-looking arguments do not authorize termination', async t => {
  const base = await fs.mkdtemp('/tmp/dsh-process-test-')
  t.after(() => fs.rm(base, { recursive: true, force: true }))
  const home = join(base, '.dsh')
  const isolatedHome = join(base, 'isolated')
  await fs.mkdir(join(base, 'package/lib'), { recursive: true })
  await fs.mkdir(home)
  await fs.mkdir(isolatedHome)
  await fs.writeFile(join(base, 'package/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', type: 'module' }))
  const entry = join(base, 'package/lib/bin.js')
  await fs.writeFile(entry, "process.send('ready'); setInterval(() => {}, 1000)")
  // Launch actors from a separate parent; the test runner is a protected worker ancestor.
  const launcher = await actor(t, `import { spawn } from 'node:child_process';
    const targets = [${JSON.stringify(home)}, ${JSON.stringify(isolatedHome)}].map(DSH_HOME => spawn(process.execPath, [${JSON.stringify(entry)}], {
      env: {...process.env, DSH_HOME}, stdio: ['ignore','ignore','ignore','ipc'] }));
    await Promise.all(targets.map(child => new Promise(resolve => child.once('message', resolve))));
    process.on('message', () => process.send(targets.map(child => child.pid)));`)
  const pids = new Promise(resolve => launcher.child.once('message', resolve))
  launcher.child.send('pids')
  const [sharedPid, separatePid] = await pids
  // A viewer protects its descendants, so perform the scan in an independent worker process.
  const source = new URL('../updates/migration-processes.mjs', import.meta.url).href
  const scan = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
    import { stopMigrationProcesses } from ${JSON.stringify(source)};
    console.log(JSON.stringify(await stopMigrationProcesses({ dshHome: ${JSON.stringify(home)}, python: '/usr/bin/python3' }, async () => {})));`])
  const actions = JSON.parse(scan.stdout)
  assert.ok(actions.some(item => item.pid === sharedPid))
  assert.equal(await originalAlive(await processIdentity(separatePid)), true)
  process.kill(separatePid, 'SIGKILL')
})

if (!isolated) publicTest('migration process controls use real pidfds in an isolated process namespace', async () => {
  const env = { ...process.env, DSH_PROCESS_TEST_NAMESPACE: '1' }
  delete env.NODE_TEST_CONTEXT
  const result = await promisify(execFile)('unshare', ['--user', '--map-current-user', '--pid', '--fork', '--mount-proc', '--kill-child',
    process.execPath, '--test', new URL(import.meta.url).pathname], { env, timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 1024 ** 2 })
  console.log(result.stdout.trim())
})
