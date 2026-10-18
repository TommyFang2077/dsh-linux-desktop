/** Exercise a signed local kernel upgrade through the packaged UI; all data and keys are disposable. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { once } from 'node:events'
import { createReadStream } from 'node:fs'
import * as fs from 'node:fs/promises'
import { createServer } from 'node:https'
import { createServer as createHttpServer } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { extractKernel, fileHash, inventory, verifyKernelTree } from '../build/update-core.mjs'
import { installUserDesktop } from '../build/user-install.mjs'
import { writeDesktopRuntime } from '../build/upstream/apps/desktop/lib/types/runtime-tree.js'

async function waitForUpdateIdle(page, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await page.evaluate(() => window.workbenchUpdates.invoke('status'))
    assert.equal(result.error, undefined)
    assert.equal(typeof result.status?.busy, 'boolean', 'Main must report a known busy state')
    if (!result.status.busy && !await page.locator('[data-action="check"]').isDisabled()) return result
    await setTimeout(100)
  }
  throw new Error('Update operations did not become idle within ' + timeoutMs + 'ms')
}

function holdUpdateConfirmation({ app, dialog }) {
  const state = globalThis.__workbenchSmokeConfirmation = { calls: 0, relaunches: 0, settled: false, options: null }
  dialog.showMessageBox = (_window, options) => {
    state.calls++
    if (state.calls !== 1) throw new Error('Unexpected repeated update confirmation')
    state.options = options
    return new Promise(resolve => {
      state.respond = response => {
        if (state.settled || ![0, 1].includes(response)) throw new Error('Confirmation must be explicit and occur once')
        state.settled = true
        resolve({ response, checkboxChecked: false })
      }
    })
  }
  app.relaunch = () => { state.relaunches++ }
  return app.getPath('userData')
}

async function until(check, message, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await setTimeout(100)
  }
  throw new Error(message)
}

async function verifyBackupRoot(root, entries) {
  if (entries === null) {
    await assert.rejects(fs.lstat(root), { code: 'ENOENT' })
    return
  }
  const seen = []
  async function walk(path, relative = '') {
    const info = await fs.lstat(path)
    const expected = entries.find(entry => entry.path === relative)
    assert.ok(expected, `Unexpected backup entry: ${relative}`)
    seen.push(relative)
    assert.equal(info.mode & 0o777, expected.mode)
    if (expected.type === 'directory') {
      assert.ok(info.isDirectory() && !info.isSymbolicLink())
      for (const child of await fs.readdir(path)) await walk(join(path, child), relative ? `${relative}/${child}` : child)
    } else if (expected.type === 'link') {
      assert.ok(info.isSymbolicLink())
      assert.equal(await fs.readlink(path), expected.target)
    } else {
      assert.ok(info.isFile())
      assert.equal(info.size, expected.size)
      assert.equal(await fileHash(path), expected.sha256)
    }
  }
  await walk(root)
  assert.deepEqual(seen.sort(), entries.map(entry => entry.path).sort())
}

async function attachOwnedInspector(pid, executable) {
  assert.equal(await fs.realpath(`/proc/${pid}/exe`), executable)
  const birth = (await fs.readFile(`/proc/${pid}/stat`, 'utf8')).split(') ')[1].split(' ')[19]
  process.kill(pid, 'SIGUSR1')
  const target = await until(async () => {
    try {
      const response = await fetch('http://127.0.0.1:9229/json/list', { signal: AbortSignal.timeout(500) })
      return (await response.json()).find(item => item.title === `${executable}[${pid}]`)
    } catch { return false }
  }, 'The restarted old shell inspector did not become reachable', 5_000)
  assert.equal((await fs.readFile(`/proc/${pid}/stat`, 'utf8')).split(') ')[1].split(' ')[19], birth)
  const address = new URL(target.webSocketDebuggerUrl)
  assert.equal(address.hostname, '127.0.0.1')
  assert.equal(address.port, '9229')
  const socket = new WebSocket(address)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  let next = 0
  const pending = new Map()
  socket.addEventListener('message', event => { const packet = JSON.parse(event.data); pending.get(packet.id)?.(packet) })
  const evaluate = async expression => {
    const packet = await new Promise((resolve, reject) => {
      const id = ++next
      const timer = globalThis.setTimeout(() => { pending.delete(id); reject(new Error('Inspector RPC timed out')) }, 15_000)
      pending.set(id, packet => { pending.delete(id); globalThis.clearTimeout(timer); resolve(packet) })
      socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
    })
    assert.equal(packet.error, undefined)
    assert.equal(packet.result.exceptionDetails, undefined, JSON.stringify(packet.result.exceptionDetails))
    return packet.result.result.value
  }
  return { evaluate, close: () => socket.close() }
}

function publicRpc(method, args) {
  return `(async()=>{const method=${JSON.stringify(method)};const response=await fetch('/api/'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method,payload:{args:${JSON.stringify(args)}}})});if(!response.ok)throw new Error(method+' HTTP '+response.status);const body=await response.json();if(!body.result?.ok)throw new Error(method+': '+JSON.stringify(body.result?.error));return body.result.value})()`
}

async function verifyActiveTaskGate(application, updates, home, readState) {
  const page = application.windows().find(page => page.url() === 'dsh-app://app/')
  assert.ok(page)
  const rpc = (method, args) => page.evaluate(publicRpc(method, args))
  let contacted = false
  const provider = createHttpServer((request, _response) => { contacted = true; request.resume() })
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
  let sessionId, original, rename
  try {
    const description = await rpc('settings/describe', {})
    original = description.namespaces.find(namespace => namespace.ns === 'llm-deepseek')
    assert.ok(original)
    await rpc('credentials/set', { ref: 'DEEPSEEK_API_KEY', value: 'disposable-kernel-smoke-key' })
    await rpc('settings/update', { ns: original.ns, patch: { baseURL: `http://127.0.0.1:${provider.address().port}/v1` }, expectedRevision: original.revision })
    const models = await rpc('session/modelCatalog', {})
    const group = models.groups.find(group => group.id === 'deepseek-official')
    assert.ok(group?.models.length, 'The real API-key provider must expose its actual model catalog')
    const cwd = join(home, 'busy-workspace')
    await fs.mkdir(cwd, { mode: 0o700 })
    const workspace = await rpc('workspace/create', { request: { path: cwd } })
    ;({ sessionId } = await rpc('session/create', { request: { workspaceId: workspace.workspace.id, cwd } }))
    rename = await rpc('session/rename', { request: { sessionId, title: 'kernel-smoke-busy-history' } })
    await rpc('session/selectModel', { request: { sessionId, provider: group.id, model: group.models[0].id } })
    await rpc('session/prompt', { request: { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: 'Wait for the local smoke provider.' }] } })
    await until(() => contacted, 'A real running Agent never contacted the held local provider', 30_000)
    const before = await readState()
    const rejected = await updates.evaluate(() => window.workbenchUpdates.invoke('install', 'kernel'))
    assert.match(rejected.error, /有活动任务/)
    assert.deepEqual(await readState(), before, 'Active work must block all installation state changes')
    assert.equal((await application.evaluate(() => globalThis.__workbenchSmokeConfirmation.calls)), 0,
      'Active tasks must block installation before the consent dialog')
    assert.equal(application.process().exitCode, null)
    console.log('Real running Agent blocks kernel installation without stopping the task')
  } finally {
    if (sessionId) await rpc('session/cancel', { request: { sessionId } })
    provider.closeAllConnections()
    await new Promise(resolve => provider.close(resolve))
    if (original) {
      const current = (await rpc('settings/describe', {})).namespaces.find(namespace => namespace.ns === original.ns)
      await rpc('settings/update', { ns: original.ns, patch: { baseURL: original.value.baseURL }, expectedRevision: current.revision })
    }
  }
  await setTimeout(250)
  return { sessionId, throughSeq: rename.seq }
}

const root = resolve(import.meta.dirname, '..')
const require = createRequire(join(root, 'build/upstream/package.json'))
const semver = require('semver')
const tar = require('tar')
const { _electron } = require(require.resolve('playwright-core', { paths: [join(root, 'build/upstream/node_modules/.pnpm/node_modules')] }))
const temporary = process.env.DSH_WORKBENCH_TEST_HOME || await fs.mkdtemp('/tmp/dsh-kernel-upgrade-smoke-')
const currentDesktop = JSON.parse(await fs.readFile(join(root, 'desktop.json'), 'utf8'))
const realArchive = process.env.DSH_WORKBENCH_TEST_KERNEL
if (realArchive && (!process.env.DSH_WORKBENCH_TEST_APP || !process.env.DSH_WORKBENCH_TEST_METADATA)) {
  throw new Error('Real kernel smoke requires a verified baseline app and candidate metadata')
}
let executable = process.env.DSH_WORKBENCH_TEST_APP
let application, server, restartedPid, inspector
async function windowAt(ending) {
  for (let attempt = 0; attempt < 1200; attempt++) {
    const page = application.windows().find(item => item.url().endsWith(ending))
    if (page) return page
    await setTimeout(100)
  }
  throw new Error(`Window did not load: ${ending}`)
}
try {
  if (!executable) {
    const name = `dsh-workbench-${currentDesktop.version}-r${currentDesktop.linuxRevision}-linux-x64.tar.gz`
    const archive = join(root, 'dist', name)
    const checksum = (await fs.readFile(join(root, 'dist/SHA256SUMS'), 'utf8')).split('\n')
      .find(line => line.endsWith(`  ${name}`))?.split('  ')[0]
    assert.match(checksum ?? '', /^[a-f0-9]{64}$/, 'The desktop archive must have a recorded SHA-256')
    assert.equal(await fileHash(archive), checksum, 'Verify the desktop archive before executing its runtime')
    await fs.mkdir(join(temporary, 'application-home'), { mode: 0o700 })
    const installed = await installUserDesktop({ archive, sha256: checksum, version: currentDesktop.version,
      home: join(temporary, 'application-home'), root: join(temporary, 'application-home/Applications/dsh-linux-desktop'),
      xdgDataHome: join(temporary, 'application-home/data') })
    executable = installed.executable
  }
  const resources = join(dirname(executable), 'resources')
  const desktop = JSON.parse(await fs.readFile(join(resources, 'app/workbench/desktop.json'), 'utf8'))
  const descriptor = JSON.parse(await fs.readFile(join(resources, 'app/dsh/desktop-runtime.json'), 'utf8'))
  const candidate = join(temporary, 'candidate')
  await fs.mkdir(candidate)
  let archive, manifest, metadata, version
  if (realArchive) {
    archive = resolve(realArchive)
    metadata = JSON.parse(await fs.readFile(process.env.DSH_WORKBENCH_TEST_METADATA, 'utf8'))
    await extractKernel(archive, candidate)
    manifest = await fs.readFile(join(candidate, 'kernel.json'))
    const actual = JSON.parse(manifest)
    for (const key of ['version', 'protocol', 'dataEpoch', 'desktopRange', 'nodeRange']) {
      assert.deepEqual(actual[key], metadata[key], `Actual kernel metadata differs: ${key}`)
    }
    version = actual.version
    assert.ok(semver.gt(version, descriptor.release.version), 'A real candidate must upgrade the actual baseline kernel')
    assert.equal(desktop.followOfficial, true, 'The baseline must already support following official kernels')
    await verifyKernelTree(candidate, { ...metadata, manifestSha256: createHash('sha256').update(manifest).digest('hex') })
    console.log(`Real upstream kernel: ${descriptor.release.version} → ${version}; baseline desktop ${desktop.version}-r${desktop.linuxRevision}`)
  } else {
    console.log('Preparing same-epoch version fixture; this does not prove a real upstream transition')
    await fs.cp(join(resources, 'app/dsh'), join(candidate, 'dsh'), { recursive: true })
    await fs.cp(join(resources, 'runtime'), join(candidate, 'runtime'), { recursive: true })
    version = semver.inc(descriptor.release.version, 'prerelease')
    for (const relative of ['package.json', 'node_modules/@deepseek-ai/dsh/package.json', 'node_modules/@deepseek-ai/dsh-desktop-host/package.json']) {
      const path = join(candidate, 'dsh', relative)
      const original = JSON.parse(await fs.readFile(path, 'utf8'))
      await fs.writeFile(path, JSON.stringify({ ...original, version }) + '\n')
    }
    writeDesktopRuntime(join(candidate, 'dsh'), { ...descriptor.release, version }, descriptor.sharedPackages.map(item => item.name), { platform: 'linux', arch: 'x64' })
    metadata = { ...desktop, version }
    manifest = Buffer.from(JSON.stringify({ ...metadata, files: await inventory(candidate) }) + '\n')
    await fs.writeFile(join(candidate, 'kernel.json'), manifest)
    archive = join(temporary, 'kernel.tgz')
    await tar.c({ gzip: { level: 1 }, file: archive, cwd: candidate, portable: true, noMtime: true }, ['kernel.json', 'dsh', 'runtime'])
  }
  const offlineTransaction = desktop.followOfficial === true
  const originalExecutable = await fs.realpath(executable)
  const originalDesktopHash = await fileHash(join(resources, 'app/workbench/desktop.json'))
  const originalArchiveHash = await fileHash(archive)
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
    ...metadata, version, manifestSha256: createHash('sha256').update(manifest).digest('hex'),
    asset: { url: `${origin}/kernel.tgz`, size: (await fs.stat(archive)).size, sha256: await fileHash(archive) },
  }))
  envelope = { payload: payload.toString('base64'), signature: sign(null, payload, keys.privateKey).toString('base64') }
  const config = join(temporary, 'updates.json')
  await fs.writeFile(config, JSON.stringify({ desktop: null, kernel: { url: `${origin}/kernel.json`, publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }) } }))
  const environment = { ...Object.fromEntries(['PATH', 'DISPLAY', 'LANG', 'LC_ALL', 'TZ', 'XAUTHORITY']
      .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])),
    HOME: temporary, DSH_HOME: join(temporary, 'dsh'), XDG_CONFIG_HOME: join(temporary, 'config'),
    XDG_DATA_HOME: join(temporary, 'data'), XDG_CACHE_HOME: join(temporary, 'cache'),
    XDG_STATE_HOME: join(temporary, 'state'), XDG_RUNTIME_DIR: join(temporary, 'xdg-runtime'), TMPDIR: join(temporary, 'tmp'),
    DSH_WORKBENCH_UPDATE_CONFIG: config, NODE_EXTRA_CA_CERTS: certificate,
  }
  for (const path of ['xdg-runtime', 'tmp']) await fs.mkdir(join(temporary, path), { mode: 0o700 })
  const canary = join(environment.DSH_HOME, 'kernel-smoke-canary.txt')
  await fs.mkdir(environment.DSH_HOME, { mode: 0o700 })
  await fs.writeFile(canary, `baseline=${desktop.version};epoch=${desktop.dataEpoch}\n`, { mode: 0o600 })
  const launch = () => _electron.launch({ executablePath: executable, chromiumSandbox: true, env: environment, timeout: 120_000 })
  async function enter() {
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      const welcome = application.windows().find(page => page.url().endsWith('/welcome.html'))
      if (welcome) {
        await welcome.getByRole('button', { name: /Add API Key|添加 API Key/ }).click()
        await welcome.getByRole('button', { name: /Set up later|稍后配置/ }).click()
        break
      }
      if (application.windows().some(page => page.url() === 'dsh-app://app/')) break
      await setTimeout(100)
    }
    const page = await windowAt('dsh-app://app/')
    await page.getByText(/^(新会话|New (?:chat|session|conversation))$/i).first().waitFor({ state: 'visible', timeout: 60_000 })
    await page.evaluate(() => window.dshDesktop.openWorkbenchUpdates())
    return windowAt('/workbench/updates.html')
  }
  console.log('Kernel fixture signed; launching packaged desktop')
  application = await launch()
  application.process().stderr.on('data', bytes => process.stderr.write(bytes))
  application.process().stdout.on('data', bytes => process.stdout.write(bytes))
  application.process().on('exit', (code, signal) => console.log('Desktop process exit:', code, signal))
  const updates = await enter()
  const idle = await waitForUpdateIdle(updates)
  assert.equal(idle.status.kernel.configured, true)
  if (idle.status.kernel.available !== null) assert.equal(idle.status.kernel.available, version)
  if (idle.status.downloaded.kernel) assert.equal(idle.status.downloaded.kernel, await fileHash(archive))
  const checked = await updates.evaluate(() => window.workbenchUpdates.invoke('check', 'kernel'))
  assert.equal(checked.error, undefined)
  assert.equal(checked.status.kernel.available, version)
  console.log('Signed HTTPS feed accepted; downloading and probing candidate')
  const data = await application.evaluate(holdUpdateConfirmation)
  if (idle.status.downloaded.kernel) {
    const asset = JSON.parse(payload.toString()).asset
    const cache = join(data, 'updates/downloads', 'kernel-' + asset.sha256 + '.tgz')
    assert.equal((await fs.stat(cache)).size, asset.size)
    assert.equal(await fileHash(cache), asset.sha256, 'Automatically verified cache must still match the signed asset')
  }
  const statePath = join(data, 'updates/state.json')
  const readState = async () => {
    try { return JSON.parse(await fs.readFile(statePath, 'utf8')) }
    catch (error) { if (error.code === 'ENOENT') return null; throw error }
  }
  const savedSession = await verifyActiveTaskGate(application, updates, temporary, readState)
  const readHistory = publicRpc('session/page', { request: { address: { kind: 'session', sessionId: savedSession.sessionId }, throughSeq: savedSession.throughSeq, maxMessages: 50 } })
  const beforeInstall = await readState()
  const confirmationDeadline = Date.now() + 180_000
  let operationResult
  const updateOperation = updates.evaluate(() => window.workbenchUpdates.invoke('install', 'kernel'))
    .catch(error => ({ closed: true, message: error.message }))
    .then(result => { operationResult = result; return result })
  let consent
  while (Date.now() < confirmationDeadline && !consent?.options) {
    if (operationResult?.error) throw new Error(operationResult.error)
    if (operationResult?.closed) throw new Error('Application closed before explicit confirmation')
    consent = await application.evaluate(() => {
      const { calls, relaunches, settled, options } = globalThis.__workbenchSmokeConfirmation
      return { calls, relaunches, settled, options }
    })
    if (!consent.options) await setTimeout(100)
  }
  assert.ok(consent?.options, 'Install must wait for a real native consent dialog')
  assert.equal(consent.calls, 1)
  assert.equal(consent.relaunches, 0)
  assert.equal(consent.settled, false)
  assert.equal(consent.options.title, '确认更新')
  assert.equal(consent.options.message, '更新内核至 ' + version + '？')
  assert.deepEqual(consent.options.buttons, ['取消', '继续'])
  assert.equal(consent.options.defaultId, 0)
  assert.equal(consent.options.cancelId, 0)
  if (offlineTransaction) {
    assert.match(consent.options.detail, /保留当前桌面壳/)
    assert.match(consent.options.detail, /备份/)
  } else assert.match(consent.options.detail, /下载并校验/)
  assert.deepEqual(await readState(), beforeInstall, 'No installation state may change before consent')
  assert.equal(application.process().exitCode, null, 'No restart may precede consent')
  const held = await updates.evaluate(() => window.workbenchUpdates.invoke('status'))
  assert.equal(held.status.busy, true)
  assert.equal(held.status.kernel.version, idle.status.kernel.version)
  await updates.waitForFunction(() => [...document.querySelectorAll('button')].every(button => button.disabled), null, { timeout: 5_000 })
  for (const name of ['检查更新', '确认安装并重启']) assert.equal(await updates.getByRole('button', { name, exact: true }).isDisabled(), true)
  const busy = await updates.evaluate(() => window.workbenchUpdates.invoke('check', 'kernel'))
  assert.match(busy.error, /已有更新操作或确认对话框正在进行/)
  const exited = Promise.all([application.waitForEvent('close', { timeout: 180_000 }), once(application.process(), 'exit')])
  await application.evaluate(() => globalThis.__workbenchSmokeConfirmation.respond(1))
  const [, [exitCode, signal]] = await Promise.race([
    exited,
    setTimeout(180_000, undefined, { ref: false })
      .then(() => { throw new Error('Updater did not exit after clean stop') }),
  ])
  assert.equal(exitCode, 0)
  assert.equal(signal, null)
  // The old renderer may disappear before its install IPC reply can settle.
  // Process exit and the worker's health receipt below are the durable result.
  await Promise.race([updateOperation, setTimeout(1_000, undefined, { ref: false })])
  if (operationResult?.error) throw new Error(operationResult.error)
  application = undefined
  if (offlineTransaction) {
    console.log('Original shell exited; waiting for the offline transaction health receipt')
    const directory = await until(async () => {
      const names = await fs.readdir(join(temporary, 'Backups/dsh-workbench')).catch(error => {
        if (error.code === 'ENOENT') return []; throw error
      })
      const ids = names.filter(name => /^[a-f0-9-]{36}$/.test(name))
      return ids.length === 1 && join(temporary, 'Backups/dsh-workbench', ids[0])
    }, 'Offline kernel transaction was not created')
    const report = await until(async () => {
      const value = await fs.readFile(join(directory, 'report.json'), 'utf8').then(JSON.parse).catch(error => {
        if (error.code === 'ENOENT') return null; throw error
      })
      return ['healthy', 'failed'].includes(value?.phase) && value
    }, 'Kernel migration worker never reported a terminal result', 300_000)
    restartedPid = report.newDesktopPid
    assert.equal(report.phase, 'healthy', JSON.stringify(report))
    assert.ok(Number.isSafeInteger(restartedPid))
    assert.equal(await fs.realpath(`/proc/${restartedPid}/exe`), originalExecutable, 'The worker must restart the original old shell')
    assert.ok(Date.parse(report.originalExitObservedAt) <= Date.parse(report.backupVerifiedAt))
    assert.ok(Date.parse(report.backupVerifiedAt) <= Date.parse(report.activatedAt))
    const backup = JSON.parse(await fs.readFile(join(directory, 'backup/manifest.json'), 'utf8'))
    assert.deepEqual(backup.roots.slice(0, 2).map(entry => entry.source), [environment.DSH_HOME, data])
    assert.equal(await fs.readFile(join(directory, 'backup/dshHome/kernel-smoke-canary.txt'), 'utf8'),
      `baseline=${desktop.version};epoch=${desktop.dataEpoch}\n`)
    console.log('Offline worker is healthy; independently verifying the complete backup')
    for (const entry of backup.roots) await verifyBackupRoot(join(directory, 'backup', entry.name), entry.entries)
    console.log('Complete backup verified; reconnecting to the restarted shell')
    inspector = await attachOwnedInspector(restartedPid, originalExecutable)
    const versions = await inspector.evaluate(`(async()=>{const electron=process.getBuiltinModule('module').createRequire(process.execPath)('electron'); const page=electron.webContents.getAllWebContents().find(page=>page.getURL()==='dsh-app://app/'); if(!page)throw new Error('Real workspace is missing'); return page.executeJavaScript('window.dshDesktop.getWorkbenchVersions(false)')})()`)
    assert.equal(versions.kernel.version, version)
    assert.equal(versions.desktop.version, desktop.version)
    assert.equal(versions.desktop.linuxRevision, desktop.linuxRevision)
    const history = await inspector.evaluate(`(async()=>{const electron=process.getBuiltinModule('module').createRequire(process.execPath)('electron'); const page=electron.webContents.getAllWebContents().find(page=>page.getURL()==='dsh-app://app/'); return page.executeJavaScript(${JSON.stringify(readHistory)})})()`)
    assert.match(JSON.stringify(history), /kernel-smoke-busy-history/)
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'))
    assert.equal(state.dataEpoch, metadata.dataEpoch)
    assert.equal(state.migrationReceipt.phase, 'healthy')
    assert.equal(state.migrationReceipt.kernelId, originalArchiveHash)
    assert.equal(state.migrationReceipt.transactionId, state.migration)
    assert.equal(state.migrationReceipt.backupVerifiedAt, report.backupVerifiedAt)
    console.log('Real old shell restarted with the new official kernel; verified complete pre-migration backup')
  } else {
    assert.equal(JSON.parse(await fs.readFile(statePath, 'utf8')).pending, 'staged',
      'Candidate must pass the real isolated Host probe and clean stop before staging')
    application = await launch()
    const after = await enter()
    const selected = await after.evaluate(() => window.workbenchUpdates.invoke('status'))
    assert.equal(selected.status.kernel.version, version)
    assert.equal(selected.status.desktop.version, desktop.version)
    assert.equal(selected.status.desktop.linuxRevision, desktop.linuxRevision)
    const workspace = application.windows().find(page => page.url() === 'dsh-app://app/')
    assert.match(JSON.stringify(await workspace.evaluate(readHistory)), /kernel-smoke-busy-history/)
    await after.screenshot({ path: join(root, 'build/kernel-update-smoke.png') })
  }
  const finalState = JSON.parse(await fs.readFile(statePath, 'utf8'))
  assert.equal(finalState.pending, null)
  assert.equal(finalState.active, originalArchiveHash)
  assert.equal(await fileHash(join(resources, 'app/workbench/desktop.json')), originalDesktopHash)
  assert.equal(await fileHash(archive), originalArchiveHash, 'The candidate archive must not be rewritten by this test')
  if (process.env.DSH_WORKBENCH_TEST_RESULT) await fs.writeFile(process.env.DSH_WORKBENCH_TEST_RESULT,
    JSON.stringify({ kernelHealthy: true, desktopUnchanged: true, backupVerified: offlineTransaction,
      baseline: desktop, candidate: metadata, kernelSha256: originalArchiveHash }) + '\n')
  console.log(`${realArchive ? 'Actual upstream' : 'Synthetic same-epoch'} signed kernel update passed: ${descriptor.release.version} → ${version}; desktop stays ${desktop.version}-r${desktop.linuxRevision}`)
} catch (error) {
  if (application) for (const page of application.windows()) {
    console.error('Window:', page.url().slice(0, 120), await page.locator('body').innerText().catch(() => '<unavailable>'))
    await page.screenshot({ path: join(root, 'build/kernel-update-failure.png') }).catch(() => undefined)
  }
  throw error
} finally {
  if (application) await application.close()
  if (inspector) {
    await inspector.evaluate(`process.getBuiltinModule('module').createRequire(process.execPath)('electron').app.exit(0)`).catch(() => undefined)
    inspector.close()
  } else if (restartedPid) {
    const running = await fs.realpath(`/proc/${restartedPid}/exe`).catch(error => {
      if (error.code === 'ENOENT') return null; throw error
    })
    if (running) {
      assert.equal(running, await fs.realpath(executable))
      process.kill(restartedPid, 'SIGTERM')
    }
  }
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  if (!process.env.DSH_WORKBENCH_TEST_HOME) await fs.rm(temporary, { recursive: true, force: true })
}
