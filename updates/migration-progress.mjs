import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { migrationProgressContext, migrationReportText, publicMigrationReport, readMigrationReport } from './migration-report.mjs'

const terminal = report => ['healthy', 'failed', 'cancelled'].includes(report.phase)

function workerAlive(identity) {
  if (!identity || !Number.isSafeInteger(identity.pid) || identity.pid < 1) return false
  try {
    const stat = readFileSync(`/proc/${identity.pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
    return fields[0] !== 'Z' && fields[19] === identity.startTime
      && readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() === identity.bootId
  } catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return false; throw error }
}

/** A dedicated shell entry calls this before app ready, without starting a Host or opening the normal profile. */
export async function runMigrationProgress(transactionPath) {
  const context = migrationProgressContext(transactionPath)
  const profile = join(context.directory, 'progress-profile')
  mkdirSync(profile, { recursive: true, mode: 0o700 })
  const info = lstatSync(profile)
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077) || realpathSync(profile) !== profile) {
    throw new Error('Migration progress profile must be a private real directory')
  }
  app.setPath('userData', profile)
  app.setPath('sessionData', profile)
  app.setAppLogsPath(join(profile, 'logs'))
  let report = { schemaVersion: 1, transactionId: context.transactionId, phase: 'prepared' }
  const status = () => {
    try {
      report = readMigrationReport(context)
      if (!terminal(report) && report.worker && !workerAlive(report.worker)) report = {
        ...report, failedPhase: report.phase, phase: 'failed', error: '升级进程意外退出，未收到完成确认。',
        recovery: '请保留备份与报告，检查恢复建议后再重试；不要在迁移状态不明时重复启动升级。',
      }
      if (!terminal(report) && !report.worker && report.parent && !workerAlive(report.parent)) report = {
        ...report, phase: 'failed', error: '原应用在升级进程接管前意外退出，升级未完成。',
        recovery: '请保留报告，确认原程序和数据状态后重试升级。',
      }
    } catch (error) {
      report = { ...report, phase: 'failed', error: `无法读取升级状态：${error.message}`,
        recovery: '请保留此窗口和报告，检查磁盘与文件权限后再处理。' }
    }
    return { report: publicMigrationReport(report), reportPath: context.reportPath }
  }
  await app.whenReady()
  const resources = join(app.getAppPath(), 'workbench')
  const url = pathToFileURL(join(resources, 'migration-progress.html')).href
  const window = new BrowserWindow({ width: 720, height: 650, minWidth: 460, minHeight: 440, show: false,
    title: '升级进度 · dsh-workbench', autoHideMenuBar: true,
    webPreferences: { preload: join(resources, 'migration-progress-preload.cjs'), contextIsolation: true,
      nodeIntegration: false, sandbox: true, webSecurity: true },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  let closeApproved = false
  let confirming = false
  let presentingFailure = false
  const presentViewerFailure = async message => {
    if (presentingFailure) return
    presentingFailure = true
    const current = status().report
    const details = migrationReportText({ ...current, phase: 'failed',
      error: `${message}${current.error ? `\n升级错误：${current.error}` : ''}`,
      recovery: '升级可能仍在继续。可重新打开进度窗口查看；请保留报告与备份。' }, context.reportPath)
    let feedback = ''
    try {
      while (true) {
        const answer = await dialog.showMessageBox(window, { type: 'error', title: '升级进度窗口异常',
          message: '升级进度窗口出现问题', detail: `${details}\n${feedback}`,
          buttons: ['复制错误报告', '重新打开进度', '关闭窗口'], defaultId: 1, cancelId: 2 })
        if (answer.response === 0) {
          try { clipboard.writeText(`${details}\n${feedback}`); feedback = '报告已复制。' }
          catch (error) { feedback = `复制失败：${publicMigrationReport({ error: error.message }).error}` }
          continue
        }
        if (answer.response === 1) {
          try { await window.loadURL(url); return }
          catch (error) { feedback = `重新打开失败：${publicMigrationReport({ error: error.message }).error}`; continue }
        }
        closeApproved = true
        window.close()
        return
      }
    } finally { presentingFailure = false }
  }
  const viewerFailure = message => { void presentViewerFailure(message).catch(error => { console.error(error); app.exit(1) }) }
  window.webContents.on('render-process-gone', (_event, details) => viewerFailure(`进度窗口进程已退出：${details.reason}`))
  const requestClose = async () => {
    if (confirming || closeApproved) return
    confirming = true
    try {
      if (!terminal(status().report)) {
        const answer = await dialog.showMessageBox(window, { type: 'question', title: '升级仍在进行',
          message: '关闭进度窗口后，升级仍会继续。', detail: '保留窗口可以查看升级进度和错误报告。',
          buttons: ['保留窗口', '关闭窗口'], defaultId: 0, cancelId: 0 })
        if (answer.response !== 1) return
      }
      closeApproved = true
      window.close()
    } finally { confirming = false }
  }
  window.on('close', event => { if (!closeApproved) { event.preventDefault(); void requestClose().catch(error => viewerFailure(error.message)) } })
  app.on('window-all-closed', () => app.quit())
  ipcMain.handle('dsh-workbench:migration', async (event, action) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
      || event.senderFrame.url !== url) throw new Error('拒绝不可信的升级报告请求')
    if (action === 'status') return status()
    if (action === 'copy') {
      status()
      clipboard.writeText(migrationReportText(report, context.reportPath))
      return { copied: true }
    }
    if (action === 'open') {
      const error = await shell.openPath(context.reportPath)
      if (error) throw new Error(`无法打开升级报告：${error}`)
      return
    }
    if (action === 'close') { await requestClose(); return }
    throw new Error('无效的升级报告操作')
  })
  await window.loadURL(url)
  window.show()
  window.focus()
  if (process.send) await new Promise((resolve, reject) => process.send({ type: 'migration-progress-ready',
    transactionId: context.transactionId }, error => error ? reject(error) : resolve()))
  if (process.connected) process.disconnect()
}
