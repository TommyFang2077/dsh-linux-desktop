/** Real desktop migration smoke; every writable runtime path is disposable. */
import assert from 'node:assert/strict'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { createReadStream } from 'node:fs'
import * as fs from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:https'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { setTimeout } from 'node:timers/promises'

const repository = resolve(import.meta.dirname, '..')
const execute = promisify(execFile)

const usage = `Usage: node scripts/whole-desktop-smoke.mjs [options]
  --preflight-only          Verify isolated runtime paths without launching
  --bridge-only             Run frozen r7 check/install against the real r8 archive
  --fault MODE              cancel, writer, worker, backup, source-change, post-start-failure, host-proc
  --resume-transaction PATH Resume restoration from one retained real smoke transaction
  --corrupt-maps            Test real verify/restore rejection against that retained transaction
  --user-data-fixture       Verify public nonempty session and custom model settings across the chain
  --bridge-archive PATH     Built alpha.1 r8 desktop archive
  --bridge-sha256 HEX       Independently recorded archive SHA-256
  --desktop-archive PATH    Built alpha.2 r2 desktop archive
  --desktop-sha256 HEX      Independently recorded archive SHA-256
  --keep                    Retain disposable evidence after the smoke
  --help                    Show this help
`

function parseOptions(args) {
  if (args.length === 0) throw new Error(usage)
  const flags = new Set(['--help', '--keep', '--preflight-only', '--bridge-only', '--corrupt-maps', '--user-data-fixture'])
  const values = new Set(['--bridge-archive', '--bridge-sha256', '--desktop-archive', '--desktop-sha256', '--fault', '--resume-transaction'])
  const options = {}
  for (let index = 0; index < args.length; index++) {
    const option = args[index]
    if (!flags.has(option) && !values.has(option)) throw new Error(`Unknown option: ${option}`)
    if (Object.hasOwn(options, option)) throw new Error(`Duplicate option: ${option}`)
    if (flags.has(option)) options[option] = true
    else {
      const value = args[++index]
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${option}`)
      options[option] = value
    }
  }
  if (options['--help']) return options
  if (options['--user-data-fixture'] && (options['--preflight-only'] || options['--bridge-only'] ||
    options['--fault'] || options['--resume-transaction'])) throw new Error('User data fixture requires a complete normal migration')
  if (options['--corrupt-maps'] && !options['--resume-transaction']) throw new Error('--corrupt-maps requires --resume-transaction')
  if (options['--resume-transaction'] && !/^\/tmp\/dsh-whole-desktop-smoke-[A-Za-z0-9]+\/home\/Backups\/dsh-workbench\/[a-f0-9-]{36}\/transaction\.json$/u
    .test(options['--resume-transaction'])) throw new Error('Resume requires an owned private transaction')
  if (options['--fault'] && !['cancel', 'writer', 'worker', 'backup', 'source-change', 'post-start-failure', 'host-proc']
    .includes(options['--fault'])) throw new Error('Invalid --fault')
  for (const kind of ['bridge', 'desktop']) {
    const archive = `--${kind}-archive`, checksum = `--${kind}-sha256`
    if (options[archive] && !options[checksum]) throw new Error(`Missing ${checksum}`)
    if (options[checksum] && !/^[a-f0-9]{64}$/u.test(options[checksum])) throw new Error(`Invalid ${checksum}`)
    if (options[checksum] && !options[archive]) throw new Error(`Missing ${archive}`)
  }
  if (!options['--preflight-only']) {
    const required = options['--bridge-only'] ? ['--bridge-archive', '--bridge-sha256']
      : ['--bridge-archive', '--bridge-sha256', '--desktop-archive', '--desktop-sha256']
    for (const option of required) if (!options[option]) throw new Error(`Missing ${option}`)
  }
  return options
}

async function verifyArtifacts(options) {
  const artifacts = []
  for (const kind of ['bridge', 'desktop']) {
    if (!options[`--${kind}-archive`]) continue
    const path = resolve(options[`--${kind}-archive`])
    const stat = await fs.lstat(path)
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'Archive must be a regular unlinked file')
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    const sha256 = hash.digest('hex')
    assert.equal(sha256, options[`--${kind}-sha256`], 'Archive SHA-256 differs from recorded trust')
    artifacts.push({ kind, path, sha256, size: stat.size })
  }
  return artifacts
}

async function callerMetadata() {
  const paths = new Set([process.env.HOME, process.env.DSH_HOME, process.env.XDG_CONFIG_HOME,
    process.env.XDG_DATA_HOME, process.env.XDG_CACHE_HOME, process.env.XDG_STATE_HOME,
    process.env.XDG_RUNTIME_DIR, process.env.DSH_SMOKE_PROTECTED_HOME].filter(Boolean))
  return Promise.all([...paths].sort().map(async path => {
    try {
      const stat = await fs.lstat(path)
      return { path, mode: stat.mode, uid: stat.uid, dev: stat.dev, ino: stat.ino,
        size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs }
    } catch (error) {
      if (error.code === 'ENOENT') return { path, missing: true }
      throw error
    }
  }))
}

async function disposableEnvironment(root) {
  const environment = Object.fromEntries(['PATH', 'DISPLAY', 'LANG', 'LC_ALL', 'TZ']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
  const directories = { HOME: 'home', DSH_HOME: 'home/dsh', XDG_CONFIG_HOME: 'home/config',
    XDG_DATA_HOME: 'home/data', XDG_CACHE_HOME: 'home/cache', XDG_STATE_HOME: 'home/state',
    XDG_RUNTIME_DIR: 'runtime', TMPDIR: 'tmp' }
  const permissions = {}
  for (const [key, directory] of Object.entries(directories)) {
    environment[key] = join(root, directory)
    await fs.mkdir(environment[key], { recursive: true, mode: 0o700 })
    permissions[key] = (await fs.stat(environment[key])).mode & 0o777
    assert.equal(permissions[key], 0o700, `${key} must be user-private`)
  }
  const authority = process.env.XAUTHORITY
  if (authority?.startsWith('/tmp/')) {
    const info = await fs.lstat(authority)
    assert.ok(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid()
      && (info.mode & 0o077) === 0 && await fs.realpath(authority) === authority,
    'Temporary display authority must be a private regular file')
    environment.XAUTHORITY = join(root, 'test-Xauthority')
    await fs.copyFile(authority, environment.XAUTHORITY)
    await fs.chmod(environment.XAUTHORITY, 0o600)
  }
  return { environment, permissions }
}

function archiveIdentities(artifacts, environment) {
  return artifacts.map(artifact => {
    let desktop
    try {
      desktop = JSON.parse(execFileSync('tar', ['-xOf', artifact.path,
        'app/resources/app/workbench/desktop.json'], { env: environment, encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, maxBuffer: 1024 ** 2 }))
    } catch { throw new Error('Archive identity verification failed') }
    const bridge = artifact.kind === 'bridge'
    if (desktop.version !== (bridge ? '0.2.1-alpha.1' : '0.2.1-alpha.2')
      || desktop.linuxRevision !== (bridge ? 8 : 2) || desktop.dataEpoch !== `dsh-${desktop.version}`
      || desktop.nodeVersion !== '24.21.0') throw new Error(`${artifact.kind} archive identity differs`)
    return { ...artifact, desktop }
  })
}

async function signedTransport(root, artifacts, environment) {
  const key = join(root, 'test-tls.key'), certificate = join(root, 'test-ca.crt')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
    '-keyout', key, '-out', certificate], { env: environment, stdio: 'ignore' })
  await fs.chmod(key, 0o600)
  const keys = generateKeyPairSync('ed25519')
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' })
  const responses = new Map()
  const server = createServer({ key: await fs.readFile(key), cert: await fs.readFile(certificate) }, (request, response) => {
    const value = responses.get(request.url)
    if (!value) { response.writeHead(404); response.end(); return }
    if (typeof value === 'string') { response.setHeader('Content-Type', 'application/json'); response.end(value) }
    else createReadStream(value.archive).on('error', () => response.destroy()).pipe(response)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `https://127.0.0.1:${server.address().port}`
  const config = { kernel: null, desktop: null, desktopUpgrade: null }
  for (const artifact of artifacts) {
    const payload = Buffer.from(JSON.stringify({ schemaVersion: 2, channel: 'desktop', platform: 'linux', arch: 'x64',
      format: 'tar.gz', ...artifact.desktop, asset: { url: `${origin}/${artifact.kind}.tar.gz`,
        size: artifact.size, sha256: artifact.sha256 } }))
    responses.set(`/${artifact.kind}.json`, JSON.stringify({ payload: payload.toString('base64'),
      signature: sign(null, payload, keys.privateKey).toString('base64') }))
    responses.set(`/${artifact.kind}.tar.gz`, { archive: artifact.path })
    config[artifact.kind === 'bridge' ? 'desktop' : 'desktopUpgrade'] = { url: `${origin}/${artifact.kind}.json`, publicKey }
  }
  const configPath = join(root, 'test-updates.json')
  await fs.writeFile(configPath, JSON.stringify(config), { mode: 0o600 })
  return { server, config, configPath, certificate, responses }
}

async function frozenBridge(root, artifacts, environment, transport) {
  const source = join(repository, 'tests/fixtures/legacy-r7-core.mjs')
  const bytes = await fs.readFile(source)
  const sourceSha256 = createHash('sha256').update(bytes).digest('hex')
  assert.equal(sourceSha256, '4d08a7ca4c67fdc89d9c4f49756912615ce586172811f565c28939ef0f0f10f6')
  const require = createRequire(join(repository, 'build/upstream/package.json'))
  const esbuild = require(require.resolve('esbuild', { paths: [join(repository, 'build/upstream/node_modules/.pnpm/node_modules')] }))
  const bundle = join(root, 'frozen-real-r7.mjs')
  await esbuild.build({ entryPoints: [source], outfile: bundle, bundle: true, platform: 'node', format: 'esm',
    target: 'node24', nodePaths: [join(repository, 'build/upstream/node_modules')],
    banner: { js: "import { createRequire as __legacyRequire } from 'node:module'; const require = __legacyRequire(import.meta.url);" } })
  const desktop = JSON.parse(execFileSync('git', ['show', 'workbench-v0.2.1-alpha.1-r7:desktop.json'],
    { cwd: repository, env: environment, encoding: 'utf8' }))
  const descriptor = { bundle: pathToFileURL(bundle).href,
    installer: pathToFileURL(join(repository, 'build/user-install.mjs')).href, config: transport.config, desktop }
  const result = await execute(process.execPath, ['--input-type=module', '-e', `
    import { join } from 'node:path';
    const input=JSON.parse(process.env.DSH_SMOKE_INPUT);
    const {UpdateManager}=await import(input.bundle);
    const {installUserDesktop}=await import(input.installer);
    const manager=new UpdateManager({root:join(process.env.DSH_HOME,'frozen-r7-updates'),config:input.config,
      desktop:input.desktop,bundled:{...input.desktop,dsh:'/frozen/r7/dsh',runtime:'/frozen/r7/runtime'}});
    await manager.boot();await manager.check('desktop');
    const available=manager.status().desktop.availableLinuxRevision;
    let executable;const installed=await manager.installDesktop(async()=>true,
      artifact=>installUserDesktop({...artifact,home:process.env.HOME,
        root:join(process.env.HOME,'Applications/dsh-linux-desktop'),xdgDataHome:process.env.XDG_DATA_HOME}),
      value=>{executable=value});
    console.log(JSON.stringify({mode:'frozen-real-r7',available,installed,executable}));
  `], { env: { ...environment, NODE_EXTRA_CA_CERTS: transport.certificate, DSH_SMOKE_INPUT: JSON.stringify(descriptor) },
    timeout: 300_000, maxBuffer: 1024 ** 2 })
  const receipt = JSON.parse(result.stdout.trim().split('\n').at(-1))
  assert.equal(receipt.available, 8)
  assert.equal(receipt.installed, true)
  const metadata = JSON.parse(await fs.readFile(join(dirname(receipt.executable), 'resources/app/workbench/desktop.json'), 'utf8'))
  assert.deepEqual(metadata, artifacts.find(artifact => artifact.kind === 'bridge').desktop)
  return { ...receipt, sourceSha256, metadata }
}

async function until(operation, message, timeout = 120_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await operation()
    if (result) return result
    await setTimeout(100)
  }
  throw new Error(message)
}

async function json(path) { return JSON.parse(await fs.readFile(path, 'utf8')) }
async function exists(path) { return fs.lstat(path).then(() => true, error => {
  if (error.code === 'ENOENT') return false
  throw error
}) }

async function journals(directory) {
  const records = []
  for (const name of await fs.readdir(directory)) {
    if (!name.endsWith('.jsonl')) continue
    const lines = (await fs.readFile(join(directory, name), 'utf8')).trim().split('\n').filter(Boolean)
    records.push(...lines.map(line => JSON.parse(line)))
  }
  return records
}

async function healthyJournal(directory, pid, version) {
  return until(async () => {
    const records = (await journals(directory)).filter(record => record.pid === pid)
    const healthy = records.find(record => record.event === 'workspace-ready' && record.version === version)
    if (!healthy) return false
    assert.ok(records.find(record => record.event === 'started' && record.version === version))
    for (let index = 1; index < records.length; index++) assert.ok(records[index].sequence > records[index - 1].sequence)
    return records
  }, 'Real Host workspace-ready journal was not produced')
}

function playwright() {
  const require = createRequire(join(repository, 'build/upstream/package.json'))
  return require(require.resolve('playwright-core', { paths: [join(repository, 'build/upstream/node_modules/.pnpm/node_modules')] }))._electron
}

async function enter(application) {
  const page = await until(async () => {
    const welcome = application.windows().find(page => page.url().endsWith('/welcome.html'))
    if (welcome && await welcome.getByRole('button', { name: /Add API Key|添加 API Key/u }).isVisible().catch(() => false)) {
      await welcome.getByRole('button', { name: /Add API Key|添加 API Key/u }).click()
      await welcome.getByRole('button', { name: /Set up later|稍后配置/u }).click()
    }
    return application.windows().find(page => page.url() === 'dsh-app://app/')
  }, 'Real desktop welcome/workspace did not open')
  await page.evaluate(() => window.dshDesktop.openWorkbenchUpdates())
  return until(async () => {
    const updates = application.windows().find(page => page.url().endsWith('/workbench/updates.html'))
    return updates && await updates.evaluate(() => Boolean(window.workbenchUpdates)).catch(() => false) ? updates : false
  }, 'Production workbench update window did not open')
}

async function launchBridge(root, bridge, environment, transport, options) {
  const journal = join(root, 'journal')
  await fs.mkdir(journal, { mode: 0o700 })
  const env = { ...environment, NODE_EXTRA_CA_CERTS: transport.certificate,
    DSH_WORKBENCH_UPDATE_CONFIG: transport.configPath, DSH_DESKTOP_UPDATE_JOURNAL_DIR: journal }
  const application = await playwright().launch({ executablePath: bridge.executable, chromiumSandbox: true,
    env, timeout: 120_000 })
  try {
    const updates = await enter(application)
    const pid = application.process().pid
    const health = await healthyJournal(journal, pid, '0.2.1-alpha.1')
    const actual = await application.evaluate(({ app }) => ({ home: app.getPath('home'),
      userData: app.getPath('userData'), executable: process.execPath, dshHome: process.env.DSH_HOME }))
    assert.equal(actual.home, environment.HOME)
    assert.equal(actual.dshHome, environment.DSH_HOME)
    assert.ok(actual.userData.startsWith(environment.XDG_CONFIG_HOME + '/'))
    const checked = await until(async () => {
      const result = await updates.evaluate(() => window.workbenchUpdates.invoke('check', 'desktopUpgrade'))
      if (result.error && /正在进行/u.test(result.error)) return false
      assert.equal(result.error, undefined)
      assert.equal(result.status.desktopUpgrade.available, '0.2.1-alpha.2')
      assert.equal(result.status.desktopUpgrade.availableLinuxRevision, 2)
      return result
    }, 'Signed complete-desktop IPC check did not finish')
    await updates.screenshot({ path: join(root, 'r8-upgrade.png') })
    if (options['--fault'] !== 'cancel') return { application, process: application.process(), pid,
      updates, actual, journal, env, checked, health }
    await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false }) })
    const before = await fs.realpath(join(environment.HOME, 'Applications/dsh-linux-desktop/current'))
    const result = await updates.evaluate(() => window.workbenchUpdates.invoke('install', 'desktopUpgrade'))
    assert.equal(result.error, undefined)
    assert.equal(await fs.realpath(join(environment.HOME, 'Applications/dsh-linux-desktop/current')), before)
    assert.equal(await exists(join(environment.HOME, 'Backups/dsh-workbench')), false)
    return { cancelled: true, pid, actual, journal, checked, health }
  } finally {
    if (options['--fault'] === 'cancel') await application.close()
  }
}

