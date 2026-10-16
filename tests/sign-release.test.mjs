import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { checkFeedPromotion, signRelease } from '../scripts/sign-release.mjs'
import { releaseFeedNames } from '../scripts/build-bridge.mjs'

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-isolated-sign-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const metadata = { version: '1.0.1', linuxRevision: 2, protocol: 4, dataEpoch: 'dsh-1.0.0', kernelRange: '>=1.0.0 <1.1.0' }
  const repository = 'owner/repo'
  const tag = 'workbench-v1.0.1-r2'
  const config = Object.fromEntries(['kernel', 'desktop', 'desktopUpgrade'].map(channel => [channel, {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    url: 'https://raw.githubusercontent.com/owner/repo/update-feed/' + (channel === 'kernel' ? 'kernel' : 'desktop') + '-dsh-1.0.0-latest.json',
  }]))
  async function asset(name) {
    const bytes = Buffer.from('data only ' + name)
    await writeFile(join(directory, name), bytes)
    return { url: 'https://github.com/owner/repo/releases/download/' + tag + '/' + name, size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') }
  }
  const kernel = { ...metadata, channel: 'kernel', schemaVersion: 1, platform: 'linux', arch: 'x64',
    manifestSha256: 'a'.repeat(64), asset: await asset('kernel.tgz') }
  const desktop = { ...metadata, channel: 'desktop', schemaVersion: 2, platform: 'linux', arch: 'x64', format: 'tar.gz',
    asset: await asset('desktop.tar.gz'), assets: { deb: await asset('desktop.deb'), rpm: await asset('desktop.rpm') } }
  const names = releaseFeedNames(metadata)
  async function save(channel, data) {
    await writeFile(join(directory, names[channel]), JSON.stringify({ payload: Buffer.from(JSON.stringify(data)).toString('base64'), signature: 'disposable' }))
  }
  await save('kernel', kernel)
  await save('desktop', desktop)
  return { directory, metadata, repository, tag, config, publicKey, kernel, desktop, names, save,
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }
}

test('fresh signer verifies hashes and signs both feeds preserving a reviewed data epoch', async t => {
  const f = await fixture(t)
  await signRelease(f)
  for (const channel of ['kernel', 'desktop']) {
    const envelope = JSON.parse(await readFile(join(f.directory, f.names[channel]), 'utf8'))
    assert.ok(verify(null, Buffer.from(envelope.payload, 'base64'), f.publicKey, Buffer.from(envelope.signature, 'base64')))
  }
})

test('signer refuses altered asset bytes before writing any signatures', async t => {
  const f = await fixture(t)
  await writeFile(join(f.directory, 'desktop.rpm'), 'tampered')
  await assert.rejects(signRelease(f))
  assert.equal(JSON.parse(await readFile(join(f.directory, f.names.kernel), 'utf8')).signature, 'disposable')
})

test('signer rejects wrong keys, untrusted URL, protocol mismatch and missing assets', async t => {
  const f = await fixture(t)
  const wrong = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' })
  await assert.rejects(signRelease({ ...f, key: wrong }))
  const original = structuredClone(f.desktop)
  f.desktop.asset.url = 'https://attacker.test/desktop.tar.gz'
  await f.save('desktop', f.desktop)
  await assert.rejects(signRelease(f), /immutable release/)
  await f.save('desktop', { ...original, protocol: 99 })
  await assert.rejects(signRelease(f), /Metadata mismatch: protocol/)
  await f.save('desktop', original)
  await rm(join(f.directory, 'desktop.deb'))
  await assert.rejects(signRelease(f), /Referenced asset missing/)
})

test('signer rejects symlink artifacts and wrong release tag', async t => {
  const f = await fixture(t)
  await assert.rejects(signRelease({ ...f, tag: 'workbench-v999.0.0-r1' }))
  await symlink('desktop.deb', join(f.directory, 'alias'))
  await assert.rejects(signRelease(f), /symlinks/)
})

test('feed promotion is idempotent but refuses stale versions, revisions and forged signatures', async t => {
  const f = await fixture(t)
  await signRelease(f)
  const current = join(f.directory, 'current')
  await mkdir(current)
  for (const channel of ['kernel', 'desktop']) {
    await mkdir(join(f.directory, channel + '-release'))
    const bytes = await readFile(join(f.directory, f.names[channel]))
    await writeFile(join(current, f.names[channel]), bytes)
    await writeFile(join(f.directory, channel + '-release', f.names[channel]), bytes)
  }
  await checkFeedPromotion({ ...f, current })
  const path = join(f.directory, 'desktop-release', f.names.desktop)
  const original = JSON.parse(await readFile(path, 'utf8'))
  const payload = JSON.parse(Buffer.from(original.payload, 'base64'))
  const save = async changes => {
    const bytes = Buffer.from(JSON.stringify({ ...payload, ...changes }))
    await writeFile(path, JSON.stringify({ payload: bytes.toString('base64'), signature: sign(null, bytes, f.key).toString('base64') }))
  }
  await save({ version: '1.0.0', linuxRevision: 3 })
  await assert.rejects(checkFeedPromotion({ ...f, current }), /downgrade/)
  await save({ version: '1.0.2', linuxRevision: 2 })
  await assert.rejects(checkFeedPromotion({ ...f, current }), /revision/)
  await save({ version: '1.0.2', linuxRevision: 3 })
  await checkFeedPromotion({ ...f, current })
  await writeFile(path, JSON.stringify({ ...original, signature: 'invalid' }))
  await assert.rejects(checkFeedPromotion({ ...f, current }), /signature/)
})
