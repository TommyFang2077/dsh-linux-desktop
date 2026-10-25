import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const text = value => typeof value !== 'string' ? undefined : value.slice(0, 16_384)
  .replace(/https?:\/\/[^\s'"<>]+/gi, address => {
    try {
      const url = new URL(address)
      return `${url.protocol}//${url.host}${url.pathname}${url.search ? '?[REDACTED]' : ''}${url.hash ? '#[REDACTED]' : ''}`
    } catch { return '[REDACTED URL]' }
  })
  .replace(/((?:proxy-)?authorization\s*[:=]\s*)[^\r\n,;]+/gi, '$1[REDACTED]')
  .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|token)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]')
  .replace(/\b(Bearer|Basic)\s+[a-z0-9._~+\/-]+=*/gi, '$1 [REDACTED]')
  .replace(/\bsk-[a-z0-9_-]{8,}/gi, '[REDACTED]')
const phases = new Set(['prepared', 'ready', 'waiting-parent', 'stopping-processes', 'backup', 'verifying-backup',
  'backup-verified', 'installing', 'spawned', 'healthy', 'failed', 'cancelled'])

function privateJson(path, maximum) {
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid()
    || (info.mode & 0o077) || info.nlink !== 1 || info.size > maximum) throw new Error('Migration report requires a private user-owned file')
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** Only a private transaction under the current HOME may open this independent viewer. */
export function migrationProgressContext(transactionPath, home = process.env.HOME) {
  if (typeof home !== 'string' || typeof transactionPath !== 'string') throw new Error('Invalid migration transaction path')
  const actualHome = realpathSync(home)
  const directory = dirname(transactionPath)
  const transactionId = directory.slice(directory.lastIndexOf('/') + 1)
  if (resolve(transactionPath) !== transactionPath || actualHome !== resolve(home)
    || !/^[a-f0-9-]{36}$/.test(transactionId)
    || directory !== join(actualHome, 'Backups/dsh-workbench', transactionId)
    || transactionPath !== join(directory, 'transaction.json') || realpathSync(directory) !== directory) {
    throw new Error('Invalid migration transaction directory')
  }
  const info = lstatSync(directory)
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error('Migration transaction directory must be private')
  const transaction = privateJson(transactionPath, 256_000)
  if (transaction.schemaVersion !== 1 || transaction.transactionId !== transactionId
    || transaction.directory !== directory || transaction.home !== actualHome) throw new Error('Migration transaction mismatch')
  return { directory, transactionId, reportPath: join(directory, 'report.json') }
}

export function readMigrationReport(context) {
  const report = privateJson(context.reportPath, 1024 * 1024)
  if (report.schemaVersion !== 1 || report.transactionId !== context.transactionId || !phases.has(report.phase)) {
    throw new Error('Migration report mismatch or invalid phase')
  }
  return report
}

/** Keep credentials, commands, environment and logs out of both the window and clipboard. */
export function publicMigrationReport(report) {
  return {
    schemaVersion: 1, transactionId: text(report.transactionId), phase: text(report.phase),
    updatedAt: text(report.updatedAt), failedPhase: text(report.failedPhase), error: text(report.error), recovery: text(report.recovery),
    fallbackError: text(report.fallbackError), activated: report.activated === true,
    backupVerifiedAt: text(report.backupVerifiedAt), healthyAt: text(report.healthyAt),
    processActions: Array.isArray(report.processActions) ? report.processActions.slice(-100).filter(action => action && typeof action === 'object').map(action => ({
      pid: Number.isSafeInteger(action.pid) ? action.pid : undefined, action: text(action.action), result: text(action.result),
    })) : [],
    events: Array.isArray(report.events) ? report.events.slice(-100).filter(event => event && typeof event === 'object').map(event => ({ phase: text(event.phase), at: text(event.at) })) : [],
  }
}

export function migrationReportText(report, reportPath) {
  return `dsh-workbench 升级报告\n${JSON.stringify({ ...publicMigrationReport(report), reportPath }, null, 2)}`
}