async function hashFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function processIdentity(pid) {
  try {
    const text = await fs.readFile(`/proc/${pid}/stat`, 'utf8')
    const fields = text.slice(text.lastIndexOf(')') + 2).split(' ')
    return { pid, name: text.slice(text.indexOf('(') + 1, text.lastIndexOf(')')),
      state: fields[0], parent: Number(fields[1]), startTime: fields[19] }
  } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return undefined; throw error }
}

async function alive(pid) { const identity = await processIdentity(pid); return identity && identity.state !== 'Z' }

async function processFacts(pid) {
  const facts = { identity: await processIdentity(pid) }
  for (const field of ['exe', 'cmdline', 'status']) {
    try { facts[field] = field === 'exe' ? await fs.readlink(`/proc/${pid}/${field}`)
      : await fs.readFile(`/proc/${pid}/${field}`, 'utf8') }
    catch (error) { facts[field] = { error: error.code } }
  }
  return facts
}

async function descendants(pid) {
  const processes = []
  for (const entry of await fs.readdir('/proc')) {
    if (!/^\d+$/u.test(entry)) continue
    const identity = await processIdentity(Number(entry))
    if (identity && identity.state !== 'Z') processes.push(identity)
  }
  const selected = new Set([pid])
  for (let pass = 0; pass < processes.length; pass++) {
    let added = false
    for (const child of processes) if (selected.has(child.parent) && !selected.has(child.pid)) {
      selected.add(child.pid); added = true
    }
    if (!added) break
  }
  return processes.filter(child => selected.has(child.pid))
}

