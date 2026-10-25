import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { migrationReportText, readMigrationReport, migrationProgressContext, publicMigrationReport } from '../updates/migration-report.mjs'

test('copied migration errors include recovery and exclude unrelated private fields', () => {
  const text = migrationReportText({ schemaVersion: 1, transactionId: 'transaction-id', phase: 'failed',
    error: 'Writer did not exit', recovery: 'Original data preserved', fallbackError: 'Old desktop could not launch',
    updatedAt: '2026-10-26T00:00:00Z', processActions: [{ pid: 123, action: 'SIGTERM', result: 'exited', command: 'SECRET_COMMAND' }],
    environment: { API_KEY: 'SECRET_KEY' }, archive: 'SECRET_ARCHIVE', workerLog: 'SECRET_LOG',
  }, '/home/fixture/Backups/dsh-workbench/report.json')
  for (const expected of ['failed', 'Writer did not exit', 'Original data preserved', 'Old desktop could not launch', '123', 'SIGTERM', 'report.json']) assert.ok(text.includes(expected))
  assert.doesNotMatch(text, /SECRET_/)
})

test('free-form migration errors redact credentials before display or copy', () => {
  const report = publicMigrationReport({ phase: 'failed', error: 'Download https://alice:PASSWORD@example.test/asset?token=URL_SECRET#fragment failed; Authorization: Bearer HEADER_SECRET\nAPI_KEY="API_SECRET"',
    recovery: 'Retry with password=PASSWORD_SECRET', fallbackError: 'token=TOKEN_SECRET or sk-EXPOSEDKEY123',
    events: [null], processActions: [null] })
  for (const value of [report.error, report.recovery, report.fallbackError]) assert.doesNotMatch(value, /PASSWORD|URL_SECRET|HEADER_SECRET|API_SECRET|TOKEN_SECRET/)
  assert.match(report.error, /example\.test\/asset/)
  assert.match(report.error, /REDACTED/)
  assert.doesNotMatch(report.fallbackError, /EXPOSEDKEY123/)
  assert.deepEqual(report.events, [])
  assert.deepEqual(report.processActions, [])
})

test('the viewer accepts only private matching reports in a real transaction directory', async t => {
  const home = await fs.mkdtemp('/tmp/dsh-migration-progress-')
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const transactionId = randomUUID()
  const directory = join(home, 'Backups/dsh-workbench', transactionId)
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const transactionPath = join(directory, 'transaction.json')
  await fs.writeFile(transactionPath, JSON.stringify({ schemaVersion: 1, transactionId, directory, home }), { mode: 0o600 })
  const context = await migrationProgressContext(transactionPath, home)
  const reportPath = join(directory, 'report.json')
  await fs.writeFile(reportPath, JSON.stringify({ schemaVersion: 1, transactionId, phase: 'failed', error: 'Backup failed' }), { mode: 0o600 })
  assert.equal((await readMigrationReport(context)).error, 'Backup failed')
  await fs.chmod(reportPath, 0o644)
  assert.throws(() => readMigrationReport(context), /private/i)
  await fs.chmod(reportPath, 0o600)
  await fs.writeFile(reportPath, JSON.stringify({ schemaVersion: 1, transactionId: randomUUID(), phase: 'failed' }))
  assert.throws(() => readMigrationReport(context), /mismatch/i)
  const linked = join(home, 'linked')
  await fs.symlink(directory, linked)
  assert.throws(() => migrationProgressContext(join(linked, 'transaction.json'), home), /transaction|directory/i)
})

