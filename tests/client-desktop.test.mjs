import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const dependencies = resolve(process.env.DSH_UPSTREAM_DEPENDENCIES ?? 'build/upstream')
const require = createRequire(join(dependencies, 'package.json'))
const { build } = require(require.resolve('esbuild', { paths: [join(dependencies, 'node_modules/.pnpm/node_modules')] }))

test('real desktop adapter starts only after Host health, notifies nonmodally, and gates installation IPC', async t => {
  const directory = await fs.mkdtemp('/tmp/dsh-client-desktop-')
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const handlers = new Map(), windows = [], notifications = []
  let dialogs = 0, inspections = 0, active = false
  class Window extends EventEmitter {
    constructor() { super(); windows.push(this); this.webContents = new EventEmitter(); this.webContents.mainFrame = {}; this.webContents.setWindowOpenHandler = () => {} }
    async loadURL(url) { this.webContents.mainFrame.url = url }
    isDestroyed() { return false }
    show() {}
    focus() {}
  }
  class Notification extends EventEmitter {
    static isSupported() { return true }
    constructor(options) { super(); this.options = options; notifications.push(this) }
    show() {}
  }
  const electron = { BrowserWindow: Window, Notification, ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    dialog: { showErrorBox: () => assert.fail('no startup modal'), showMessageBox: async () => { dialogs++; return { response: 0 } } } }
  globalThis.__clientElectron = electron
  t.after(() => { delete globalThis.__clientElectron })
  const outfile = join(directory, 'desktop.mjs')
  await build({ entryPoints: ['updates/desktop.mjs'], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node24',
    nodePaths: [join(dependencies, 'node_modules')],
    banner: { js: "import { createRequire as __req } from 'node:module'; const require = __req(import.meta.url);" },
    plugins: [{ name: 'electron-test', setup(plugin) {
      plugin.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'test' }))
      plugin.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export const { BrowserWindow, Notification, ipcMain, dialog } = globalThis.__clientElectron;' }))
    } }] })
  const metadata = { version: '1.0.0', protocol: 4, dataEpoch: 'schema-1', desktopRange: '>=1 <3', kernelRange: '>=1 <3', nodeRange: '>=24 <25', nodeVersion: '24.18.1' }
  const bytes = Buffer.from('background download only')
  const keys = generateKeyPairSync('ed25519')
  const release = { ...metadata, version: '1.1.0', linuxRevision: 1, schemaVersion: 2, channel: 'desktop', platform: 'linux', arch: 'x64', format: 'tar.gz',
    asset: { url: 'https://updates.test/asset', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } }
  const payload = Buffer.from(JSON.stringify(release))
  const envelope = { payload: payload.toString('base64'), signature: sign(null, payload, keys.privateKey).toString('base64') }
  let requests = 0
  t.mock.method(globalThis, 'fetch', async url => { requests++; return new Response(url.endsWith('/feed') ? JSON.stringify(envelope) : bytes) })
  for (const name of ['workbench', 'dsh', 'runtime/primary-runtime', 'userData']) await fs.mkdir(join(directory, name), { recursive: true })
  await fs.writeFile(join(directory, 'workbench/desktop.json'), JSON.stringify(metadata))
  await fs.writeFile(join(directory, 'workbench/updates.json'), JSON.stringify({ desktop: { url: 'https://updates.test/feed', publicKey: keys.publicKey.export({ format: 'pem', type: 'spki' }) } }))
  await fs.writeFile(join(directory, 'dsh/desktop-runtime.json'), JSON.stringify({ release: { version: metadata.version, hostProtocolVersion: 4 } }))
  await fs.writeFile(join(directory, 'runtime/primary-runtime/runtime.json'), JSON.stringify({ node: metadata.nodeVersion }))
  const app = new EventEmitter()
  Object.assign(app, { getAppPath: () => directory, getPath: () => join(directory, 'userData'), getVersion: () => metadata.version })
  t.after(() => app.emit('will-quit'))
  const { createWorkbenchUpdates } = await import(pathToFileURL(outfile))
  const updater = await createWorkbenchUpdates({ app, bundled: { dsh: join(directory, 'dsh'), runtime: join(directory, 'runtime') }, wholeDesktop: { home: directory },
    trustedSender: () => true, inspectTasks: async () => { inspections++; return active },
    prepareRestart: () => assert.fail('cancel or busy must not stop Host'), restart: () => assert.fail('must not restart'), recover: () => assert.fail('must not need recovery') })
  assert.equal(requests, 0)
  await updater.markHealthy()
  const versions = () => handlers.get('dsh-workbench:versions')({}, false)
  for (let attempt = 0; attempt < 200 && !(await versions()).automatic?.lastCheck; attempt++) await new Promise(resolve => setTimeout(resolve, 5))
  let status = await versions()
  assert.equal(status.downloaded.desktop, release.asset.sha256)
  const delay = status.automatic.nextCheck - status.automatic.lastCheck
  assert.ok(delay >= 6 * 60 * 60 * 1000 && delay < 6 * 60 * 60 * 1000 + 1000)
  assert.equal(notifications.length, 1)
  assert.equal(dialogs, 0)
  assert.equal(windows.length, 0)
  notifications[0].emit('click')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(windows.length, 1)
  const window = windows[0]
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
  const invoke = handlers.get('dsh-workbench:updates')
  await assert.rejects(invoke({ sender: {}, senderFrame: {} }, 'install', 'desktop'), /不可信/)
  status = (await invoke(event, 'install', 'desktop')).status
  assert.equal(dialogs, 1)
  assert.equal(inspections, 1)
  assert.equal(status.downloaded.desktop, release.asset.sha256)
  active = true
  assert.match((await invoke(event, 'install', 'desktop')).error, /活动任务/)
  active = undefined
  assert.match((await invoke(event, 'install', 'desktop')).error, /无法确认/)
  assert.equal(dialogs, 1)
  app.emit('will-quit')
  assert.equal((await versions()).automatic.nextCheck, null)
})
