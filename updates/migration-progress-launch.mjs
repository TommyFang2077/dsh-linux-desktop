import * as fs from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { migrationProgressContext } from './migration-report.mjs'
import { processIdentity } from './migration-processes.mjs'

/** Require a visible, isolated viewer before allowing the original desktop to exit. */
export async function openMigrationProgress(transactionPath) {
  const context = migrationProgressContext(transactionPath)
  const log = await fs.open(join(dirname(transactionPath), 'progress.log'), 'a', 0o600)
  let child
  try {
    child = spawn(process.execPath, ['--dsh-migration-progress', transactionPath], {
      detached: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined,
        DSH_WHOLE_DESKTOP_TRANSACTION: undefined, DSH_WHOLE_DESKTOP_FAILED: undefined },
      stdio: ['ignore', log.fd, log.fd, 'ipc'],
    })
    let timer
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('升级进度窗口未能启动；升级已中止，原程序保持运行。')), 15_000)
      child.once('error', reject)
      child.once('exit', code => reject(new Error(`升级进度窗口提前退出：${code}`)))
      child.on('message', message => {
        if (message?.type === 'migration-progress-ready' && message.transactionId === context.transactionId) resolve()
      })
    }).finally(() => clearTimeout(timer))
    const identity = await processIdentity(child.pid)
    child.unref()
    child.channel?.unref()
    return identity
  } catch (error) { child?.kill(); throw error }
  finally { await log.close() }
}