test('the independent viewer isolates its profile, reports a dead worker and copies the visible error', async t => {
  const home = await fs.mkdtemp('/tmp/dsh-migration-viewer-')
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const transactionId = randomUUID()
  const directory = join(home, 'Backups/dsh-workbench', transactionId)
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  await fs.writeFile(join(directory, 'transaction.json'), JSON.stringify({ schemaVersion: 1, transactionId, directory, home }), { mode: 0o600 })
  await fs.writeFile(join(directory, 'report.json'), JSON.stringify({ schemaVersion: 1, transactionId, phase: 'backup',
    worker: { pid: process.pid, startTime: 'incorrect-identity', bootId: 'incorrect-boot' } }), { mode: 0o600 })
  const handles = new Map(), paths = new Map(), webEvents = new Map()
  let copied
  const dialogResponses = []
  const nativeDialogs = []
  let window
  class Window {
    constructor() { window = this; this.webContents = { mainFrame: {}, setWindowOpenHandler() {}, on: (name, callback) => webEvents.set(name, callback) } }
    on() {}
    async loadURL(url) { this.webContents.mainFrame.url = url }
    show() {}
    focus() {}
    close() {}
  }
  const source = await fs.readFile(new URL('../updates/migration-progress.mjs', import.meta.url), 'utf8')
  const run = runInNewContext(source.replace(/^import .*\n/gm, '').replace('export async function', 'async function') + '\nrunMigrationProgress', {
    app: { setPath: (name, path) => paths.set(name, path), setAppLogsPath() {}, on() {},
      whenReady: async () => { assert.equal(paths.get('userData'), join(directory, 'progress-profile')); assert.equal(paths.get('sessionData'), paths.get('userData')) },
      getAppPath: () => home },
    BrowserWindow: Window, clipboard: { writeText: value => { copied = value } },
    dialog: { showMessageBox: async (_window, options) => { nativeDialogs.push(options); return { response: dialogResponses.shift() ?? 2 } } }, shell: {},
    ipcMain: { handle: (name, callback) => handles.set(name, callback) },
    process: { env: { HOME: home }, getuid: () => process.getuid() },
    lstatSync, mkdirSync, readFileSync, realpathSync, join, pathToFileURL,
    migrationProgressContext: path => migrationProgressContext(path, home), migrationReportText, publicMigrationReport, readMigrationReport,
  })
  await run(join(directory, 'transaction.json'))
  const invoke = handles.get('dsh-workbench:migration')
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
  const status = await invoke(event, 'status')
  assert.equal(status.report.phase, 'failed')
  assert.match(status.report.error, /升级进程意外退出/)
  await invoke(event, 'copy')
  assert.match(copied, /升级进程意外退出/)
  assert.ok(copied.includes(join(directory, 'report.json')))
  await assert.rejects(invoke({ ...event, senderFrame: { url: event.senderFrame.url } }, 'copy'), /不可信/)
  await fs.rm(join(directory, 'report.json'))
  assert.match((await invoke(event, 'status')).report.error, /无法读取升级状态/)
  await invoke(event, 'copy')
  assert.match(copied, /无法读取升级状态/)
  await fs.writeFile(join(directory, 'report.json'), JSON.stringify({ schemaVersion: 1, transactionId, phase: 'prepared',
    parent: { pid: process.pid, startTime: 'incorrect-identity', bootId: 'incorrect-boot' } }), { mode: 0o600 })
  assert.match((await invoke(event, 'status')).report.error, /原应用.*意外退出/)
  dialogResponses.push(0, 2)
  webEvents.get('render-process-gone')({}, { reason: 'crashed' })
  await new Promise(resolve => setImmediate(resolve))
  assert.match(nativeDialogs[0].message, /进度窗口/)
  assert.match(copied, /crashed/)
  assert.ok(nativeDialogs[0].buttons.includes('复制错误报告'))
})

test('one click copies the failure report and surfaces clipboard errors', async () => {
  const html = await fs.readFile(new URL('../updates/migration-progress.html', import.meta.url), 'utf8')
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], {
    textContent: '', disabled: false, setAttribute() {}, removeAttribute() {}, replaceChildren() {},
    addEventListener(_event, callback) { this.click = callback },
  }]))
  const calls = []
  let copyError = false
  const source = await fs.readFile(new URL('../updates/migration-progress.js', import.meta.url), 'utf8')
  runInNewContext(source, {
    document: { getElementById: id => elements.get(id), createElement: () => ({ setAttribute() {} }) },
    window: { migrationProgress: { invoke: async action => {
      calls.push(action)
      if (action === 'copy' && copyError) throw new Error('Clipboard unavailable')
      return action === 'status' ? { report: { phase: 'failed', error: '<script>untrusted</script>',
        recovery: 'Original data preserved', fallbackError: 'Old desktop could not launch' }, reportPath: '/private/report.json' } : { copied: true }
    } } },
    setInterval() {},
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(elements.get('error').textContent, '<script>untrusted</script>')
  assert.match(elements.get('fallback-error').textContent, /Old desktop could not launch/)
  await elements.get('copy').click()
  assert.deepEqual(calls, ['status', 'copy'])
  assert.equal(elements.get('feedback').textContent, '报告已复制。')
  copyError = true
  await elements.get('copy').click()
  assert.equal(elements.get('feedback').textContent, 'Clipboard unavailable')
  assert.equal(elements.get('copy').disabled, false)
})
