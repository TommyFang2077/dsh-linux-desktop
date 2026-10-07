import { BrowserWindow, ipcMain, dialog } from 'electron'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { UpdateManager } from './core.mjs'
import { ensureMarket } from './market.mjs'
import { detectUserDesktop, installUserDesktop } from './user-install.mjs'

const execute = promisify(execFile)

/** Called once, before main selects dsh, WebUI and its support-runtime paths. */
export async function createWorkbenchUpdates(options) {
  const { app } = options
  const resources = join(app.getAppPath(), 'workbench')
  const metadata = JSON.parse(await fs.readFile(join(resources, 'desktop.json'), 'utf8'))
  const config = JSON.parse(await fs.readFile(process.env.DSH_WORKBENCH_UPDATE_CONFIG ?? join(resources, 'updates.json'), 'utf8'))
  const descriptor = JSON.parse(await fs.readFile(join(options.bundled.dsh, 'desktop-runtime.json'), 'utf8'))
  const primaryRuntime = JSON.parse(await fs.readFile(join(options.bundled.runtime, 'primary-runtime/runtime.json'), 'utf8'))
  if (typeof primaryRuntime.node !== 'string') throw new Error('桌面内核缺少自带 Node 版本信息')
  const extractionLifetime = new AbortController()
  app.on('will-quit', () => extractionLifetime.abort())
  const userDesktop = await detectUserDesktop(process.execPath)
  const extract = async (archive, destination, layout = 'kernel') => execute(process.execPath, [
    '--max-old-space-size=256', join(app.getAppPath(), 'lib/workbench-archive.mjs'), archive, destination, layout,
  ], { env: { PATH: '/usr/bin:/bin', ELECTRON_RUN_AS_NODE: '1' }, timeout: 180_000,
    maxBuffer: 256 * 1024, signal: extractionLifetime.signal })
  const manager = new UpdateManager({
    root: join(app.getPath('userData'), 'updates'), config,
    desktop: { ...metadata, version: app.getVersion(), nodeVersion: primaryRuntime.node },
    bundled: { ...metadata, ...options.bundled, version: descriptor.release.version,
      protocol: descriptor.release.hostProtocolVersion },
    verifyKernel: options.verifyKernel, probeKernel: options.probeKernel,
    onProgress: message => console.info(`dsh-workbench update: ${message}`),
    extract,
  })
  await manager.boot()
  const provisioning = new AbortController()
  app.on('before-quit', () => provisioning.abort())
  let window
  let performing = false
  const url = pathToFileURL(join(resources, 'updates.html')).href
  const open = async () => {
    if (window && !window.isDestroyed()) { window.show(); window.focus(); return }
    window = new BrowserWindow({ width: 660, height: 610, minWidth: 420, minHeight: 480, show: false,
      title: '软件更新 · dsh-workbench', autoHideMenuBar: true,
      webPreferences: { preload: join(resources, 'preload.cjs'), contextIsolation: true,
        nodeIntegration: false, sandbox: true, webSecurity: true },
    })
    const current = window
    current.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    current.webContents.on('will-navigate', event => event.preventDefault())
    current.on('closed', () => { if (window === current) window = undefined })
    await current.loadURL(url)
    current.show()
  }
  ipcMain.handle('dsh-workbench:open-updates', async event => {
    if (!options.trustedSender(event)) throw new Error('拒绝不可信的更新窗口请求')
    await open()
  })
  ipcMain.handle('dsh-workbench:updates', async (event, action, channel) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
      || event.senderFrame.url !== url) throw new Error('拒绝不可信的更新操作')
    let ownsOperation = false
    try {
      if (action === 'status') return { status: manager.status() }
      if (performing) throw new Error('已有更新操作或确认对话框正在进行')
      performing = true
      ownsOperation = true
      if (!['kernel', 'desktop'].includes(channel)) throw new Error('未知更新通道')
      if (action === 'check') return { status: await manager.check(channel) }
      if (action !== 'install') throw new Error('未知更新操作')
      if (manager.busy) throw new Error('已有更新操作正在进行')
      const version = manager.status()[channel].available
      if (!version) throw new Error('请先检查更新')
      const answer = await dialog.showMessageBox(window, {
        type: 'question', title: '确认更新', message: `更新${channel === 'kernel' ? '内核' : '桌面端'}至 ${version}${channel === 'desktop' ? `（Linux r${manager.status().desktop.availableLinuxRevision}）` : ''}？`,
        detail: channel === 'kernel'
          ? '下载并校验完整内核，在隔离目录试启动；确认停止当前任务后重启应用。不会安装桌面软件包。'
          : '下载并校验完整桌面归档，确认停止任务后切换 HOME 内的用户版本并重启。不需要 sudo，不替换兼容的新内核。',
        buttons: ['取消', '继续'], defaultId: 0, cancelId: 0,
      })
      if (answer.response !== 1) return { status: manager.status() }
      try {
        if (channel === 'kernel') await manager.installKernel(options.prepareRestart, options.restart)
        else {
          if (!userDesktop) throw new Error('请先用用户安装入口将桌面安装到 HOME；解包试运行或旧系统包不调用提权安装器')
          await manager.installDesktop(options.prepareRestart, artifact => installUserDesktop({
            ...artifact, root: userDesktop.root,
            extract: (archive, destination) => extract(archive, destination, 'desktop'),
          }), options.restart)
        }
      } catch (error) {
        await options.recover()
        throw error
      }
      return { status: manager.status() }
    } catch (error) { return { status: manager.status(), error: error.message } }
    finally { if (ownsOperation) performing = false }
  })
  return {
    get selected() { return manager.selected },
    markHealthy: () => manager.markHealthy(), rollback: () => manager.rollback(),
    ensureDefaults: async home => {
      try {
        await ensureMarket({ data: app.getPath('userData'), home, node: process.execPath,
          kernel: manager.selected, cli: join(resources, 'plugin-cli.mjs'), signal: provisioning.signal })
      } catch (error) {
        manager.notice = `默认应用市场未安装完成，可在插件管理中重试：${error.message}`
        console.error(manager.notice)
      }
    },
    open: () => { void open().catch(error => dialog.showErrorBox('软件更新', error.message)) },
  }
}