async function stopDesktop(pid) {
  const owned = await descendants(pid)
  if (await alive(pid)) process.kill(pid, 'SIGTERM')
  const deadline = Date.now() + 10_000
  while (await alive(pid) && Date.now() < deadline) await setTimeout(100)
  for (const identity of owned.reverse()) {
    const current = await processIdentity(identity.pid)
    if (current?.startTime === identity.startTime && current.state !== 'Z') process.kill(identity.pid, 'SIGKILL')
  }
}

async function runtimeEvidence(pid, executable, actual, environment) {
  assert.equal(await fs.realpath(`/proc/${pid}/exe`), executable)
  const procEnvironment = (await fs.readFile(`/proc/${pid}/environ`, 'utf8')).split('\0')
  const records = []
  for (const child of await descendants(pid)) {
    const facts = await processFacts(child.pid)
    records.push({ ...child, executable: typeof facts.exe === 'string' ? facts.exe : null,
      args: typeof facts.cmdline === 'string' ? facts.cmdline.split('\0') : [],
      readErrors: { exe: facts.exe?.error, cmdline: facts.cmdline?.error } })
  }
  const node = join(dirname(executable), 'resources/runtime/primary-runtime/dependencies/node/bin/node')
  const host = records.find(record => record.executable === node)
  assert.ok(host, 'Actual bundled Node Host process was not observable')
  const profile = join(actual.dshHome, 'profiles/desktop')
  assert.ok(host.args.includes(profile), 'Actual Host profile differs from the snapshot DSH root')
  const userDataArgument = `--user-data-dir=${actual.userData}`
  // Chromium may rewrite argv[0] into one space-separated process title.
  const userDataObserved = records.some(record => record.args.some(argument => argument.split(/\s+/u).includes(userDataArgument)))
  await fs.writeFile(join(dirname(actual.home), `runtime-processes-${pid}.json`), JSON.stringify(records), { mode: 0o600 })
  assert.ok(userDataObserved, 'Actual Chromium userData differs from the snapshot root')
  return { pid, executable, dshHome: actual.dshHome, userData: actual.userData, userDataObserved,
    initialProcDshHome: procEnvironment.find(value => value.startsWith('DSH_HOME='))?.slice(9) ?? null,
    host: { pid: host.pid, executable: host.executable, profile, nodeVersion: execFileSync(node, ['--version'],
      { encoding: 'utf8', env: environment }).trim() } }
}

