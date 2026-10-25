/** Drive the dedicated progress entry with disposable data; no Host or real migration is started. */
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { installUserDesktop } from '../build/user-install.mjs'
import { fileHash } from '../build/update-core.mjs'
import { processIdentity } from '../updates/migration-processes.mjs'

const root = resolve(import.meta.dirname, '..')
const require = createRequire(join(root, 'build/upstream/package.json'))
const { _electron } = require(require.resolve('playwright-core', { paths: [join(root, 'build/upstream/node_modules/.pnpm/node_modules')] }))
const temporary = await fs.mkdtemp('/tmp/dsh-progress-smoke-')
let application
try {
  const home = join(temporary, 'home')
  await fs.mkdir(home, { mode: 0o700 })
  let executable = process.env.DSH_WORKBENCH_TEST_APP
  let args = []
  if (!executable) {
    const metadata = JSON.parse(await fs.readFile(join(root, 'desktop.json'), 'utf8'))
    const name = `dsh-workbench-${metadata.version}-r${metadata.linuxRevision}-linux-x64.tar.gz`
    const archive = join(root, 'dist', name)
    const checksum = (await fs.readFile(join(root, 'dist/SHA256SUMS'), 'utf8')).split('\n')
      .find(line => line.endsWith(`  ${name}`))?.split('  ')[0]
    assert.match(checksum ?? '', /^[a-f0-9]{64}$/)
    assert.equal(await fileHash(archive), checksum)
    const installed = await installUserDesktop({ archive, sha256: checksum, version: metadata.version,
      home, root: join(home, 'Applications/dsh-linux-desktop'), xdgDataHome: join(home, '.local/share') })
    executable = installed.executable
  }
  // Local development can exercise the real main bundle through the prepared Electron distribution.
  if (process.env.DSH_WORKBENCH_PROGRESS_SOURCE === '1') {
    const app = join(temporary, 'app')
    await fs.mkdir(join(app, 'lib'), { recursive: true })
    await fs.writeFile(join(app, 'package.json'), JSON.stringify({ name: 'dsh-workbench', version: '0.0.0', main: 'lib/main.js', type: 'module' }))
    for (const file of ['main.js', 'workbench.mjs', 'workbench-migration-progress.mjs']) {
      await fs.copyFile(join(root, 'build/upstream/apps/desktop/lib', file), join(app, 'lib', file))
    }
    await fs.symlink(join(root, 'build/upstream/apps/desktop/node_modules'), join(app, 'node_modules'))
    await fs.cp(join(root, 'build/workbench-assets'), join(app, 'workbench'), { recursive: true })
    args = [app]
  }
  const transactionId = randomUUID()
  const directory = join(home, 'Backups/dsh-workbench', transactionId)
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const transactionPath = join(directory, 'transaction.json')
  await fs.writeFile(transactionPath, JSON.stringify({ schemaVersion: 1, transactionId, home, directory }), { mode: 0o600 })
  const gate = join(home, 'Backups/dsh-workbench/.migration-lock')
  await fs.mkdir(gate, { mode: 0o700 })
  await fs.writeFile(join(gate, 'owner.json'), JSON.stringify({ transactionId, directory }), { mode: 0o600 })
  const worker = await processIdentity(process.pid)
  const update = async details => {
    const report = { schemaVersion: 1, transactionId, worker, updatedAt: new Date().toISOString(), events: [], ...details }
    await fs.writeFile(join(directory, 'report.next'), JSON.stringify(report), { mode: 0o600 })
    await fs.rename(join(directory, 'report.next'), join(directory, 'report.json'))
  }
  await update({ phase: 'backup' })
  const env = { ...process.env, HOME: home, DSH_HOME: join(home, '.dsh'), XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'), XDG_DATA_HOME: join(home, '.local/share'), ELECTRON_RUN_AS_NODE: undefined }
  application = await _electron.launch({ executablePath: executable, args: [...args, '--dsh-migration-progress', transactionPath],
    chromiumSandbox: true, env, timeout: 30_000 })
  const page = await application.firstWindow()
  await page.waitForURL('**/migration-progress.html')
  await page.locator('[aria-current="step"]').filter({ hasText: '备份' }).waitFor()
  const paths = await application.evaluate(({ app }) => ({ userData: app.getPath('userData'), sessionData: app.getPath('sessionData') }))
  assert.equal(paths.userData, join(directory, 'progress-profile'))
  assert.equal(paths.sessionData, paths.userData)
  await assert.rejects(fs.lstat(join(home, '.dsh')), { code: 'ENOENT' })
  assert.equal(application.windows().length, 1)
  await update({ phase: 'stopping-processes', processActions: [{ pid: 1234, action: 'SIGTERM', result: 'waiting' }] })
  await page.locator('#processes').filter({ hasText: '1234' }).waitFor()
  await update({ phase: 'failed', error: '无法停止占用进程；API_KEY=SECRET_KEY', recovery: '源数据和旧程序已保留。',
    fallbackError: '原版本启动失败', processActions: [{ pid: 1234, action: 'SIGKILL', result: 'exited' }] })
  await page.locator('#fallback-error').filter({ hasText: '原版本启动失败' }).waitFor()
  await page.getByRole('button', { name: '复制错误报告', exact: true }).click()
  await page.locator('#feedback').filter({ hasText: '报告已复制' }).waitFor()
  const copied = await application.evaluate(({ clipboard }) => clipboard.readText())
  for (const expected of ['无法停止占用进程', '源数据和旧程序已保留', '原版本启动失败', 'report.json', '1234']) assert.ok(copied.includes(expected))
  assert.doesNotMatch(copied, /SECRET_KEY/)
  await update({ phase: 'backup', worker: { ...worker, startTime: '0' } })
  await page.locator('#error').filter({ hasText: '升级进程意外退出' }).waitFor()
  await page.screenshot({ path: join(root, 'build/migration-progress-smoke.png') })
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await setTimeout(100)
  console.log('Dedicated progress entry, profile isolation, visible errors and one-click report copy passed.')
} finally {
  if (application) await application.close().catch(error => console.error(`Progress smoke cleanup: ${error.message}`))
  await fs.rm(temporary, { recursive: true, force: true })
}
