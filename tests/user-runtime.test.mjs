import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { assertWholeDesktopStartupAllowed } from '../build/whole-desktop.mjs'

const main = readFileSync(new URL('../build/upstream/apps/desktop/src/main.ts', import.meta.url), 'utf8')

test('desktop activation restarts the explicit new executable while kernel restart retains its default', () => {
  const line = main.split('\n').find(line => line.includes('restart: (execPath) =>'))
  assert.ok(line)
  let options, quits = 0
  const restart = runInNewContext(`({${line.trim()}}).restart`, {
    app: { relaunch: value => { options = value } }, quitWithoutConfirmation: () => { quits++ },
  })
  restart('/home/user/Applications/dsh-linux-desktop/versions/new/dsh-workbench')
  assert.equal(options.execPath, '/home/user/Applications/dsh-linux-desktop/versions/new/dsh-workbench')
  restart()
  assert.equal(options, undefined)
  assert.equal(quits, 0, 'Scheduling relaunch must not exit before archive/lock cleanup')
  const finishLine = main.split('\n').find(line => line.includes('finishRestart: () => {'))
  assert.ok(finishLine)
  const finish = runInNewContext(`({${finishLine.trim()}}).finishRestart`, { quitWithoutConfirmation: () => { quits++ } })
  finish()
  assert.equal(quits, 1)
})