async function verifyRoot(path, entries) {
  if (entries === null) { assert.equal(await exists(path), false); return }
  const visited = []
  async function walk(directory, prefix = '') {
    visited.push(prefix)
    for (const name of (await fs.readdir(directory)).sort()) {
      const child = prefix ? `${prefix}/${name}` : name
      const absolute = join(directory, name)
      if ((await fs.lstat(absolute)).isDirectory()) await walk(absolute, child)
      else visited.push(child)
    }
  }
  await walk(path)
  assert.deepEqual(visited, entries.map(entry => entry.path), 'Complete tree inventory differs')
  for (const entry of entries) {
    const absolute = join(path, entry.path), stat = await fs.lstat(absolute)
    assert.equal(stat.mode & 0o777, entry.mode, `Copied mode differs: ${entry.path}`)
    if (entry.type === 'file') {
      assert.ok(stat.isFile())
      assert.equal(stat.size, entry.size)
      assert.equal(await hashFile(absolute), entry.sha256, `Copied bytes differ: ${entry.path}`)
    } else if (entry.type === 'link') {
      assert.ok(stat.isSymbolicLink())
      assert.equal(await fs.readlink(absolute), entry.target)
    } else assert.ok(stat.isDirectory())
  }
}

async function seedData(actual) {
  for (const base of [actual.dshHome, actual.userData]) {
    const directory = join(base, 'whole-smoke-canary')
    await fs.mkdir(directory, { mode: 0o700 })
    await fs.writeFile(join(directory, 'epoch.txt'), 'epoch=alpha1\n', { mode: 0o640 })
    await fs.writeFile(join(directory, '.hidden'), 'all old data is retained\n', { mode: 0o600 })
    await fs.symlink('epoch.txt', join(directory, 'relative-link'))
  }
}

function publicRpcSource(method, args) {
  return `(async()=>{const method=${JSON.stringify(method)};const response=await fetch('/api/'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method,payload:{args:${JSON.stringify(args)}}})});if(!response.ok)throw new Error(method+' HTTP '+response.status);const body=await response.json();if(!body.result?.ok)throw new Error(method+': '+JSON.stringify(body.result?.error));return body.result.value})()`
}

async function readPublicUserData(rpc, expected, projectionContract = 'sequenced') {
  const projections = await rpc('session/projections', { request: { sessionId: expected.sessionId } })
  if (projectionContract === 'sequenced') assert.equal(projections?.kind, 'sequenced', 'Real full reader must resolve the existing sequenced Session')
  else {
    assert.ok(projections && typeof projections.values === 'object')
    assert.equal(projections.kind, undefined, 'Real r8 baseline has no alpha2 discriminant')
  }
  assert.ok(Number.isSafeInteger(projections.asOfSeq))
  assert.ok(projections.asOfSeq >= expected.rename.seq)
  const request = { address: { kind: 'session', sessionId: expected.sessionId }, throughSeq: expected.rename.seq, maxMessages: 50 }
  const records = []
  let page, pages = 0
  do {
    assert.ok(++pages <= 20, 'Fixture history pagination did not converge')
    page = await rpc('session/page', { request })
    records.push(...page.records)
    if (page.hasMore) request.beforeSeq = Math.min(...page.records.map(record => record.event.seq))
  } while (page.hasMore)
  records.sort((left, right) => left.event.seq - right.event.seq)
  const renamed = records.find(record => record.type === 'event' && record.event.seq === expected.rename.seq)
  assert.ok(renamed && JSON.stringify(renamed.event.data).includes(expected.title), 'Actual durable title event body was not read')
  if (expected.page) assert.deepEqual(records, expected.page.records, 'Full existing Session event prefix changed')
  const description = await rpc('settings/describe', {})
  const settings = description.namespaces.find(namespace => namespace.ns === 'llm-deepseek')
  assert.ok(settings, 'Public provider settings namespace is missing')
  assert.equal(settings.user.baseURL, expected.settings.user.baseURL)
  assert.deepEqual(settings.user.models, expected.settings.user.models)
  assert.equal(settings.value.baseURL, expected.settings.user.baseURL)
  assert.equal(settings.value.models.find(model => model.id === expected.modelId)?.maxTokens, 257)
  return { sessionId: expected.sessionId, title: expected.title, rename: expected.rename, modelId: expected.modelId,
    page: { records, hasMore: false, pages }, projections, projectionContract,
    settings: { ns: settings.ns, revision: settings.revision, user: settings.user, value: settings.value } }
}

async function preparePublicUserData(root, ui) {
  const requests = []
  const server = createHttpServer((request, response) => {
    requests.push({ method: request.method, path: request.url })
    response.writeHead(503, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'This fixture checks metadata, not model execution' } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const page = ui.application.windows().find(page => page.url() === 'dsh-app://app/')
    assert.ok(page, 'Real r8 public application renderer is missing')
    const rpc = (method, args) => page.evaluate(publicRpcSource(method, args))
    const workspacePath = join(ui.actual.home, 'public-workspace')
    await fs.mkdir(workspacePath, { mode: 0o700 })
    const workspace = await rpc('workspace/create', { request: { path: workspacePath } })
    const created = await rpc('session/create', { request: { workspaceId: workspace.workspace.id, cwd: workspacePath } })
    const title = `whole-desktop-old-history-${randomUUID()}`
    const rename = await rpc('session/rename', { request: { sessionId: created.sessionId, title } })
    assert.equal(rename.title, title)
    assert.ok(Number.isSafeInteger(rename.seq) && rename.seq >= 0)
    const description = await rpc('settings/describe', {})
    const descriptor = description.namespaces.find(namespace => namespace.ns === 'llm-deepseek')
    assert.ok(descriptor, 'Real r8 provider descriptor is missing')
    const models = structuredClone(descriptor.value.models)
    const model = models.find(model => model.id === 'deepseek-flash')
    assert.ok(model, 'Pinned r8 public model catalog must contain deepseek-flash')
    model.maxTokens = 257
    const baseURL = `http://127.0.0.1:${server.address().port}/v1`
    const settings = await rpc('settings/update', { ns: descriptor.ns, patch: { baseURL, models }, expectedRevision: descriptor.revision })
    const expected = { sessionId: created.sessionId, title, rename, modelId: model.id, settings }
    const old = await readPublicUserData(rpc, expected, 'alpha1-baseline')
    await fs.writeFile(join(root, 'public-old-user-data.json'), JSON.stringify(old), { mode: 0o600 })
    return { old, server, requests }
  } catch (error) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); throw error }
}

