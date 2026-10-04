import { BrowserWindow, ipcMain, dialog } from 'electron'
import { execFile, spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { UpdateManager } from './core.mjs'
import { ensureMarket } from './market.mjs'

const execute = promisify(execFile)

function authorizeInstall(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/pkexec', args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', DISPLAY: process.env.DISPLAY ?? '',
        XAUTHORITY: process.env.XAUTHORITY ?? '', LANG: process.env.LANG ?? 'C.UTF-8' },
    })
    let diagnostic = ''
    child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes.toString()).slice(-16_384) })
    child.once('error', reject)
    // Never time out or kill a package manager halfway through a privileged transaction.
    child.once('close', (code, signal) => code === 0 ? resolve()
      : reject(new Error(`系统授权或安装失败 (${code ?? signal})：${diagnostic}`)))
  })
}

async function installedFormat() {
  for (const [format, command, args] of [
    ['deb', '/usr/bin/dpkg-query', ['-W', '-f=${db:Status-Status}', 'dsh-workbench']],
    ['rpm', '/usr/bin/rpm', ['-q', '--queryformat', '%{NAME}', 'dsh-workbench']],
  ]) {
    try {
      const { stdout } = await execute(command, args, { timeout: 10_000 })
      if ((format === 'deb' && stdout.trim() === 'installed') || (format === 'rpm' && stdout.trim() === 'dsh-workbench')) return format
    } catch (error) { if (error.code !== 'ENOENT' && error.code !== 1) throw error }
  }
  throw new Error('当前不是系统安装版；请先手动安装 deb/rpm，再使用桌面更新')
}

/** Called once, before main selects dsh, WebUI and its support-runtime paths. */
export async function createWorkbenchUpdates(options) {
  const { app } = options
  const resources = join(app.getAppPath(), 'workbench')
  const metadata = JSON.parse(await fs.readFile(join(resources, 'desktop.json'), 'utf8'))
  const config = JSON.parse(await fs.readFile(process.env.DSH_WORKBENCH_UPDATE_CONFIG ?? join(resources, 'updates.json'), 'utf8'))
  const descriptor = JSON.parse(await fs.readFile(join(options.bundled.dsh, 'desktop-runtime.json'), 'utf8'))
  const extractionLifetime = new AbortController()
  app.on('will-quit', () => extractionLifetime.abort())
  const manager = new UpdateManager({
    root: join(app.getPath('userData'), 'updates'), config,
    desktop: { ...metadata, version: app.getVersion(), nodeVersion: process.versions.node },
    bundled: { ...metadata, ...options.bundled, version: descriptor.release.version,
      protocol: descriptor.release.hostProtocolVersion },
    verifyKernel: options.verifyKernel, probeKernel: options.probeKernel,
    onProgress: message => console.info(`dsh-workbench update: ${message}`),
    extract: async (archive, destination) => {
      await execute(process.execPath, ['--max-old-space-size=256',
        join(app.getAppPath(), 'lib/workbench-archive.mjs'), archive, destination], {
        env: { PATH: '/usr/bin:/bin', ELECTRON_RUN_AS_NODE: '1' },
        timeout: 180_000, maxBuffer: 256 * 1024, signal: extractionLifetime.signal,
      })
    },
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
        type: 'question', title: '确认更新', message: `更新${channel === 'kernel' ? '内核' : '桌面端'}至 ${version}？`,
        detail: channel === 'kernel'
          ? '下载并校验完整内核，在隔离目录试启动；确认停止当前任务后重启应用。不会安装桌面软件包。'
          : '下载并校验桌面软件包，停止当前任务后通过系统授权弹窗安装。不会替换用户目录中的兼容新内核。',
        buttons: ['取消', '继续'], defaultId: 0, cancelId: 0,
      })
      if (answer.response !== 1) return { status: manager.status() }
      try {
        if (channel === 'kernel') await manager.installKernel(options.prepareRestart, options.restart)
        else {
          const format = await installedFormat()
          await manager.installDesktop(format, options.prepareRestart, async artifact => {
            const helper = await fs.realpath(join(resources, 'install.py'))
            const stat = await fs.stat(helper)
            if (!helper.startsWith('/opt/dsh-workbench/') || stat.uid !== 0 || (stat.mode & 0o022)) {
              throw new Error('提权安装器必须来自 root 所有、不可写的系统安装目录')
            }
            await authorizeInstall(['/usr/bin/python3', '-I', helper, artifact.path, artifact.format,
              artifact.version, artifact.sha256, String(artifact.size)])
          }, options.restart)
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
