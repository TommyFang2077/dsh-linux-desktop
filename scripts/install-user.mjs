import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: {
  archive: { type: 'string' }, sha256: { type: 'string' }, version: { type: 'string' },
  root: { type: 'string' }, rollback: { type: 'boolean', default: false },
} })
const usage = 'Usage: node build/install-user.mjs --archive desktop.tar.gz --sha256 <trusted SHA-256> --version <version> [--root directory], or --rollback [--root directory]'
if (values.root === '' || (values.rollback
  ? values.archive !== undefined || values.sha256 !== undefined || values.version !== undefined
  : !values.archive || !values.version || !/^[a-f0-9]{64}$/.test(values.sha256 ?? ''))) throw new Error(usage)

const options = values.root === undefined ? {} : { root: resolve(values.root) }
const { installUserDesktop, rollbackUserDesktop } = await import('../updates/user-install.mjs')
if (values.rollback) {
  const executable = await rollbackUserDesktop(options)
  console.log(`Restored user desktop: ${executable}`)
} else {
  const result = await installUserDesktop({ ...options,
    archive: resolve(values.archive), sha256: values.sha256, version: values.version,
  })
  console.log(`Installed user desktop ${result.version}: ${result.executable}`)
}