async function attachOwnedPublicRenderer(pid, executable, actual) {
  const birth = await processIdentity(pid)
  assert.ok(birth && birth.state !== 'Z')
  assert.equal(await fs.realpath(`/proc/${pid}/exe`), executable)
  // Linux SIGUSR1 exposes the existing Node inspector without adding worker/app argv.
  process.kill(pid, 'SIGUSR1')
  const endpoint = await until(async () => {
    try {
      const targets = await (await fetch('http://127.0.0.1:9229/json/list', { signal: AbortSignal.timeout(500) })).json()
      return targets.find(target => target.title === `${executable}[${pid}]`) ?? false
    } catch { return false }
  }, 'Owned real desktop inspector did not become reachable', 5_000)
  assert.equal((await processIdentity(pid))?.startTime, birth.startTime)
  const address = new URL(endpoint.webSocketDebuggerUrl)
  assert.equal(address.hostname, '127.0.0.1')
  assert.equal(address.port, '9229')
  const socket = new WebSocket(address)
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  let next = 0
  const pending = new Map()
  socket.addEventListener('message', event => { const packet = JSON.parse(event.data); pending.get(packet.id)?.(packet) })
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++next
    const timer = globalThis.setTimeout(() => { pending.delete(id); reject(new Error('Owned inspector RPC timed out')) }, 15_000)
    pending.set(id, packet => { pending.delete(id); globalThis.clearTimeout(timer); packet.error ? reject(new Error(JSON.stringify(packet.error))) : resolve(packet.result) })
    socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  try {
    const identity = await evaluate('({pid:process.pid,executable:process.execPath,home:process.env.HOME,dshHome:process.env.DSH_HOME,argv:process.argv})')
    assert.deepEqual(identity, { pid, executable, home: actual.home, dshHome: actual.dshHome, argv: [executable] })
    const electron = "process.getBuiltinModule('module').createRequire(process.execPath)('electron')"
    const windows = await evaluate(`${electron}.webContents.getAllWebContents().map(window=>({id:window.id,url:window.getURL()}))`)
    const renderer = windows.find(window => window.url === 'dsh-app://app/')
    assert.ok(renderer, 'Owned alpha2 real public workspace renderer is missing')
    return { identity, renderer, birth, close: () => socket.close(),
      rpc: (method, args) => evaluate(`${electron}.webContents.fromId(${renderer.id}).executeJavaScript(${JSON.stringify(publicRpcSource(method, args))})`) }
  } catch (error) { socket.close(); throw error }
}

async function restoreAndBoot(root, path, transaction, manifest, ui, publicData) {
  const destination = join(root, 'restored-home')
  const verified = await execute(transaction.node, [transaction.workerPath, 'verify', path],
    { env: ui.env, timeout: 300_000, maxBuffer: 1024 ** 2 })
  assert.equal(JSON.parse(verified.stdout).verified, true)
  process.stderr.write('smoke: packaged backup verifier passed\n')
  const restored = await execute(transaction.node, [transaction.workerPath, 'restore', path, destination],
    { env: ui.env, timeout: 300_000, maxBuffer: 1024 ** 2 })
  const receipt = JSON.parse(restored.stdout)
  assert.equal(receipt.restored, true)
  process.stderr.write('smoke: packaged restore copied complete old data\n')
  for (const entry of manifest.roots) await verifyRoot(join(destination, relative(transaction.home, entry.source)), entry.entries)
  process.stderr.write('smoke: every restored entry independently verified before boot\n')
  const executable = await fs.realpath(join(destination, 'Applications/dsh-linux-desktop/current/dsh-workbench'))
  const metadata = await json(join(dirname(executable), 'resources/app/workbench/desktop.json'))
  assert.equal(metadata.version, '0.2.1-alpha.1')
  assert.equal(metadata.linuxRevision, 8)
  const environment = { ...ui.env, HOME: destination, DSH_HOME: join(destination, relative(transaction.home, transaction.dshHome)),
    XDG_CONFIG_HOME: join(destination, 'config'), XDG_DATA_HOME: join(destination, 'data'),
    XDG_CACHE_HOME: join(destination, 'cache'), XDG_STATE_HOME: join(destination, 'state'),
    XDG_RUNTIME_DIR: join(root, 'restored-runtime'), TMPDIR: join(root, 'restored-tmp'),
    DSH_DESKTOP_UPDATE_JOURNAL_DIR: join(root, 'restored-journal') }
  for (const name of ['XDG_RUNTIME_DIR', 'TMPDIR', 'DSH_DESKTOP_UPDATE_JOURNAL_DIR']) await fs.mkdir(environment[name], { mode: 0o700 })
  const actual = { home: destination, dshHome: environment.DSH_HOME, userData: join(destination, relative(transaction.home, transaction.userData)) }
  for (const base of [actual.dshHome, actual.userData]) assert.equal(await fs.readFile(join(base, 'whole-smoke-canary/epoch.txt'), 'utf8'), 'epoch=alpha1\n')
  const application = await playwright().launch({ executablePath: executable, env: environment, chromiumSandbox: true, timeout: 120_000 })
  try {
    const pid = application.process().pid
    const health = await healthyJournal(environment.DSH_DESKTOP_UPDATE_JOURNAL_DIR, pid, '0.2.1-alpha.1')
    process.stderr.write('smoke: real restored r8 Host became healthy\n')
    const observed = await application.evaluate(({ app }) => ({ home: app.getPath('home'), userData: app.getPath('userData'), dshHome: process.env.DSH_HOME }))
    assert.deepEqual(observed, actual)
    const runtime = await runtimeEvidence(pid, executable, actual, environment)
    let publicUserData
    if (publicData) {
      const page = await until(async () => application.windows().find(page => page.url() === 'dsh-app://app/'), 'Restored real public workspace renderer is missing')
      publicUserData = await readPublicUserData((method, args) => page.evaluate(publicRpcSource(method, args)), publicData, 'alpha1-baseline')
    }
    await application.firstWindow().then(page => page.screenshot({ path: join(root, 'restored-r8.png') }))
    return { ...receipt, completeTreeVerifiedBeforeBoot: true, metadata, runtime, health, canaryRestored: true, publicUserData }
  } finally { await application.close() }
}