test('packaged Linux Hosts advertise the actual selected kernel, not an assumed /opt tree', () => {
  const start = main.indexOf('{ ...hostEnvironment, DSH_CLIENT_VERSION: desktopClientVersion(),')
  const end = main.indexOf('}, onFailure,', start) + 1
  assert.ok(start >= 0 && end > start)
  const environment = runInNewContext(`(${main.slice(start, end)})`, {
    join, dirname, process: { platform: 'linux' }, app: { isPackaged: true,
      getAppPath: () => '/home/user/Applications/dsh-linux-desktop/versions/desktop/resources/app' },
    resources: { dsh: '/home/user/.config/dsh-workbench/updates/kernels/kernel/dsh' },
    hostEnvironment: { DSH_BASE: '/old/kernel' }, desktopClientVersion: () => '1.0.0',
  })
  assert.equal(environment.DSH_SURFACE, 'desktop')
  assert.equal(environment.DSH_BASE, '/home/user/.config/dsh-workbench/updates/kernels/kernel/dsh/node_modules/@deepseek-ai')
  assert.equal(environment.DSH_DESKTOP_INSTALL, '/home/user/Applications/dsh-linux-desktop/versions/desktop')
  const adapter = readFileSync(new URL('../updates/desktop.mjs', import.meta.url), 'utf8')
  assert.match(adapter, /else installed = await manager\.installDesktop\(options\.prepareRestart, artifact => installUserDesktop/)
  assert.doesNotMatch(adapter, /installSystemDesktop|installedFormat|system-install\.mjs/)
})

test('whole desktop startup checks actual data roots before opening settings and never relaunches its parent', () => {
  const start = main.indexOf('async function main(): Promise<void> {')
  const settings = main.indexOf('const desktopSettings = readDesktopSettings', start)
  const guard = main.indexOf('await workbenchModule.assertWholeDesktopStartupAllowed(', start)
  assert.ok(guard > start && guard < settings, 'migration guard must precede all main data reads')
  const request = main.slice(start, main.indexOf('let primaryRuntime', start))
  assert.match(request, /dshHome: dirname\(dirname\(paths.profile\)\)/)
  assert.match(request, /userData: app.getPath\('userData'\)/)
  assert.match(request, /oldExecutable: process.execPath/)
  assert.match(request, /resolveDesktopHostNode\(join\(process.resourcesPath, 'runtime', 'primary-runtime'\), process.execPath\)/)
  assert.match(request, /workerPath: fileURLToPath\(new URL\('\.\/workbench-migration-worker.mjs', import.meta.url\)\)/)
  const line = main.split('\n').find(line => line.includes('quitWithoutRelaunch: () => {'))
  assert.ok(line)
  let quits = 0
  runInNewContext(`({${line.trim()}}).quitWithoutRelaunch`, {
    quitWithoutConfirmation: () => { quits++ },
    app: { relaunch: () => assert.fail('worker, not parent, starts the target executable') },
  })()
  assert.equal(quits, 1)
})

test('a real active migration startup guard exits without reading data or entering fatal repair', async t => {
  const home = await fs.mkdtemp('/tmp/dsh-main-guard-test-')
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const directory = join(home, 'Backups/dsh-workbench/transaction')
  const lock = join(home, 'Backups/dsh-workbench/.migration-lock')
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  await fs.mkdir(lock, { mode: 0o700 })
  await fs.writeFile(join(lock, 'owner.json'), JSON.stringify({ transactionId: 'guard-test', directory }))
  await fs.writeFile(join(directory, 'report.json'), JSON.stringify({ phase: 'backup' }))
  const start = main.indexOf('async function main(): Promise<void> {')
  const code = main.slice(main.indexOf('if (workbenchModule !== undefined)', start),
    main.indexOf('const desktopSettings = readDesktopSettings', start))
  for (const nativeFails of [false, true]) {
    let reads = 0
    let exit
    const errors = []
    const boxes = []
    await runInNewContext(`(async () => { ${code} readData(); })()`, {
      workbenchModule: { assertWholeDesktopStartupAllowed,
        showMigrationFailure: async (message, transactionPath) => { boxes.push([message, transactionPath]); if (nativeFails) throw new Error('native dialog failed') } },
      wholeDesktopPaths: { home }, Error,
      console: { error: value => errors.push(String(value)) },
      dialog: { showErrorBox: (title, message) => { boxes.push([title, message]); if (nativeFails) throw new Error('native dialog failed') } },
      app: { getName: () => 'Fixture Desktop', exit: code => { exit = code } }, readData: () => { reads++ },
      reportFatal: () => assert.fail('migration gate never enters data-writing fatal repair'),
    })
    assert.equal(reads, 0)
    assert.equal(exit, 1)
    assert.equal(boxes.length, 1)
    assert.ok(boxes[0][0].includes(join(directory, 'report.json')))
    assert.equal(boxes[0][1], join(directory, 'transaction.json'))
    assert.ok(errors.some(message => message.includes(join(directory, 'report.json'))))
  }
})

test('the shipped renderer checks every channel and installs a cross-epoch release with one button', async () => {
  const html = readFileSync(new URL('../updates/updates.html', import.meta.url), 'utf8')
  const source = readFileSync(new URL('../updates/updates.js', import.meta.url), 'utf8')
  const nodes = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], { textContent: '' }]))
  const buttons = [...html.matchAll(/<button data-action="([^"]+)"/g)].map(match => ({
    dataset: { action: match[1] }, disabled: false,
    addEventListener(_event, listener) { this.click = listener },
  }))
  assert.deepEqual(buttons.map(button => button.dataset.action), ['check', 'install'])
  const current = { version: '1.0.0', linuxRevision: 7, available: null, configured: true }
  const status = { kernel: { ...current, crossEpoch: true }, desktop: { ...current, crossEpoch: true },
    desktopUpgrade: { ...current, available: '2.0.0', availableLinuxRevision: 2 }, busy: false, notice: '' }
  const calls = []
  runInNewContext(source, { document: {
    getElementById: id => { assert.ok(nodes.has(id), `shipped HTML contains ${id}`); return nodes.get(id) },
    querySelectorAll: selector => { assert.equal(selector, 'button'); return buttons },
  }, window: { workbenchUpdates: { invoke: async (action, channel) => {
    calls.push([action, channel])
    return { status, ...(action === 'check' && channel !== 'desktopUpgrade' ? { error: '数据格式不兼容' } : {}) }
  } } }, setInterval: () => {} })
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls.filter(([action]) => action === 'check').map(([, channel]) => channel), ['kernel', 'desktop', 'desktopUpgrade'])
  assert.equal(nodes.get('error').textContent, '')
  assert.match(nodes.get('version').textContent, /1\.0\.0 · Linux r7/)
  assert.match(nodes.get('latest').textContent, /2\.0\.0 · Linux r2/)
  const install = buttons.find(button => button.dataset.action === 'install')
  assert.equal(install.disabled, false)
  await install.click()
  assert.deepEqual(calls.at(-1), ['install', 'desktopUpgrade'])
})

test('Electron routes the explicit whole upgrade with main-owned paths and no ordinary restart', () => {
  const adapter = readFileSync(new URL('../updates/desktop.mjs', import.meta.url), 'utf8')
  assert.match(adapter, /export \{ assertWholeDesktopStartupAllowed \}/)
  assert.match(adapter, /manager\.checkWholeDesktopUpgrade\(\)/)
  assert.match(adapter, /channel === 'kernel' \? manager\.installKernelMigration\.bind\(manager\) : manager\.installWholeDesktopUpgrade\.bind\(manager\)/)
  assert.match(adapter, /await install\(\{/)
  assert.match(adapter, /\.\.\.options.wholeDesktop/)
  assert.match(adapter, /quitWithoutRelaunch: options.quitWithoutRelaunch/)
  assert.match(adapter, /await markWholeDesktopHealthy\(/)
  assert.match(adapter, /自动关闭使用同一数据的 dsh 命令行/)
  assert.match(adapter, /openProgress: openMigrationProgress/)
})
