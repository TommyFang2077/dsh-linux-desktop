/** Drive first launch without credentials or changes to the user's Harness data. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'

const root = resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)
const { _electron } = require(require.resolve('playwright-core', {
  paths: [join(root, 'build/upstream/node_modules/.pnpm/node_modules')],
}))
const temporary = await mkdtemp('/tmp/dsh-workbench-gui-')
let application
try {
  const { version } = JSON.parse(readFileSync(join(root, 'upstream.json'), 'utf8'))
  const extracted = join(temporary, 'application')
  execFileSync('dpkg-deb', ['--extract', join(root, `dist/dsh-workbench-${version}-x64.deb`), extracted])
  application = await _electron.launch({
    executablePath: join(extracted, 'opt/dsh-workbench/dsh-workbench'),
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/iu.test(key))),
      HOME: temporary,
      XDG_CONFIG_HOME: join(temporary, 'config'),
      XDG_DATA_HOME: join(temporary, 'data'),
      XDG_CACHE_HOME: join(temporary, 'cache'),
      DSH_HOME: join(temporary, 'dsh'),
    },
    timeout: 120_000,
  })
  const identity = await application.evaluate(({ app }) => ({
    name: app.getName(), data: app.getPath('userData'), noSandbox: app.commandLine.hasSwitch('no-sandbox'),
  }))
  assert.equal(identity.name, 'dsh-workbench')
  assert.equal(identity.noSandbox, false)
  assert.ok(identity.data.startsWith(temporary))
  let welcome
  for (let attempt = 0; attempt < 600 && !welcome; attempt++) {
    welcome = application.windows().find(page => page.url().endsWith('/welcome.html'))
    if (!welcome) await setTimeout(100)
  }
  assert.ok(welcome, 'The welcome window must load')
  await welcome.getByRole('button', { name: /Add API Key|添加 API Key/ }).click()
  await welcome.getByRole('button', { name: /Set up later|稍后配置/ }).click()
  const workspace = application.windows().find(page => page.url().startsWith('dsh-app://'))
  assert.ok(workspace, 'The official workspace window must exist')
  await workspace.waitForFunction(() => document.body.innerText.trim().length > 100, undefined, { timeout: 120_000 })
  const preferences = await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map(window => window.webContents.getLastWebPreferences()))
  assert.ok(preferences.every(preference => preference.sandbox && preference.contextIsolation && !preference.nodeIntegration))
  await workspace.screenshot({ path: join(root, 'build/gui-smoke.png') })
  console.log('Packaged welcome → workspace GUI smoke passed; sandbox retained')
} finally {
  if (application) await application.close()
  await rm(temporary, { recursive: true, force: true })
}