async function migrate(root, ui, options) {
  const fault = options['--fault']
  if (fault === 'host-proc') assert.notEqual(process.pid, 1, 'The host-proc case must run outside the PID namespace')
  await seedData(ui.actual)
  const installation = join(ui.actual.home, 'Applications/dsh-linux-desktop')
  const oldCurrent = await fs.realpath(join(installation, 'current'))
  const backupRoot = join(ui.actual.home, 'Backups/dsh-workbench')
  const workerPath = join(dirname(ui.actual.executable), 'resources/app/lib/workbench-migration-worker.mjs')
  let writer, originalWorker, changed = false, newPid, publicFixture
  if (fault === 'worker') { originalWorker = await fs.readFile(workerPath); await fs.writeFile(workerPath, '') }
  if (fault === 'backup') execFileSync('mkfifo', ['-m', '600', join(ui.actual.dshHome, 'unsupported-fifo')], { env: ui.env })
  if (fault === 'writer') {
    writer = spawn(process.execPath, ['-e', "const fs=require('node:fs');fs.openSync(process.env.DSH_HOME+'/whole-smoke-canary/epoch.txt','r+');console.log('ready');setInterval(()=>{},1000)"],
      { env: ui.env, stdio: ['ignore', 'pipe', 'pipe'] })
    await new Promise((resolve, reject) => { writer.stdout.once('data', resolve); writer.once('error', reject) })
  }
  try {
    if (options['--user-data-fixture']) publicFixture = await preparePublicUserData(root, ui)
    await ui.application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
    let operationResult
    const operation = ui.updates.evaluate(() => window.workbenchUpdates.invoke('install', 'desktopUpgrade'))
      .catch(error => ({ closed: true, message: error.message }))
      .then(result => { operationResult = result; return result })
    const confirmation = await until(async () => {
      if (operationResult?.error) throw new Error(operationResult.error)
      for (const page of ui.application.windows()) {
        if (page === ui.updates) continue
        const button = page.getByRole('button', { name: /^(安装并重启|Install and Restart)$/u })
        if (await button.isVisible().catch(() => false)) return button
      }
      return false
    }, 'Real clean-stop restart confirmation was not produced', 240_000)
    const oldProcess = ui.process
    const helperIdentities = []
    const inspectedPids = process.pid === 1 ? (await fs.readdir('/proc')).filter(name => /^\d+$/u.test(name)).map(Number)
      : (await descendants(ui.pid)).map(identity => identity.pid)
    for (const pid of inspectedPids) helperIdentities.push(await processFacts(pid))
    await fs.writeFile(join(root, 'before-exit-processes.json'), JSON.stringify(helperIdentities.filter(Boolean)), { mode: 0o600 })
    const exited = new Promise(resolve => oldProcess.once('exit', (code, signal) => resolve({ code, signal })))
    const clicked = confirmation.click({ timeout: 15_000 }).catch(async error => {
      if (await alive(oldProcess.pid)) throw error
    })
    if (fault === 'worker') {
      await clicked
      const result = await operation
      assert.match(result.error ?? '', /worker size is invalid/u)
      assert.equal(await alive(ui.pid), true)
    } else {
      await Promise.race([clicked, exited])
      await until(async () => !await alive(oldProcess.pid), 'Original Electron did not actually exit')
      process.stderr.write('smoke: original Electron actually exited\n')
    }
    const directory = await until(async () => {
      if (!await exists(backupRoot)) return false
      const names = (await fs.readdir(backupRoot)).filter(name => /^[a-f0-9-]{36}$/u.test(name))
      return names.length === 1 ? join(backupRoot, names[0]) : false
    }, 'Real migration transaction directory was not produced')
    const path = join(directory, 'transaction.json')
    const terminal = await until(async () => {
      const report = await json(join(directory, 'report.json'))
      if (fault === 'source-change' && !changed && await exists(join(directory, 'backup.staging/dshHome/whole-smoke-canary/epoch.txt'))) {
        await fs.writeFile(join(ui.actual.dshHome, 'whole-smoke-canary/epoch.txt'), 'external-source-change\n'); changed = true
      }
      if (fault === 'post-start-failure' && report.newDesktopPid && !changed) {
        await fs.writeFile(join(ui.actual.dshHome, 'whole-smoke-canary/epoch.txt'), 'epoch=alpha2-migrated\n')
        process.kill(report.newDesktopPid, 'SIGKILL'); changed = true
      }
      return ['failed', 'healthy'].includes(report.phase) ? report : false
    }, 'Real worker did not reach an evidenced terminal phase', 300_000)
    newPid = terminal.newDesktopPid
    process.stderr.write(`smoke: actual worker reached ${terminal.phase}\n`)
    if (!fault && terminal.phase !== 'healthy') {
      const pid = /\/proc\/(\d+)\/fd/u.exec(terminal.error)?.[1]
      if (pid) {
        const before = await processFacts(Number(pid))
        await setTimeout(1_000)
        const after = await processFacts(Number(pid))
        await fs.writeFile(join(root, 'failed-helper-facts.json'), JSON.stringify({ before, after }), { mode: 0o600 })
      }
      throw new Error(`Actual migration stopped: ${terminal.error}`)
    }
    if (fault && fault !== 'post-start-failure') {
      assert.equal(terminal.phase, 'failed')
      assert.notEqual(terminal.activated, true)
      assert.equal(terminal.activatedAt, undefined)
      assert.equal(terminal.newDesktopPid, undefined)
      assert.equal(await fs.realpath(join(installation, 'current')), oldCurrent)
      const expected = { writer: new RegExp(`Data writer must be closed before migration: PID ${writer?.pid}\\b`, 'u'), backup: /Unsupported special backup file/u,
        worker: /worker size is invalid/u, 'source-change': /Source data changed|writer/u, 'host-proc': /EACCES.*\/proc\/\d+\/fd/u }
      assert.match(terminal.error, expected[fault])
      if (fault === 'source-change') assert.equal(changed, true, 'Actual source-change injection did not occur')
      assert.equal(await fs.readFile(join(ui.actual.dshHome, 'whole-smoke-canary/epoch.txt'), 'utf8'),
        fault === 'source-change' ? 'external-source-change\n' : 'epoch=alpha1\n')
      assert.equal(await fs.readFile(join(ui.actual.userData, 'whole-smoke-canary/epoch.txt'), 'utf8'), 'epoch=alpha1\n')
      let recoveredHealth, recoveredRuntime, procGate
      if (fault === 'host-proc') {
        const pid = Number(/\/proc\/(\d+)\/fd/u.exec(terminal.error)[1])
        const facts = await processFacts(pid)
        const failedPath = /'(\/proc\/\d+\/fd(?:\/\d+)?)'/u.exec(terminal.error)[1]
        const operation = /\/fd\/\d+$/u.test(failedPath) ? fs.readlink(failedPath) : fs.readdir(failedPath)
        await assert.rejects(operation, error => error.code === 'EACCES')
        procGate = { ownerPid: pid, identity: facts.identity, executable: facts.exe,
          uid: typeof facts.status === 'string' ? /^Uid:\s+(.+)$/mu.exec(facts.status)?.[1] : null,
          failedPath, deniedOperation: /\/fd\/\d+$/u.test(failedPath) ? 'readlink' : 'readdir',
          realFdReadDenied: true, gate: 'Every candidate owner FD must be inspectable; unreadable live owner aborts without activation' }
      }
      if (fault === 'worker') {
        recoveredHealth = await until(async () => {
          const records = await journals(ui.journal)
          return records.find(record => record.pid === ui.pid && record.event === 'workspace-ready'
            && Date.parse(record.time) > Date.parse(terminal.updatedAt)) ? records : false
        }, 'Original real Host did not recover after rejected worker admission')
        recoveredRuntime = await runtimeEvidence(ui.pid, ui.actual.executable, ui.actual, ui.env)
      }
      return { fault, report: terminal, writerPid: writer?.pid, actualSourceMutation: changed,
        oldCurrentUnchanged: true, activated: false, canaryEpochsPreserved: true, recoveredHealth, recoveredRuntime, procGate,
        parentStillAlive: fault === 'worker' ? true : undefined, ui: { actual: ui.actual, health: ui.health } }
    }
    const transaction = await json(path)
    assert.equal(transaction.parent.pid, ui.pid)
    assert.equal(await alive(transaction.parent.pid), undefined)
    assert.equal(transaction.dshHome, ui.actual.dshHome)
    assert.equal(transaction.userData, ui.actual.userData)
    assert.ok(Date.parse(terminal.originalExitObservedAt) <= Date.parse(terminal.backupVerifiedAt))
    assert.ok(Date.parse(terminal.backupVerifiedAt) <= Date.parse(terminal.activatedAt))
    const manifest = await json(join(directory, 'backup/manifest.json'))
    for (const entry of manifest.roots) await verifyRoot(join(directory, 'backup', entry.name), entry.entries)
    process.stderr.write('smoke: every backup entry independently verified\n')
    assert.equal(manifest.roots[0].source, ui.actual.dshHome)
    assert.equal(manifest.roots[1].source, ui.actual.userData)
    assert.equal(await fs.readFile(join(directory, 'backup/dshHome/whole-smoke-canary/epoch.txt'), 'utf8'), 'epoch=alpha1\n')
    const metadata = await json(join(installation, 'current/resources/app/workbench/desktop.json'))
    assert.equal(metadata.version, '0.2.1-alpha.2')
    assert.equal(metadata.linuxRevision, 2)
    assert.equal(metadata.dataEpoch, 'dsh-0.2.1-alpha.2')
    let health, runtime, publicUserData
    if (fault === 'post-start-failure') {
      assert.equal(terminal.phase, 'failed')
      assert.equal(terminal.activated, true)
      assert.match(terminal.recovery, /explicit whole-group restore/u)
      assert.equal(await fs.readFile(join(ui.actual.dshHome, 'whole-smoke-canary/epoch.txt'), 'utf8'), 'epoch=alpha2-migrated\n')
      assert.equal(await exists(join(backupRoot, '.migration-lock')), true)
    } else {
      assert.equal(terminal.phase, 'healthy')
      health = await healthyJournal(ui.journal, newPid, '0.2.1-alpha.2')
      runtime = await runtimeEvidence(newPid, terminal.executable, ui.actual, ui.env)
      assert.equal(runtime.host.nodeVersion, 'v24.21.0')
      assert.equal(await exists(join(backupRoot, '.migration-lock')), false)
      if (publicFixture) {
        const inspector = await attachOwnedPublicRenderer(newPid, terminal.executable, ui.actual)
        try {
          const upgraded = await readPublicUserData(inspector.rpc, publicFixture.old)
          publicUserData = { kind: 'public-metadata-history', old: publicFixture.old,
            upgraded: { ...upgraded, inspector: { identity: inspector.identity, renderer: inspector.renderer, birth: inspector.birth } },
            modelExecution: { performed: false, requests: publicFixture.requests } }
          await fs.writeFile(join(root, 'public-upgraded-user-data.json'), JSON.stringify(publicUserData), { mode: 0o600 })
        } finally { inspector.close() }
      }
    }
    await stopDesktop(newPid)
    newPid = undefined
    const recovery = await restoreAndBoot(root, path, transaction, manifest, ui, publicFixture?.old)
    process.stderr.write('smoke: complete old data restored and real r8 Host healthy\n')
    return { fault: fault ?? null, report: terminal, metadata, health, runtime, parentExitObserved: true,
      backupComplete: true, roots: manifest.roots.map(entry => ({ name: entry.name, source: entry.source,
        entries: entry.entries?.length ?? 0 })), recovery, publicUserData }
  } finally {
    if (publicFixture) { publicFixture.server.closeAllConnections(); await new Promise(resolve => publicFixture.server.close(resolve)) }
    if (writer && !writer.killed) writer.kill('SIGKILL')
    if (originalWorker) await fs.writeFile(workerPath, originalWorker)
    if (newPid && await alive(newPid)) await stopDesktop(newPid)
    if (await alive(ui.pid)) await ui.application.close().catch(() => undefined)
  }
}

