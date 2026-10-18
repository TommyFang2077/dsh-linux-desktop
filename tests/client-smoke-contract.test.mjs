import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const root = process.env.DSH_SMOKE_SOURCE_ROOT ?? resolve(import.meta.dirname, '..')
const scripts = ['gui-smoke.mjs', 'kernel-update-smoke.mjs']
const sources = Object.fromEntries(scripts.map(file => [file, readFileSync(join(root, 'scripts', file), 'utf8')]))
function definition(source, name) {
  const start = source.indexOf('function ' + name + '(')
  assert.ok(start >= 0, 'Missing actual smoke function ' + name)
  const begin = source.slice(Math.max(0, start - 6), start) === 'async ' ? start - 6 : start
  const end = source.indexOf('\n}\n', start) + 2
  assert.ok(end > start)
  return source.slice(begin, end)
}
function idleHarness(source, results, disabled = []) {
  let now = 0, requests = 0, sleeps = 0
  const wait = runInNewContext('(' + definition(source, 'waitForUpdateIdle') + ')', {
    assert, Date: { now: () => now },
    setTimeout: async milliseconds => { assert.equal(milliseconds, 100); now += milliseconds; sleeps++ },
  })
  const page = {
    evaluate(callback) {
      return runInNewContext('(' + callback.toString() + ')()', { window: { workbenchUpdates: {
        invoke(action) {
          assert.equal(action, 'status', 'Polling cannot install, confirm or mask a check error')
          requests++
          return results[Math.min(requests - 1, results.length - 1)]
        },
      } } })
    },
    locator(selector) {
      assert.equal(selector, '[data-action="check"]')
      return { isDisabled: async () => disabled.shift() ?? false }
    },
  }
  return { wait: timeout => wait(page, timeout), counts: () => ({ requests, sleeps }) }
}
for (const file of scripts) {
  test(file + ': waits for real main idle and renderer completion, never issuing an action', async () => {
    const harness = idleHarness(sources[file], [{ status: { busy: true } }, { status: { busy: false } }], [true, false])
    const result = await harness.wait(400)
    assert.equal(result.status.busy, false)
    assert.deepEqual(harness.counts(), { requests: 3, sleeps: 2 })
  })
  test(file + ': permanent busy fails at the original bounded polling deadline', async () => {
    const harness = idleHarness(sources[file], [{ status: { busy: true } }])
    await assert.rejects(harness.wait(300), /did not become idle within 300ms/)
    assert.deepEqual(harness.counts(), { requests: 3, sleeps: 3 })
  })
  test(file + ': missing main busy capability fails closed', async () => {
    const harness = idleHarness(sources[file], [{ status: {} }])
    await assert.rejects(harness.wait(300), /Main must report a known busy state/)
    assert.deepEqual(harness.counts(), { requests: 1, sleeps: 0 })
  })
  test(file + ': main IPC errors are not retried or suppressed', async () => {
    const harness = idleHarness(sources[file], [{ status: { busy: false }, error: 'real IPC failure' }])
    await assert.rejects(harness.wait(300), /real IPC failure/)
    assert.deepEqual(harness.counts(), { requests: 1, sleeps: 0 })
  })
}
function confirmationHarness() {
  const context = {}
  const hold = runInNewContext('(' + definition(sources['kernel-update-smoke.mjs'], 'holdUpdateConfirmation') + ')', context)
  const app = { getPath: name => { assert.equal(name, 'userData'); return '/tmp/disposable-smoke' } }
  const dialog = {}
  assert.equal(hold({ app, dialog }), '/tmp/disposable-smoke')
  return { app, dialog, state: context.__workbenchSmokeConfirmation }
}
for (const response of [0, 1]) {
  test('native consent stays pending until explicit single response ' + response, async () => {
    const { dialog, state } = confirmationHarness()
    const options = { title: '确认更新', buttons: ['取消', '继续'], defaultId: 0, cancelId: 0 }
    const pending = dialog.showMessageBox({}, options)
    let settled = false
    pending.then(() => { settled = true })
    await Promise.resolve()
    assert.equal(settled, false)
    assert.equal(state.options, options)
    assert.equal(state.relaunches, 0)
    assert.equal(state.calls, 1)
    assert.throws(() => state.respond(undefined), /must be explicit/)
    state.respond(response)
    assert.equal((await pending).response, response)
    assert.throws(() => state.respond(response), /occur once/)
  })
}
test('unexpected second native confirmation is a failure, not automatic consent', async () => {
  const { dialog, state } = confirmationHarness()
  const pending = dialog.showMessageBox({}, { title: 'first' })
  assert.throws(() => dialog.showMessageBox({}, { title: 'second' }), /Unexpected repeated/)
  assert.equal(state.options.title, 'first')
  state.respond(0)
  assert.equal((await pending).response, 0)
})
test('GUI smoke asserts actual unified labels, all main channels and sandbox without old headings', () => {
  const source = sources['gui-smoke.mjs']
  const html = readFileSync(join(root, 'updates/updates.html'), 'utf8')
  assert.ok(html.includes('<h1>软件更新</h1>'))
  assert.ok(source.includes("name: '软件更新', exact: true"))
  for (const label of ['检查更新', '确认安装并重启']) {
    assert.ok(html.includes(label))
    assert.ok(source.includes("name: '" + label + "', exact: true"))
  }
  assert.ok(source.includes("for (const channel of ['desktop', 'desktopUpgrade', 'kernel'])"))
  assert.match(source, /assert\.match\(unconfigured\.error, \/未配置\//)
  assert.match(source, /assert\.match\(invalid\.error, \/未知更新通道\//)
  assert.ok(source.includes('preference.sandbox && preference.contextIsolation && !preference.nodeIntegration'))
  assert.ok(!source.includes("name: 'dsh 内核'"))
})
test('kernel smoke refuses the busy install before its one confirmed install and keeps signed cache and probe assertions', () => {
  const source = sources['kernel-update-smoke.mjs']
  assert.equal(source.match(/invoke\('install', 'kernel'\)/g)?.length, 2)
  assert.match(source, /const rejected = await updates\.evaluate\(\(\) => window\.workbenchUpdates\.invoke\('install', 'kernel'\)\)/)
  assert.match(source, /Active tasks must block installation before the consent dialog/)
  assert.equal(source.match(/__workbenchSmokeConfirmation\.respond\(1\)/g)?.length, 1)
  for (const text of ['NODE_EXTRA_CA_CERTS: certificate', "sign(null, payload, keys.privateKey)",
    'await fileHash(cache), asset.sha256', "assert.equal(consent.options.defaultId, 0)",
    "assert.equal(consent.options.cancelId, 0)", 'No installation state may change before consent',
    'No restart may precede consent', '已有更新操作或确认对话框正在进行',
    'Candidate must pass the real isolated Host probe', ".pending, 'staged'", '.pending, null',
    'assert.equal(selected.status.kernel.version, version)', 'Date.now() + 180_000']) assert.ok(source.includes(text), text)
  assert.ok(!source.includes('dialog.showMessageBox = async () => ({ response: 1'))
})

test('kernel consent proceeds directly to verified normal exit without a second UI confirmation', () => {
  const source = sources['kernel-update-smoke.mjs']
  const approval = 'await application.evaluate(() => globalThis.__workbenchSmokeConfirmation.respond(1))'
  const approved = source.indexOf(approval)
  const postConsent = source.slice(approved, source.indexOf('application = undefined', approved))
  assert.doesNotMatch(postConsent, /confirmation.click|let confirmation|Install and Restart|application.windows/)
  const listener = source.indexOf("once(application.process(), 'exit')")
  assert.ok(listener >= 0 && listener < approved)
  assert.ok(postConsent.includes('assert.equal(exitCode, 0)'))
  assert.ok(postConsent.includes('assert.equal(signal, null)'))
  assert.ok(source.includes('assert.equal(selected.status.desktop.version, desktop.version)'))
})
