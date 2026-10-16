import assert from 'node:assert/strict'
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { readFile, writeFile, readdir, lstat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { releaseFeedNames } from './build-bridge.mjs'

export async function signRelease({ directory, metadata, config, key, repository, tag }) {
  assert.match(repository, /^[A-Za-z0-9_.-]+[/][A-Za-z0-9_.-]+$/)
  assert.equal(tag, `workbench-v${metadata.version}-r${metadata.linuxRevision}`)
  const privateKey = createPrivateKey(key)
  assert.equal(privateKey.asymmetricKeyType, 'ed25519')
  const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
  for (const channel of ['kernel', 'desktop', 'desktopUpgrade']) {
    assert.deepEqual(createPublicKey(config[channel].publicKey).export({ type: 'spki', format: 'der' }), publicKey)
  }
  const files = new Map()
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name)
      const stat = await lstat(full)
      assert.ok(!stat.isSymbolicLink(), 'Release artifacts must not contain symlinks')
      if (stat.isDirectory()) await walk(full)
      else {
        assert.ok(stat.isFile() && !files.has(entry.name), 'Duplicate or special artifact')
        files.set(entry.name, full)
      }
    }
  }
  await walk(directory)
  const base = `https://github.com/${repository}/releases/download/${tag}/`
  async function verifyAsset(asset) {
    assert.ok(asset && typeof asset.url === 'string')
    const url = new URL(asset.url)
    const name = decodeURIComponent(url.pathname.split('/').at(-1))
    assert.equal(asset.url, base + encodeURIComponent(name), 'Asset URL must match immutable release')
    assert.equal(basename(name), name)
    assert.ok(files.has(name), 'Referenced asset missing')
    const bytes = await readFile(files.get(name))
    assert.equal(bytes.length, asset.size)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256)
  }
  const pending = []
  const names = releaseFeedNames(metadata)
  for (const channel of ['kernel', 'desktop']) {
    const path = files.get(names[channel])
    assert.ok(path, 'Expected feed missing')
    const envelope = JSON.parse(await readFile(path, 'utf8'))
    const payload = Buffer.from(envelope.payload, 'base64')
    assert.equal(payload.toString('base64'), envelope.payload)
    const release = JSON.parse(payload)
    for (const [name, value] of Object.entries(metadata)) assert.deepEqual(release[name], value, `Metadata mismatch: ${name}`)
    assert.equal(release.channel, channel)
    assert.equal(release.schemaVersion, channel === 'kernel' ? 1 : 2)
    assert.equal(release.platform, 'linux')
    assert.equal(release.arch, 'x64')
    assert.equal(config[channel].url, `https://raw.githubusercontent.com/${repository}/update-feed/${names[channel]}`)
    await verifyAsset(release.asset)
    if (channel === 'desktop') {
      assert.equal(release.format, 'tar.gz')
      await verifyAsset(release.assets?.deb)
      await verifyAsset(release.assets?.rpm)
    } else assert.match(release.manifestSha256, /^[0-9a-f]{64}$/)
    pending.push([path, JSON.stringify({ payload: envelope.payload, signature: sign(null, payload, privateKey).toString('base64') }) + '\n'])
  }
  for (const [path, content] of pending) await writeFile(path, content)
}

function compareVersion(a, b) {
  const parse = value => {
    const match = /^(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)(?:-([0-9A-Za-z.-]+))?$/.exec(value)
    assert.ok(match, 'Invalid release version')
    return [match.slice(1, 4).map(BigInt), match[4]?.split('.') || []]
  }
  const [ac, ap] = parse(a), [bc, bp] = parse(b)
  for (let i = 0; i < 3; i++) if (ac[i] !== bc[i]) return ac[i] > bc[i] ? 1 : -1
  if (!ap.length || !bp.length) return Number(!ap.length) - Number(!bp.length)
  for (let i = 0; i < Math.min(ap.length, bp.length); i++) {
    const x = ap[i], y = bp[i]
    if (x === y) continue
    const xn = /^[0-9]+$/.test(x), yn = /^[0-9]+$/.test(y)
    if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1
    if (xn !== yn) return xn ? -1 : 1
    return x > y ? 1 : -1
  }
  return ap.length - bp.length
}

export async function checkFeedPromotion({ directory, current, metadata, config }) {
  const names = releaseFeedNames(metadata)
  for (const channel of ['kernel', 'desktop']) {
    const read = async path => {
      const envelope = JSON.parse(await readFile(path, 'utf8'))
      const bytes = Buffer.from(envelope.payload, 'base64')
      assert.ok(verify(null, bytes, config[channel].publicKey, Buffer.from(envelope.signature, 'base64')), 'Feed signature mismatch')
      const payload = JSON.parse(bytes)
      assert.equal(payload.channel, channel)
      return { envelope, payload }
    }
    const next = await read(join(directory, channel + '-release', names[channel]))
    let previous
    try { previous = await read(join(current, names[channel])) }
    catch (error) { if (error.code === 'ENOENT') continue; throw error }
    if (next.envelope.payload === previous.envelope.payload) continue
    assert.equal(next.payload.dataEpoch, previous.payload.dataEpoch)
    assert.equal(next.payload.protocol, previous.payload.protocol)
    assert.ok(compareVersion(next.payload.version, previous.payload.version) >= 0, 'Refusing feed version downgrade')
    assert.ok(next.payload.linuxRevision > previous.payload.linuxRevision, 'Refusing stale or conflicting feed revision')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const json = async path => JSON.parse(await readFile(path, 'utf8'))
  const metadata = await json('desktop.json'), config = await json('updates.json')
  if (process.argv[2] === '--check-promotion') {
    await checkFeedPromotion({ directory: process.argv[3], current: process.argv[4], metadata, config })
  } else {
    await signRelease({ directory: process.argv[2], metadata, config,
      key: process.env.UPDATE_SIGNING_KEY, repository: process.env.GITHUB_REPOSITORY, tag: process.env.RELEASE_TAG })
  }
}
