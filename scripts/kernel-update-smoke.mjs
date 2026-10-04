/** Exercise a signed local kernel upgrade through the packaged UI; all data and keys are disposable. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { createReadStream } from 'node:fs'
import * as fs from 'node:fs/promises'
import { createServer } from 'node:https'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { fileHash, inventory } from '../build/update-core.mjs'
import { writeDesktopRuntime } from '../build/upstream/apps/desktop/lib/types/runtime-tree.js'

const root = resolve(import.meta.dirname, '..')
const require = createRequire(join(root, 'build/upstream/package.json'))
const semver = require('semver')
const tar = require('tar')
const { _electron } = require(require.resolve('playwright-core', { paths: [join(root, 'build/upstream/node_modules/.pnpm/node_modules')] }))
const temporary = await fs.mkdtemp('/tmp/dsh-kernel-upgrade-smoke-')
const desktop = JSON.parse(await fs.readFile(join(root, 'desktop.json'), 'utf8'))
const executable = process.env.DSH_WORKBENCH_TEST_APP ?? join(temporary, 'application/opt/dsh-workbench/dsh-workbench')
let application, server
async function windowAt(ending) {
  for (let attempt = 0; attempt < 1200; attempt++) {
    const page = application.windows().find(item => item.url().endsWith(ending))
    if (page) return page
    await setTimeout(100)
  }
  throw new Error(`Window did not load: ${ending}`)
}
try {
  if (!process.env.DSH_WORKBENCH_TEST_APP) execFileSync('dpkg-deb', ['--extract', join(root, `dist/dsh-workbench-${desktop.version}-x64.deb`), join(temporary, 'application')])
  const resources = join(dirname(executable), 'resources')
  console.log('Preparing isolated kernel fixture')
  const candidate = join(temporary, 'candidate')
  await fs.mkdir(candidate)
  await fs.cp(join(resources, 'app/dsh'), join(candidate, 'dsh'), { recursive: true })
  await fs.cp(join(resources, 'runtime'), join(candidate, 'runtime'), { recursive: true })
  const descriptorPath = join(candidate, 'dsh/desktop-runtime.json')
  const descriptor = JSON.parse(await fs.readFile(descriptorPath, 'utf8'))
  const version = semver.inc(descriptor.release.version, 'prerelease')
  for (const relative of ['package.json', 'node_modules/@deepseek-ai/dsh/package.json', 'node_modules/@deepseek-ai/dsh-desktop-host/package.json']) {
    const path = join(candidate, 'dsh', relative)
    const manifest = JSON.parse(await fs.readFile(path, 'utf8'))
    manifest.version = version
    await fs.writeFile(path, JSON.stringify(manifest) + '\n')
  }
  // Only fixture identity changes; this is not presented as a genuine upstream release.
  writeDesktopRuntime(join(candidate, 'dsh'), { ...descriptor.release, version }, descriptor.sharedPackages.map(item => item.name), { platform: 'linux', arch: 'x64' })
  const manifest = Buffer.from(JSON.stringify({ ...desktop, version, files: await inventory(candidate) }) + '\n')
  await fs.writeFile(join(candidate, 'kernel.json'), manifest)
  const archive = join(temporary, 'kernel.tgz')
  await tar.c({ gzip: { level: 1 }, file: archive, cwd: candidate, portable: true, noMtime: true }, ['kernel.json', 'dsh', 'runtime'])
  const tlsKey = join(temporary, 'tls.key'), certificate = join(temporary, 'tls.crt')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost', '-keyout', tlsKey, '-out', certificate], { stdio: 'ignore' })
  let envelope
  server = createServer({ key: await fs.readFile(tlsKey), cert: await fs.readFile(certificate) }, (request, response) => {
    if (request.url === '/kernel.json') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(envelope)) }
    else if (request.url === '/kernel.tgz') createReadStream(archive).pipe(response)
    else { response.statusCode = 404; response.end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `https://127.0.0.1:${server.address().port}`
  const keys = generateKeyPairSync('ed25519')
  const payload = Buffer.from(JSON.stringify({ schemaVersion: 1, channel: 'kernel', platform: 'linux', arch: 'x64',
    ...desktop, version, manifestSha256: createHash('sha256').update(manifest).digest('hex'),
    asset: { url: `${origin}/kernel.tgz`, size: (await fs.stat(archive)).size, sha256: await fileHash(archive) },
  }))
  envelope = { payload: payload.toString('base64'), signature: sign(null, payload, keys.privateKey).toString('base64') }
  const config = join(temporary, 'updates.json')
  await fs.writeFile(config, JSON.stringify({ desktop: null, kernel: { url: `${origin}/kernel.json`, publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }) } }))
  const environment = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/iu.test(key))),
    HOME: temporary, DSH_HOME: join(temporary, 'dsh'), XDG_CONFIG_HOME: join(temporary, 'config'),
    XDG_DATA_HOME: join(temporary, 'data'), XDG_CACHE_HOME: join(temporary, 'cache'),
    DSH_WORKBENCH_UPDATE_CONFIG: config, NODE_EXTRA_CA_CERTS: certificate,
  }
  const launch = () => _electron.launch({ executablePath: executable, chromiumSandbox: true, env: environment, timeout: 120_000 })
  async function enter() {
    const welcome = await windowAt('/welcome.html')
    await welcome.getByRole('button', { name: /Add API Key|添加 API Key/ }).click()
    await welcome.getByRole('button', { name: /Set up later|稍后配置/ }).click()
    const page = await windowAt('dsh-app://app/')
    await page.getByText(/^(新会话|New (?:chat|session|conversation))$/i).waitFor({ state: 'visible', timeout: 60_000 })
    await page.evaluate(() => window.dshDesktop.openWorkbenchUpdates())
    return windowAt('/workbench/updates.html')
  }
  console.log('Kernel fixture signed; launching packaged desktop')
  application = await launch()
  application.process().stderr.on('data', bytes => process.stderr.write(bytes))
  application.process().stdout.on('data', bytes => process.stdout.write(bytes))
  application.process().on('exit', (code, signal) => console.log('Desktop process exit:', code, signal))
  const updates = await enter()
  const checked = await updates.evaluate(() => window.workbenchUpdates.invoke('check', 'kernel'))
  assert.equal(checked.error, undefined)
  assert.equal(checked.status.kernel.available, version)
  console.log('Signed HTTPS feed accepted; downloading and probing candidate')
  const data = await application.evaluate(({ app, dialog }) => {
    // Mock only human confirmation and relaunch: restart is driven by this test after a clean exit.
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
    app.relaunch = () => {}
    return app.getPath('userData')
  })
  let operationResult
  const updateOperation = updates.evaluate(() => window.workbenchUpdates.invoke('install', 'kernel'))
    .catch(error => ({ closed: true, message: error.message }))
    .then(result => { operationResult = result; return result })
  let confirmation
  for (let attempt = 0; attempt < 1800 && !confirmation; attempt++) {
    if (operationResult?.error) throw new Error(operationResult.error)
    if (operationResult?.closed) throw new Error(`Application closed before confirmation: ${operationResult.message}`)
    for (const page of application.windows()) {
      if (page === updates) continue
      const button = page.getByRole('button', { name: /^(安装并重启|Install and Restart)$/ })
      if (await button.isVisible().catch(() => false)) { confirmation = button; break }
    }
    if (!confirmation) await setTimeout(100)
  }
  assert.ok(confirmation, 'Candidate must pass the real isolated Host probe before asking to restart')
  const exited = application.waitForEvent('close')
  await confirmation.click()
  await Promise.race([exited, setTimeout(60_000, undefined, { ref: false }).then(() => { throw new Error('Updater did not exit after clean stop') })])
  await updateOperation
  application = undefined
  const statePath = join(data, 'updates/state.json')
  assert.equal(JSON.parse(await fs.readFile(statePath, 'utf8')).pending, 'staged')
  application = await launch()
  const after = await enter()
  const selected = await after.evaluate(() => window.workbenchUpdates.invoke('status'))
  assert.equal(selected.status.kernel.version, version)
  assert.equal(selected.status.desktop.version, desktop.version)
  assert.equal(JSON.parse(await fs.readFile(statePath, 'utf8')).pending, null)
  await after.screenshot({ path: join(root, 'build/kernel-update-smoke.png') })
  console.log(`Real signed kernel update passed: ${descriptor.release.version} → ${version}; desktop stays ${desktop.version}; all keys/data were temporary`)
} catch (error) {
  if (application) for (const page of application.windows()) {
    console.error('Window:', page.url().slice(0, 120), await page.locator('body').innerText().catch(() => '<unavailable>'))
    await page.screenshot({ path: join(root, 'build/kernel-update-failure.png') }).catch(() => undefined)
  }
  throw error
} finally {
  if (application) await application.close()
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  await fs.rm(temporary, { recursive: true, force: true })
}
