import { execFileSync } from 'node:child_process'
import { createPrivateKey, createPublicKey, createHash, sign } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import * as tar from 'tar'
import { extractDesktop, fileHash, httpsUrl, inventory, verifyFeed } from '../updates/core.mjs'
import { verifyUserDesktop } from '../updates/user-install.mjs'

const root = resolve(import.meta.dirname, '..')
const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  input: { type: 'string' }, output: { type: 'string' }, key: { type: 'string' },
  'base-url': { type: 'string' }, archive: { type: 'string' },
  metadata: { type: 'string' }, deb: { type: 'string' }, rpm: { type: 'string' },
} })
const channel = positionals[0]
if (!['kernel', 'desktop'].includes(channel) || !values.key || !values.output || !values['base-url']) {
  throw new Error('Usage: node build/release-updates.mjs kernel|desktop --key /secure/key.pem --base-url https://host/releases/ --output directory [--input prepared-kernel] [--archive desktop.tar.gz --deb desktop.deb --rpm desktop.rpm] [--metadata desktop.json]')
}
const keyPath = resolve(values.key)
const keyStat = await fs.stat(keyPath)
if (keyStat.mode & 0o077) throw new Error('Signing private key must have owner-only permissions (0600)')
const key = createPrivateKey(await fs.readFile(keyPath))
if (key.asymmetricKeyType !== 'ed25519') throw new Error('Use an Ed25519 signing key')
const metadata = JSON.parse(await fs.readFile(values.metadata ?? join(root, 'desktop.json'), 'utf8'))
const output = resolve(values.output)
await fs.mkdir(output, { recursive: true })
const base = httpsUrl(values['base-url'].replace(/\/?$/, '/'))
async function asset(path) {
  return { url: new URL(encodeURIComponent(basename(path)), base).href,
    size: (await fs.stat(path)).size, sha256: await fileHash(path) }
}
let release = { ...metadata, schemaVersion: channel === 'kernel' ? 1 : 2, channel, platform: 'linux', arch: 'x64' }
if (channel === 'kernel') {
  if (!values.input) throw new Error('Kernel input must contain prepared dsh/ and runtime/')
  const input = resolve(values.input)
  const descriptor = JSON.parse(await fs.readFile(join(input, 'dsh/desktop-runtime.json'), 'utf8'))
  release.version = descriptor.release.version
  release.protocol = descriptor.release.hostProtocolVersion
  const staging = await fs.mkdtemp('/tmp/dsh-kernel-release-')
  try {
    for (const directory of ['dsh', 'runtime']) await fs.cp(join(input, directory), join(staging, directory), { recursive: true })
    const files = await inventory(staging)
    for (const file of files) await fs.chmod(join(staging, file.path), file.executable ? 0o755 : 0o644)
    const manifest = Buffer.from(JSON.stringify({ ...release, files }) + '\n')
    await fs.writeFile(join(staging, 'kernel.json'), manifest, { flag: 'wx', mode: 0o644 })
    const archive = join(output, `dsh-kernel-${release.version}-linux-x64.tgz`)
    const handle = await fs.open(archive, 'wx', 0o644)
    await handle.close()
    await tar.c({ gzip: { level: 1 }, file: archive, cwd: staging, portable: true, noMtime: true }, ['kernel.json', 'dsh', 'runtime'])
    release = { ...release, asset: await asset(archive), manifestSha256: createHash('sha256').update(manifest).digest('hex') }
  } finally { await fs.rm(staging, { recursive: true, force: true }) }
} else {
  if (!values.archive || !values.deb || !values.rpm || !metadata.kernelRange || !metadata.nodeVersion) {
    throw new Error('Desktop feed requires --archive, --deb, --rpm and desktop kernelRange/nodeVersion metadata')
  }
  const expected = metadata.version.replaceAll('-', '~')
  const deb = ['Package', 'Version', 'Architecture'].map(field => execFileSync('dpkg-deb', ['--field', resolve(values.deb), field], { encoding: 'utf8' }).trim())
  const rpm = execFileSync('rpm', ['-qp', '--queryformat', '%{NAME}\\n%{VERSION}\\n%{RELEASE}\\n%{ARCH}', resolve(values.rpm)], { encoding: 'utf8' }).trim().split('\n')
  if (JSON.stringify(deb) !== JSON.stringify(['dsh-workbench', `${expected}-${metadata.linuxRevision}`, 'amd64'])
    || JSON.stringify(rpm) !== JSON.stringify(['dsh-workbench', expected, String(metadata.linuxRevision), 'x86_64'])) {
    throw new Error('Installer identity/version/revision/architecture differs from signing metadata')
  }
  const installers = { deb: await asset(resolve(values.deb)), rpm: await asset(resolve(values.rpm)) }
  const staging = await fs.mkdtemp('/tmp/dsh-desktop-signing-')
  try {
    await extractDesktop(resolve(values.archive), staging)
    const actual = await verifyUserDesktop(join(staging, 'app'), metadata.version)
    if (JSON.stringify(actual) !== JSON.stringify(metadata)) throw new Error('Desktop archive metadata differs from signing metadata')
    release = { ...release, format: 'tar.gz', asset: await asset(resolve(values.archive)), assets: installers }
  } finally { await fs.rm(staging, { recursive: true, force: true }) }
}
const payload = Buffer.from(JSON.stringify(release))
const envelope = { payload: payload.toString('base64'), signature: sign(null, payload, key).toString('base64') }
verifyFeed(envelope, createPublicKey(key).export({ type: 'spki', format: 'pem' }), channel)
const destination = join(output, `${channel}-latest.json`)
await fs.writeFile(destination, JSON.stringify(envelope) + '\n', { flag: 'wx', mode: 0o644 })
console.log(`Signed ${channel} ${release.version}: ${destination}; no files were uploaded`)
