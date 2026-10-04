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
  const { version } = JSON.parse(readFileSync(join(root, 'desktop.json'), 'utf8'))
  const extracted = join(temporary, 'application')
  if (!process.env.DSH_WORKBENCH_TEST_APP) execFileSync('dpkg-deb', ['--extract', join(root, `dist/dsh-workbench-${version}-x64.deb`), extracted])
  application = await _electron.launch({
    chromiumSandbox: true,
    executablePath: process.env.DSH_WORKBENCH_TEST_APP ?? join(extracted, 'opt/dsh-workbench/dsh-workbench'),
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
  application.process().stderr.on('data', data => process.stderr.write(data))
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
  const menu = await application.evaluate(({ BrowserWindow, Menu }) => ({
    visible: BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('dsh-app://')).isMenuBarVisible(),
    removed: Menu.getApplicationMenu() === null,
  }))
  assert.deepEqual(menu, { visible: false, removed: true }, 'Linux must remove the Application/Edit menu bar, not merely hide it')
  const market = JSON.parse(readFileSync(join(temporary, 'dsh/profiles/desktop/node_modules/dshmarket/package.json'), 'utf8'))
  assert.equal(market.name, 'dshmarket')
  assert.equal(market.version, '1.66.8')
  assert.equal(JSON.parse(readFileSync(join(identity.data, 'default-market.json'), 'utf8')).name, 'dshmarket')
  await workspace.getByText(/^(新会话|New (?:chat|session|conversation))$/i)
    .waitFor({ state: 'visible', timeout: 30_000 })
  await workspace.getByText(/^(更多|More)$/).click()
  await workspace.getByText(/^(设置|Settings)$/).click()
  const marketEntry = workspace.getByText(/^(Plugin Market|插件市场|应用市场)$/).first()
  await marketEntry.waitFor({ state: 'visible', timeout: 30_000 })
  await marketEntry.click()
  await workspace.screenshot({ path: join(root, 'build/market-smoke.png') })
  await workspace.evaluate(() => window.dshDesktop.openWorkbenchUpdates())
  let updates
  for (let attempt = 0; attempt < 100 && !updates; attempt++) {
    updates = application.windows().find(page => page.url().endsWith('/workbench/updates.html'))
    if (!updates) await setTimeout(100)
  }
  assert.ok(updates, 'The independent updates window must open from the trusted desktop bridge')
  await updates.getByRole('heading', { name: 'dsh 内核' }).waitFor({ state: 'visible' })
  await updates.getByRole('heading', { name: '桌面端', exact: true }).waitFor({ state: 'visible' })
  const state = await updates.evaluate(() => window.workbenchUpdates.invoke('status'))
  assert.equal(state.status.desktop.version, version)
  assert.equal(state.status.kernel.version, JSON.parse(readFileSync(join(root, 'upstream.json'), 'utf8')).version)
  assert.equal(state.status.kernel.configured, false)
  assert.equal(state.status.desktop.configured, false)
  const unconfigured = await updates.evaluate(() => window.workbenchUpdates.invoke('check', 'kernel'))
  assert.match(unconfigured.error, /未配置/)
  const invalid = await updates.evaluate(() => window.workbenchUpdates.invoke('install', 'shell'))
  assert.match(invalid.error, /未知更新通道/)
  await updates.screenshot({ path: join(root, 'build/updates-smoke.png') })
  const preferences = await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map(window => window.webContents.getLastWebPreferences()))
  assert.ok(preferences.every(preference => preference.sandbox && preference.contextIsolation && !preference.nodeIntegration))
  await updates.close()
  await workspace.screenshot({ path: join(root, 'build/gui-smoke.png') })
  console.log('Packaged welcome → workspace GUI smoke passed; sandbox retained')
} catch (error) {
  if (application) {
    for (const page of application.windows()) {
      console.error('Window:', page.url(), await page.locator('body').innerText().catch(() => '<unavailable>'))
      await page.screenshot({ path: join(root, 'build/gui-failure.png') }).catch(() => undefined)
    }
  }
  throw error
} finally {
  if (application) await application.close()
  await rm(temporary, { recursive: true, force: true })
}
