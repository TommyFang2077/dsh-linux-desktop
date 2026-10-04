import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { ensureMarket, MARKET_VERSION } from '../updates/market.mjs'

async function fixture(t, manifest = {}) {
  const root = await fs.mkdtemp('/tmp/dsh-market-test-')
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const home = join(root, 'dsh'), data = join(root, 'desktop-data')
  const profile = join(home, 'profiles/desktop')
  await fs.mkdir(profile, { recursive: true })
  await fs.writeFile(join(profile, 'package.json'), JSON.stringify(manifest))
  return { home, data, node: '/bundled/electron', kernel: { dsh: '/selected/dsh' }, profile }
}

test('plugin CLI forwards the explicit support-runtime path rather than guessing beside app/dsh', async t => {
  const f = await fixture(t)
  const dsh = join(f.home, 'resources/app/dsh')
  const runtime = join(f.home, 'resources/runtime')
  const entry = join(dsh, 'node_modules/@deepseek-ai/dsh-desktop-host/lib')
  await fs.mkdir(entry, { recursive: true })
  await fs.writeFile(join(entry, '../package.json'), '{"type":"module"}')
  const record = join(f.home, 'cli-call.json')
  await fs.writeFile(join(entry, 'cli.js'), `import {writeFileSync} from 'node:fs'; export async function runDesktopCli(dsh,runtime) {writeFileSync(${JSON.stringify(record)}, JSON.stringify({dsh,runtime,args:process.argv.slice(2)}))}`)
  execFileSync(process.execPath, [fileURLToPath(new URL('../updates/plugin-cli.mjs', import.meta.url)), dsh, runtime, 'plugin', '--profile', 'desktop', 'add', `dshmarket@${MARKET_VERSION}`])
  const call = JSON.parse(await fs.readFile(record, 'utf8'))
  assert.equal(call.runtime, runtime)
  assert.equal(call.dsh, dsh)
  assert.deepEqual(call.args, ['plugin', '--profile', 'desktop', 'add', `dshmarket@${MARKET_VERSION}`])
})

test('first launch installs the default market once and never resurrects a later removal', async t => {
  const f = await fixture(t)
  let calls = 0
  const install = async options => {
    calls++
    assert.equal(options.kernel.dsh, '/selected/dsh')
    await fs.mkdir(join(f.profile, 'node_modules/dshmarket'), { recursive: true })
    await fs.writeFile(join(f.profile, 'node_modules/dshmarket/package.json'), JSON.stringify({ name: 'dshmarket', version: MARKET_VERSION }))
  }
  assert.equal(await ensureMarket({ ...f, install }), 'installed')
  await fs.rm(join(f.profile, 'node_modules'), { recursive: true })
  assert.equal(await ensureMarket({ ...f, install }), 'already-provisioned')
  assert.equal(calls, 1)
})

test('existing user-selected market versions are never overwritten or downgraded', async t => {
  const f = await fixture(t, { dependencies: { dshmarket: '99.0.0' } })
  const install = async () => assert.fail('must preserve user-managed plugin')
  assert.equal(await ensureMarket({ ...f, install }), 'user-managed')
  await fs.writeFile(join(f.profile, 'package.json'), '{}')
  assert.equal(await ensureMarket({ ...f, install }), 'already-provisioned')
})

test('failed or incomplete plugin-manager installs do not write the success marker', async t => {
  const f = await fixture(t)
  await assert.rejects(ensureMarket({ ...f, install: async () => { throw new Error('incompatible') } }), /incompatible/)
  await assert.rejects(fs.stat(join(f.data, 'default-market.json')), { code: 'ENOENT' })
  await assert.rejects(ensureMarket({ ...f, install: async () => {} }), { code: 'ENOENT' })
  await assert.rejects(fs.stat(join(f.data, 'default-market.json')), { code: 'ENOENT' })
})
