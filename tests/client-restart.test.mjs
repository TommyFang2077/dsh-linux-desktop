import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import test from 'node:test'

const dependencies = resolve(process.env.DSH_UPSTREAM_DEPENDENCIES ?? 'build/upstream')
const require = createRequire(join(dependencies, 'package.json'))
const { transform } = require(require.resolve('esbuild', { paths: [join(dependencies, 'node_modules/.pnpm/node_modules')] }))

test('patched real main lifecycle applies to pinned upstream and never stops busy or unknown tasks', async t => {
  const directory = await fs.mkdtemp('/tmp/dsh-client-restart-')
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const name = 'apps/desktop/src/main.ts'
  const patch = await fs.readFile('patches/linux.patch', 'utf8')
  const part = patch.split('diff --git ').find(part => part.startsWith('a/' + name + ' b/'))
  const { commit } = JSON.parse(await fs.readFile('upstream.json', 'utf8'))
  await fs.mkdir(join(directory, 'apps/desktop/src'), { recursive: true })
  await fs.writeFile(join(directory, name), execFileSync('git', ['-C', process.env.DSH_UPSTREAM_SOURCE ?? 'build/upstream', 'show', commit + ':' + name]))
  execFileSync('git', ['apply', '-'], { cwd: directory, input: 'diff --git ' + part })
  const source = await fs.readFile(join(directory, name), 'utf8')
  await transform(source, { loader: 'ts', format: 'esm' })
  const recoveryStart = source.indexOf('  const reconcileBackend =')
  const recoveryEnd = source.indexOf('  const recoverWorkbenchBackend =', recoveryStart)
  assert.ok(recoveryStart > 0 && recoveryEnd > recoveryStart)
  const recovery = (await transform(source.slice(recoveryStart, recoveryEnd), { loader: 'ts', target: 'node24' })).code
  const recoveryFactory = new Function('deps', 'with (deps) { ' + recovery + '; return reconcileBackend }')
  for (const scenario of ['rollback', 'refused', 'second-fails']) await t.test('startup recovery ' + scenario, async () => {
    const order = []
    let starts = 0
    const backend = { host: undefined, start: async prepare => {
      starts++; order.push('start'); await prepare()
      if (starts === 1 || scenario === 'second-fails') throw Error('startup failed')
      backend.host = {}
    }, stop: async () => { order.push('stop'); backend.host = undefined } }
    const deps = { startup: undefined, quitting: false, backend, applicationUrl: 'app://start',
      navigateMain: async () => {}, manager: { applyRelease: async () => {} }, prepareHostEnvironment: async () => {},
      paths: { profile: '/profile/data/user' }, dirname: value => value.slice(0, value.lastIndexOf('/')),
      workbench: { rollback: async () => { order.push('rollback'); return scenario !== 'refused' },
        ensureDefaults: async () => {}, markHealthy: async () => { order.push('healthy') } },
      openInitialWindow: async () => { order.push('window') }, selectWorkbenchResources: async () => { order.push('select') },
      updateJournal: { action: event => { order.push(event) } }, reportFatal: () => { order.push('fatal') },
      hostUrl: 'old', hostCookie: 'old', injections: ['old'], navigation: {}, workbenchStartup: true }
    const run = recoveryFactory(deps)
    if (scenario === 'rollback') {
      await run()
      assert.deepEqual(order, ['start', 'rollback', 'stop', 'select', 'start', 'window', 'healthy', 'workspace-ready'])
      assert.equal(deps.hostUrl, undefined); assert.equal(deps.hostCookie, undefined)
      assert.deepEqual(deps.injections, []); assert.equal(deps.navigation, undefined)
    } else {
      await assert.rejects(run(), /startup failed/)
      assert.equal(order.includes('healthy'), false)
      assert.equal(order.includes('window'), false)
      assert.equal(starts, scenario === 'refused' ? 1 : 2)
      assert.deepEqual(order.slice(-2), ['workspace-failed', 'fatal'])
    }
    assert.equal(deps.startup, undefined); assert.equal(deps.workbenchStartup, false)
  })
  const start = source.indexOf('  const prepareRestart = async ')
  const end = source.indexOf('  const prepareWorkbenchRestart', start)
  assert.ok(start > 0 && end > start)
  const prepare = (await transform(source.slice(start, end), { loader: 'ts', target: 'node24' })).code
  const instantiate = new Function('deps', 
    'const { commandManager, workspaceRecovery, startup, backend, DesktopUpdatePreparationError, locale, updates, desktopUpdateReadyConfirmation, isMandatory, mandatoryUI, currentDialogWindow, updateDialog, isQuitting, track, platformView, updateJournal } = deps;' +
    'let quitting = false, requireCleanStop = false, updateStopFailure, updateStoppedHost = false, shellInstallerOwnsQuit = false;' + prepare + 'return () => prepareRestart(true);')
  for (const scenario of ['busy', 'unknown', 'malformed-inspect', 'became-busy', 'malformed-lock', 'lock-failure', 'idle']) await t.test(scenario, async () => {
    let stops = 0, dialogs = 0, closes = 0
    const calls = []
    const host = { updateTasks: async action => {
      calls.push(action)
      if (action === 'inspect' && scenario === 'unknown') throw new Error('task services unavailable')
      if (action === 'lock' && scenario === 'lock-failure') throw new Error('inspection timeout')
      if (action === 'inspect' && scenario === 'malformed-inspect') return undefined
      if (action === 'lock' && scenario === 'malformed-lock') return undefined
      return action === 'inspect' ? scenario === 'busy' : action === 'lock' && scenario === 'became-busy'
    } }
    const backend = { host, stop: async () => { stops++ } }
    const run = instantiate({ commandManager: { idle: async () => {} }, workspaceRecovery: Promise.resolve(), startup: Promise.resolve(), backend,
      DesktopUpdatePreparationError: Error, locale: { messages: {} }, updates: { state: {} }, desktopUpdateReadyConfirmation: () => ({}),
      isMandatory: () => false, mandatoryUI: undefined, currentDialogWindow: () => undefined,
      updateDialog: { show: async () => { dialogs++; return { response: 0 } } }, isQuitting: () => false,
      track: async () => {}, platformView: { closeAndWait: async () => { closes++ } }, updateJournal: undefined })
    if (scenario === 'idle') {
      assert.equal(await run(), true)
      assert.equal(stops, 1)
      assert.equal(closes, 1)
      assert.deepEqual(calls, ['inspect', 'lock'])
    } else {
      await assert.rejects(run())
      assert.equal(stops, 0)
      assert.equal(closes, 0)
      assert.deepEqual(calls, ['busy', 'unknown', 'malformed-inspect'].includes(scenario) ? ['inspect'] : ['inspect', 'lock', 'unlock'])
    }
    assert.equal(dialogs, 0)
  })
})
