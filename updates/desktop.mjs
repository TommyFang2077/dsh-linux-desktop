import { BrowserWindow, ipcMain, dialog, Notification } from 'electron'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { UpdateManager } from './core.mjs'
import { AutomaticUpdates, confirmUpdate } from './automatic.mjs'
import { ensureMarket } from './market.mjs'
import { detectUserDesktop, installUserDesktop } from './user-install.mjs'
import { markWholeDesktopHealthy } from './whole-desktop.mjs'

export { assertWholeDesktopStartupAllowed } from './whole-desktop.mjs'

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
    migration: options.wholeDesktop,
    verifyKernel: options.verifyKernel, probeKernel: options.probeKernel,
    onProgress: message => console.info(`dsh-workbench update: ${message}`),
    extract, signal: extractionLifetime.signal,
  })
  await manager.boot()
  const upgradeFailure = process.env.DSH_WHOLE_DESKTOP_FAILED
  delete process.env.DSH_WHOLE_DESKTOP_FAILED
  if (upgradeFailure) {
    manager.notice = `完整桌面升级未完成，已恢复原版本：${upgradeFailure}`
    dialog.showErrorBox('软件更新', `${manager.notice}\n\n请关闭占用 dsh 数据的其他程序后重试。`)
  }
  const provisioning = new AbortController()
  app.on('before-quit', () => provisioning.abort())
  let window
  let performing = false
  const automatic = new AutomaticUpdates({ manager,
    run: async operation => {
      if (performing) throw new Error('已有更新操作正在进行，稍后重试')
      performing = true
      try { return await operation() } finally { performing = false }
    },
    notify: (channel, release) => {
      manager.notice = `${channel === 'kernel' ? '内核' : '桌面'} ${release.version} 已下载并校验。请打开软件更新，确认后安装并重启；有活动任务时将暂缓。`
      if (Notification.isSupported()) {
        const notification = new Notification({ title: '更新已准备好', body: manager.notice })
        notification.on('click', () => { void open().catch(error => console.error(error)) })
        notification.show()
      }
    },
  })
  app.on('will-quit', () => automatic.stop())
  const status = () => ({ ...manager.status(), busy: performing || manager.busy, automatic: automatic.state })
  const url = pathToFileURL(join(resources, 'updates.html')).href
  const open = async () => {
    if (window && !window.isDestroyed()) { window.show(); window.focus(); return }
    window = new BrowserWindow({ width: 660, height: 810, minWidth: 420, minHeight: 480, show: false,
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
  ipcMain.handle('dsh-workbench:versions', async (event, check = false) => {
    if (!options.trustedSender(event)) throw new Error('拒绝不可信的版本查询')
    if (typeof check !== 'boolean') throw new Error('版本查询参数无效')
    if (!check) return { ...status(), errors: {} }
    if (performing) throw new Error('已有更新操作或确认对话框正在进行')
    performing = true
    const errors = {}
    try {
      for (const channel of ['kernel', 'desktop']) {
        try { await manager.check(channel) } catch (error) { errors[channel] = error.message }
      }
      if (config.desktopUpgrade) {
        try { await manager.checkWholeDesktopUpgrade() } catch (error) { errors.desktopUpgrade = error.message }
      }
      const result = status()
      for (const channel of ['kernel', 'desktop']) {
        if (result[channel].crossEpoch && !(channel === 'kernel' && metadata.followOfficial === true)) delete errors[channel]
      }
      const upgrade = result.desktopUpgrade
      if (upgrade?.available && !result.desktop.available) {
        result.desktop = { ...result.desktop, latest: upgrade.latest, latestLinuxRevision: upgrade.latestLinuxRevision }
      }
      return { ...result, errors }
    } finally { performing = false }
  })
  ipcMain.handle('dsh-workbench:open-updates', async event => {
    if (!options.trustedSender(event)) throw new Error('拒绝不可信的更新窗口请求')
    await open()
  })
  ipcMain.handle('dsh-workbench:updates', async (event, action, channel) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
      || event.senderFrame.url !== url) throw new Error('拒绝不可信的更新操作')
    let ownsOperation = false
    try {
      if (action === 'status') return { status: status() }
      if (performing) throw new Error('已有更新操作或确认对话框正在进行')
      performing = true
      ownsOperation = true
      if (!['kernel', 'desktop', 'desktopUpgrade'].includes(channel)) throw new Error('未知更新通道')
      if (action === 'check') return { status: channel === 'desktopUpgrade'
        ? await manager.checkWholeDesktopUpgrade() : await manager.check(channel) }
      if (action !== 'install') throw new Error('未知更新操作')
      if (manager.busy) throw new Error('已有更新操作正在进行')
      const version = status()[channel].available
      if (!version) throw new Error('请先检查更新')
      const approved = await confirmUpdate({ manager, channel, inspect: options.inspectTasks, confirm: async () => {
        const answer = await dialog.showMessageBox(window, {
          type: 'question', title: '确认更新', message: `更新${channel === 'kernel' ? '内核' : ''}至 ${version}${channel !== 'kernel' ? ` · Linux r${status()[channel].availableLinuxRevision}` : ''}？`,
          detail: channel === 'desktopUpgrade' || (channel === 'kernel' && metadata.followOfficial === true)
          ? `${channel === 'kernel' ? '仅更新内核，保留当前桌面壳。' : ''}请先关闭正在使用 dsh 的命令行。仅在无活动任务时退出，自动备份数据到 ~/Backups/dsh-workbench 后安装新版本并重新打开；新内核启动失败时保留备份，须恢复旧数据后回退。`
          : '更新已下载并校验。安装后应用将重启；有活动任务或无法确认任务状态时将暂缓，不会强制停止任务。',
          buttons: ['取消', '继续'], defaultId: 0, cancelId: 0,
        })
        return answer.response === 1
      } })
      if (!approved) return { status: status() }
      if (channel === 'desktopUpgrade' || (channel === 'kernel' && metadata.followOfficial === true)) {
        const install = channel === 'kernel' ? manager.installKernelMigration.bind(manager) : manager.installWholeDesktopUpgrade.bind(manager)
        await install({
          ...options.wholeDesktop, root: userDesktop?.root ?? join(options.wholeDesktop.home, 'Applications/dsh-linux-desktop'),
        }, { prepareRestart: options.prepareRestart, recover: options.recover,
          quitWithoutRelaunch: options.quitWithoutRelaunch })
        return { status: status() }
      }
      try {
        let installed
        if (channel === 'kernel') installed = await manager.installKernel(options.prepareRestart, options.restart)
        else installed = await manager.installDesktop(options.prepareRestart, artifact => installUserDesktop({
          ...artifact, ...(userDesktop ? { root: userDesktop.root } : {}),
          extract: (archive, destination) => extract(archive, destination, 'desktop'),
        }), options.restart)
        if (installed) options.finishRestart()
      } catch (error) {
        await options.recover()
        throw error
      }
      return { status: status() }
    } catch (error) { return { status: status(), error: error.message } }
    finally { if (ownsOperation) performing = false }
  })
  return {
    get selected() { return manager.selected },
    markHealthy: async () => {
      await markWholeDesktopHealthy({ home: options.wholeDesktop.home, version: app.getVersion(),
        executable: process.execPath, pid: process.pid, kernel: manager.selected })
      await manager.markHealthy()
      automatic.start()
    },
    rollback: () => manager.rollback(),
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