async function corruptMappings(root, path, transaction, manifest, environment) {
  const manifestPath = join(dirname(path), 'backup/manifest.json')
  const original = await fs.readFile(manifestPath)
  await fs.writeFile(join(root, 'original-backup-manifest.json'), original, { flag: 'wx', mode: 0o600 })
  const outside = join(dirname(transaction.home), `outside-probe-${root.split('/').at(-1)}`)
  const guard = join(root, 'outside-probe')
  await fs.writeFile(outside, 'outside source remains unchanged\n', { flag: 'wx', mode: 0o600 })
  await fs.writeFile(guard, 'outside destination remains unchanged\n', { flag: 'wx', mode: 0o600 })
  const probes = [
    ['swapped-roles', value => { [value.roots[0].name, value.roots[1].name] = [value.roots[1].name, value.roots[0].name] }],
    ['outside-home', value => { value.roots[0].source = outside }],
    ['home-prefix-traversal', value => { value.roots[0].source = `${transaction.home}/../${outside.split('/').at(-1)}` }],
    ['unexpected-installation-path', value => { value.installation[0].path = outside }],
    ['installation-link-escape', value => { value.installation.find(entry => entry.path.endsWith('/current')).target = '../../../outside-probe' }],
  ]
  const results = []
  try {
    for (const [name, alter] of probes) {
      const value = structuredClone(manifest)
      alter(value)
      await fs.writeFile(manifestPath, JSON.stringify(value))
      const destination = join(root, `rejected-${name}`)
      for (const action of ['verify', 'restore']) {
        let failure, accepted
        try { accepted = await execute(transaction.node, [transaction.workerPath, action, path, ...(action === 'restore' ? [destination] : [])],
          { env: environment, timeout: 300_000, maxBuffer: 1024 ** 2 }) } catch (error) { failure = error }
        if (!failure) {
          results.push({ name, action, exitCode: 0, accepted: true, response: JSON.parse(accepted.stdout),
            destinationUntouched: !await exists(destination) })
          await fs.writeFile(join(root, 'corrupt-map-results.json'), JSON.stringify(results), { mode: 0o600 })
          continue
        }
        assert.ok(typeof failure.code === 'number' && failure.code !== 0)
        assert.match(failure.stderr, /mapping|canonical|unsafe|symlink|installation|root|backup/iu)
        assert.doesNotMatch(failure.stderr, /TypeError|ReferenceError|SyntaxError|ENOENT/u)
        assert.equal(await exists(destination), false, `Corrupt ${name} wrote a restore destination`)
        results.push({ name, action, exitCode: failure.code, error: failure.stderr.trim(), destinationUntouched: true })
        await fs.writeFile(join(root, 'corrupt-map-results.json'), JSON.stringify(results), { mode: 0o600 })
      }
      assert.equal(await fs.readFile(outside, 'utf8'), 'outside source remains unchanged\n')
      assert.equal(await fs.readFile(guard, 'utf8'), 'outside destination remains unchanged\n')
    }
  } finally { await fs.writeFile(manifestPath, original) }
  assert.deepEqual(await fs.readFile(manifestPath), original)
  const verified = await execute(transaction.node, [transaction.workerPath, 'verify', path],
    { env: environment, timeout: 300_000, maxBuffer: 1024 ** 2 })
  assert.equal(JSON.parse(verified.stdout).verified, true)
  const accepted = results.find(result => result.accepted)
  if (accepted) throw new Error(`Corrupt ${accepted.name} ${accepted.action} was accepted; real outcomes saved in corrupt-map-results.json`)
  return { cases: results, originalManifestBytesRestored: true, originalWholeBackupReverified: true }
}

