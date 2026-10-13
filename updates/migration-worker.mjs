import { runWholeDesktopMigration, verifyWholeDesktopBackup, restoreWholeDesktopBackup } from './whole-desktop.mjs'

try {
  const [operation, transaction, destination] = process.argv.slice(2)
  if (operation === 'run' && process.argv.length === 4) await runWholeDesktopMigration(transaction)
  else if (operation === 'verify' && process.argv.length === 4) console.log(JSON.stringify(await verifyWholeDesktopBackup(transaction)))
  else if (operation === 'restore' && process.argv.length === 5) console.log(JSON.stringify(await restoreWholeDesktopBackup(transaction, destination)))
  else throw new Error('Usage: migration-worker.mjs run|verify TRANSACTION_JSON, or restore TRANSACTION_JSON EMPTY_HOME')
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
