import { spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'

export const MARKET_PACKAGE = 'dshmarket'
export const MARKET_VERSION = '1.66.8'

/** Invoke only the official plugin manager; never grant an incompatible-version exemption. */
export function installMarket({ node, kernel, home, cli, signal }) {
  return new Promise((resolve, reject) => {
    const child = spawn(node, ['--expose-internals', cli, kernel.dsh, kernel.runtime,
      'plugin', '--profile', 'desktop', 'add', `${MARKET_PACKAGE}@${MARKET_VERSION}`,
    ], {
      cwd: home, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/iu.test(key))),
        ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home },
    })
    let output = '', aborted = false, killTimer
    const append = bytes => { output = (output + bytes.toString()).slice(-16_384) }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    const terminate = () => {
      aborted = true
      if (!child.pid) return
      try { process.kill(-child.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') reject(error) }
      killTimer = setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') reject(error) }
      }, 5000)
      killTimer.unref()
    }
    const timer = setTimeout(terminate, 180_000)
    signal?.addEventListener('abort', terminate, { once: true })
    if (signal?.aborted) terminate()
    child.once('error', reject)
    child.once('close', code => {
      clearTimeout(timer)
      clearTimeout(killTimer)
      signal?.removeEventListener('abort', terminate)
      if (code === 0 && !aborted) resolve()
      else reject(new Error(`应用市场安装${aborted ? '已取消或超时' : '失败'}：${output}`))
    })
  })
}

/** Default once per user; preserve upgrades, user-managed manifests and deliberate later removal. */
export async function ensureMarket({ data, home, node, kernel, cli, signal, install = installMarket }) {
  const marker = join(data, 'default-market.json')
  try { await fs.access(marker); return 'already-provisioned' } catch (error) { if (error.code !== 'ENOENT') throw error }
  const profile = join(home, 'profiles/desktop')
  const manifest = JSON.parse(await fs.readFile(join(profile, 'package.json'), 'utf8'))
  const declared = Object.hasOwn(manifest.dependencies ?? {}, MARKET_PACKAGE)
  if (declared) {
    await fs.mkdir(data, { recursive: true, mode: 0o700 })
    await fs.writeFile(marker, JSON.stringify({ name: MARKET_PACKAGE, managedByUser: true }) + '\n', { flag: 'wx', mode: 0o600 })
    return 'user-managed'
  }
  await install({ node, kernel, home, cli, signal })
  const installed = JSON.parse(await fs.readFile(join(profile, 'node_modules/dshmarket/package.json'), 'utf8'))
  if (installed.name !== MARKET_PACKAGE || typeof installed.version !== 'string') throw new Error('应用市场未完成安装')
  await fs.mkdir(data, { recursive: true, mode: 0o700 })
  await fs.writeFile(marker, JSON.stringify({ name: installed.name, version: installed.version }) + '\n', { flag: 'wx', mode: 0o600 })
  return 'installed'
}
