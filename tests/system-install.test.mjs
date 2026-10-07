import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import fs from 'node:fs/promises'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import { installedFormat, verifySystemHelper, installSystemDesktop } from '../updates/system-install.mjs'

const helper = '/opt/dsh-workbench/resources/app/workbench/install.py'
const safe = path => ({ uid: 0, mode: 0o755, isSymbolicLink: () => false,
  isFile: () => path === helper, isDirectory: () => path !== helper })

test('privileged helper rejects writable, user-owned and symlinked parents, not just the script', async () => {
  assert.equal(await verifySystemHelper(helper, async path => safe(path)), helper)
  for (const change of [{ uid: 1000 }, { mode: 0o775 }, { isSymbolicLink: () => true }]) {
    await assert.rejects(verifySystemHelper(helper, async path => ({ ...safe(path), ...(path === '/opt' ? change : {}) })), /root/)
  }
  await assert.rejects(verifySystemHelper('/home/user/install.py'), /系统安装目录/)
})

test('user executables cannot select a privileged package update, even with a system package present', async () => {
  await assert.rejects(installedFormat(process.execPath, () => assert.fail('must not query packages')), /系统版/)
})


test('system package detection selects deb/rpm and propagates unexpected query failures', async t => {
  mock.method(fs, 'realpath', async () => '/opt/dsh-workbench/dsh-workbench')
  syncBuiltinESMExports()
  t.after(() => { mock.restoreAll(); syncBuiltinESMExports() })
  assert.equal(await installedFormat('/system', async () => ({ stdout: 'installed' })), 'deb')
  assert.equal(await installedFormat('/system', async command => {
    if (command.endsWith('dpkg-query')) throw Object.assign(new Error('not installed'), { code: 1 })
    return { stdout: 'dsh-workbench' }
  }), 'rpm')
  await assert.rejects(installedFormat('/system', async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) }), /denied/)
})

test('system installation cancels before authorization, never restarts on failure, and targets /opt on success', async t => {
  mock.method(fs, 'lstat', async path => safe(path))
  let called = 0, exit = 0, restarted = 0
  const artifact = { archive: '/tmp/download.deb', format: 'deb', version: '1.2.0', linuxRevision: 2,
    sha256: 'a'.repeat(64), size: 9, prepareRestart: async () => false,
    restart: async path => { assert.equal(path, '/opt/dsh-workbench/dsh-workbench'); restarted++ } }
  mock.method(childProcess, 'spawn', (command, args, options) => {
    called++
    assert.equal(command, '/usr/bin/pkexec')
    assert.deepEqual(args, ['/usr/bin/python3', '-I', helper, artifact.archive, 'deb', '1.2.0', '2', artifact.sha256, '9'])
    assert.equal(options.env.ELECTRON_RUN_AS_NODE, undefined)
    const child = new EventEmitter()
    child.stderr = new EventEmitter()
    queueMicrotask(() => child.emit('close', exit))
    return child
  })
  syncBuiltinESMExports()
  t.after(() => { mock.restoreAll(); syncBuiltinESMExports() })
  const resources = '/opt/dsh-workbench/resources/app/workbench'
  assert.equal(await installSystemDesktop(artifact, resources), null)
  assert.equal(called, 0)
  const ready = { ...artifact, prepareRestart: async () => true }
  exit = 126
  await assert.rejects(installSystemDesktop(ready, resources), /126/)
  assert.equal(restarted, 0)
  exit = 0
  await installSystemDesktop(ready, resources)
  assert.equal(restarted, 1)
})