async function resumeRestoration(root, path, identified, environment, corrupt) {
  assert.equal(await fs.realpath(path), path)
  const directory = dirname(path), transaction = await json(path)
  const originalRoot = dirname(transaction.home)
  assert.equal(directory, join(transaction.home, 'Backups/dsh-workbench', transaction.transactionId))
  assert.equal(transaction.release.asset.sha256, identified.find(artifact => artifact.kind === 'desktop').sha256)
  const bridge = identified.find(artifact => artifact.kind === 'bridge')
  assert.ok((await fs.realpath(transaction.node)).includes(`/versions/${bridge.sha256}/resources/`))
  assert.equal(await hashFile(transaction.workerPath), await hashFile(join(dirname(transaction.oldExecutable),
    'resources/app/lib/workbench-migration-worker.mjs')))
  const report = await json(join(directory, 'report.json'))
  assert.equal(report.phase, 'healthy', 'Resumption requires an actual previously healthy final transaction')
  const health = await healthyJournal(join(originalRoot, 'journal'), report.newDesktopPid, '0.2.1-alpha.2')
  const manifest = await json(join(directory, 'backup/manifest.json'))
  for (const entry of manifest.roots) await verifyRoot(join(directory, 'backup', entry.name), entry.entries)
  if (corrupt) return { transactionId: transaction.transactionId, originalRoot, archivedReport: report,
    corruption: await corruptMappings(root, path, transaction, manifest, environment) }
  const ui = { env: { ...environment, NODE_EXTRA_CA_CERTS: join(originalRoot, 'test-ca.crt'),
    DSH_WORKBENCH_UPDATE_CONFIG: join(originalRoot, 'test-updates.json') } }
  const recovery = await restoreAndBoot(root, path, transaction, manifest, ui)
  return { transactionId: transaction.transactionId, originalRoot, archivedReport: report,
    archivedNewHostHealth: health, archiveSha256: transaction.release.asset.sha256,
    backupComplete: true, recovery }
}

async function main(args) {
  const options = parseOptions(args)
  if (options['--help']) { process.stdout.write(usage); return }
  const artifacts = await verifyArtifacts(options)
  const before = await callerMetadata()
  const root = await fs.mkdtemp('/tmp/dsh-whole-desktop-smoke-')
  let transport
  try {
    const { environment, permissions } = await disposableEnvironment(root)
    if (!options['--preflight-only']) {
      const identified = archiveIdentities(artifacts, environment)
      if (options['--resume-transaction']) {
        const restoration = await resumeRestoration(root, options['--resume-transaction'], identified, environment, options['--corrupt-maps'])
        assert.deepEqual(await callerMetadata(), before, 'Caller runtime metadata changed during smoke')
        const receipt = { mode: options['--corrupt-maps'] ? 'corrupt-maps' : 'resume-restoration', root, artifacts: identified, restoration,
          protectedHome: process.env.DSH_SMOKE_PROTECTED_HOME, callerMetadataUnchanged: true }
        await fs.writeFile(join(root, 'whole-smoke-report.json'), JSON.stringify(receipt), { mode: 0o600 })
        process.stdout.write(JSON.stringify(receipt) + '\n')
        return
      }
      transport = await signedTransport(root, identified, environment)
      const bridge = await frozenBridge(root, identified, environment, transport)
      const ui = options['--bridge-only'] ? undefined : await launchBridge(root, bridge, environment, transport, options)
      const migration = ui && !ui.cancelled ? await migrate(root, ui, options) : undefined
      assert.deepEqual(await callerMetadata(), before, 'Caller runtime metadata changed during smoke')
      const receipt = { mode: migration ? 'whole-desktop' : ui ? 'cancel' : 'bridge-only', root, environment, permissions,
        artifacts: identified, bridge, ui: ui?.cancelled ? ui : undefined, migration, protectedHome: process.env.DSH_SMOKE_PROTECTED_HOME,
        callerMetadataUnchanged: true }
      await fs.writeFile(join(root, 'whole-smoke-report.json'), JSON.stringify(receipt), { mode: 0o600 })
      process.stdout.write(JSON.stringify(receipt) + '\n')
      return
    }
    assert.deepEqual(await callerMetadata(), before, 'Caller runtime metadata changed during smoke')
    process.stdout.write(JSON.stringify({ mode: 'preflight-only', root, environment, permissions, artifacts,
      protectedHome: process.env.DSH_SMOKE_PROTECTED_HOME, callerMetadataUnchanged: true }) + '\n')
  } finally {
    if (transport) {
      transport.server.closeAllConnections()
      await new Promise(resolve => transport.server.close(resolve))
    }
    const after = await callerMetadata()
    await fs.writeFile(join(root, 'home-guard.json'), JSON.stringify({ protectedHome: process.env.DSH_SMOKE_PROTECTED_HOME,
      before, after, callerMetadataUnchanged: JSON.stringify(before) === JSON.stringify(after) }), { mode: 0o600 })
    assert.deepEqual(after, before, 'Caller runtime metadata changed during smoke')
    if (!options['--keep']) await fs.rm(root, { recursive: true, force: true })
  }
}

await main(process.argv.slice(2)).catch(error => {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
})
