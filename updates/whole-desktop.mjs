import * as fs from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, resolve, dirname, sep, relative, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { atomicJson, checkKernelInterface, extractDesktop, extractKernel, fileHash, verifyFeed, verifyKernelTree, verifyKernelRuntime } from './core.mjs'
import { detectUserDesktop, installUserDesktop, verifyUserDesktop } from './user-install.mjs'
import { assertNoWriters, processIdentity, originalAlive, captureMigrationProcesses, stopMigrationProcesses } from './migration-processes.mjs'
import { readDesktopRuntime, verifyDesktopRuntime } from '../build/upstream/apps/desktop/src/runtime-tree.ts'

const fail = message => { throw new Error(message) }
const within = (root, path) => path === root || path.startsWith(root + sep)
const backupRoot = home => join(home, 'Backups/dsh-workbench')

async function privateDirectory(path) {
  await fs.mkdir(path, { recursive: true, mode: 0o700 })
  const info = await fs.lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()
    || (info.mode & 0o077)) fail(`Private migration directory required: ${path}`)
  return path
}

async function dataPath(home, path) {
  if (typeof path !== 'string' || resolve(path) !== path || !within(home, path) || path === home) fail('Migration paths must be absolute paths inside HOME')
  let parent = path
  while (true) {
    try {
      const actual = await fs.realpath(parent)
      if (actual !== parent) fail('Migration paths must be runtime-resolved, without linked ancestors')
      break
    } catch (error) { if (error.code !== 'ENOENT') throw error; parent = dirname(parent) }
  }
  return path
}

async function verifiedArchive(request, destination, kernelExtractor = extractKernel) {
  const channel = request.kind === 'kernel' ? 'kernel' : 'desktop'
  const release = verifyFeed(request.envelope, request.publicKey, channel)
  const info = await fs.lstat(request.archive)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== release.asset.size
    || await fileHash(request.archive) !== release.asset.sha256) fail('Signed desktop archive digest or size mismatch')
  await privateDirectory(destination)
  if (channel === 'kernel') {
    checkKernelInterface(release, request.desktop)
    await kernelExtractor(request.archive, destination)
    await verifyKernelTree(destination, release)
    await verifyKernelRuntime(destination, release)
    const runtime = await verifyDesktopRuntime(join(destination, 'dsh'), release.version, { platform: 'linux', arch: 'x64' })
    if (runtime.release.hostProtocolVersion !== release.protocol) fail('Signed kernel Host protocol mismatch')
    if (await fileHash(request.archive) !== release.asset.sha256) fail('Signed kernel archive changed during verification')
    return release
  }
  await extractDesktop(request.archive, destination)
  const metadata = await verifyUserDesktop(join(destination, 'app'), release.version, release.linuxRevision)
  for (const key of ['version', 'linuxRevision', 'protocol', 'dataEpoch', 'nodeVersion', 'nodeRange', 'desktopRange', 'kernelRange', 'electronVersion']) {
    if (metadata[key] !== release[key]) fail(`Signed desktop metadata mismatch: ${key}`)
  }
  const bundled = readDesktopRuntime(join(destination, 'app/resources/app/dsh')).release
  if (bundled.version !== release.version || bundled.hostProtocolVersion !== release.protocol) fail('Signed desktop and bundled official release do not match')
  if (await fileHash(request.archive) !== release.asset.sha256) fail('Signed desktop archive changed during verification')
  return release
}

async function report(transaction, phase, details = {}) {
  if (phase === 'failed') details = { failedPhase: transaction.report?.failedPhase ?? transaction.report?.phase, ...details }
  transaction.report = { ...transaction.report, ...details, schemaVersion: 1, transactionId: transaction.transactionId,
    phase, updatedAt: new Date().toISOString(),
    events: transaction.report?.phase === phase ? transaction.report.events
      : [...(transaction.report?.events ?? []), { phase, at: new Date().toISOString() }] }
  await atomicJson(join(transaction.directory, 'report.json'), transaction.report)
}

async function releaseGate(transaction) {
  const path = join(backupRoot(transaction.home), '.migration-lock')
  let owner
  try { owner = JSON.parse(await fs.readFile(join(path, 'owner.json'), 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return; throw error }
  if (owner.transactionId !== transaction.transactionId) fail('Migration admission gate ownership changed; refusing to remove it')
  await fs.rm(path, { recursive: true })
}

async function recordFailure(transaction, details) {
  try { await report(transaction, 'failed', details) }
  catch (error) { console.error(`Cannot write migration failure report: ${error.message}`) }
}

/** Called before opening data or starting a Host, including the worker's explicit new launch. */
export async function assertWholeDesktopStartupAllowed({ home, dshHome, userData, executable = process.execPath,
  transactionId = process.env.DSH_WHOLE_DESKTOP_TRANSACTION }) {
  let owner
  const gate = join(backupRoot(home), '.migration-lock')
  try { await fs.lstat(gate) }
  catch (error) { if (error.code === 'ENOENT') return; throw error }
  owner = JSON.parse(await fs.readFile(join(gate, 'owner.json'), 'utf8'))
  let status = JSON.parse(await fs.readFile(join(owner.directory, 'report.json'), 'utf8'))
  if (owner.transactionId === transactionId && ['spawned', 'healthy'].includes(status.phase)
    && await fs.realpath(executable) === status.executable
    && (!status.newDesktopPid || status.newDesktopPid === process.pid)) {
    // Wait for the spawn receipt before writing a terminal report from another process.
    for (let attempt = 0; !status.newDesktopPid && attempt < 100; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10))
      status = JSON.parse(await fs.readFile(join(owner.directory, 'report.json'), 'utf8'))
    }
    if (status.newDesktopPid === process.pid && ['spawned', 'healthy'].includes(status.phase)) {
      const transaction = await readTransaction(join(owner.directory, 'transaction.json'))
      if (dshHome !== transaction.dshHome || userData !== transaction.userData) {
        const error = 'Selected desktop data roots mismatch; the complete snapshot and new program are preserved for explicit recovery'
        await report(transaction, 'failed', { error, activated: true, actualRoots: { dshHome, userData } })
        fail(error)
      }
      return
    }
  }
  const error = new Error(`Desktop migration blocks startup; review ${join(owner.directory, 'report.json')}`)
  error.transactionPath = join(owner.directory, 'transaction.json')
  throw error
}

/** Only the target Desktop's existing real Host-health callback may release the admission gate. */
export async function markWholeDesktopHealthy({ home, version, executable, kernel, pid = process.pid,
  transactionId = process.env.DSH_WHOLE_DESKTOP_TRANSACTION }) {
  if (!transactionId) return
  const owner = JSON.parse(await fs.readFile(join(backupRoot(home), '.migration-lock/owner.json'), 'utf8'))
  if (owner.transactionId !== transactionId) fail('Healthy acknowledgement transaction mismatch')
  const transaction = await readTransaction(join(owner.directory, 'transaction.json'))
  for (let attempt = 0; !transaction.report.newDesktopPid && attempt < 100; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10))
    transaction.report = JSON.parse(await fs.readFile(join(transaction.directory, 'report.json'), 'utf8'))
  }
  const targetMatches = transaction.kind === 'kernel'
    ? kernel?.id === transaction.release.asset.sha256 && kernel.version === transaction.release.version
      && kernel.dataEpoch === transaction.release.dataEpoch
    : version === transaction.release.version
  if (pid !== process.pid || !targetMatches || transaction.report.newDesktopPid !== pid
    || transaction.report.phase !== 'spawned' || await fs.realpath(executable) !== transaction.report.executable) fail('Healthy acknowledgement is not from the selected desktop')
  if (transaction.kind === 'kernel') {
    const state = JSON.parse(await fs.readFile(join(transaction.kernelRoot, 'state.json'), 'utf8'))
    if (state.active !== kernel.id || state.migration !== transaction.transactionId || state.dataEpoch !== kernel.dataEpoch) fail('Kernel healthy acknowledgement pointer mismatch')
  }
  const healthyAt = new Date().toISOString()
  if (transaction.kind === 'kernel') {
    const statePath = join(transaction.kernelRoot, 'state.json')
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'))
    await atomicJson(statePath, { ...state, pending: null, migrationReceipt: { schemaVersion: 1,
      phase: 'healthy', transactionId, kernelId: kernel.id, version: kernel.version, dataEpoch: kernel.dataEpoch,
      backupVerifiedAt: transaction.report.backupVerifiedAt, healthyAt } })
  }
  await report(transaction, 'healthy', { healthyAt })
  await releaseGate(transaction)
  if (process.env.DSH_WHOLE_DESKTOP_TRANSACTION === transactionId) delete process.env.DSH_WHOLE_DESKTOP_TRANSACTION
}

/** Electron supplies only lifecycle adapters; signed bytes and the transaction stay in this module. */
export async function startWholeDesktopUpgrade(request, lifecycle) {
  verifyFeed(request.envelope, request.publicKey, request.kind === 'kernel' ? 'kernel' : 'desktop')
  const home = await fs.realpath(request.home)
  if (home !== resolve(request.home)) fail('HOME must be runtime-resolved')
  const roots = [request.dshHome, request.userData, request.root, backupRoot(home)]
  for (const path of roots) await dataPath(home, path)
  if (request.kind === 'kernel' && request.kernelRoot !== join(request.userData, 'updates')) fail('Kernel migration state must belong to the running userData')
  for (let i = 0; i < roots.length; i++) for (let j = i + 1; j < roots.length; j++) {
    if (within(roots[i], roots[j]) || within(roots[j], roots[i])) fail('Migration data, installation and backup roots must be disjoint')
  }
  const parent = join(home, 'Backups')
  await fs.mkdir(parent, { recursive: true, mode: 0o700 })
  const parentInfo = await fs.lstat(parent)
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || parentInfo.uid !== process.getuid()
    || (parentInfo.mode & 0o022)) fail('Backup parent must be a real user-owned directory without shared write permissions')
  await privateDirectory(backupRoot(home))
  const gate = join(backupRoot(home), '.migration-lock')
  try { await fs.mkdir(gate, { mode: 0o700 }) } catch (error) {
    if (error.code === 'EEXIST') fail('A desktop migration is active or requires explicit recovery')
    throw error
  }
  const transaction = { schemaVersion: 1, ...request, home, transactionId: randomUUID() }
  transaction.directory = join(backupRoot(home), transaction.transactionId)
  const candidate = join(transaction.directory, 'candidate')
  let prepared = false
  try {
    await privateDirectory(transaction.directory)
    await atomicJson(join(gate, 'owner.json'), { transactionId: transaction.transactionId, directory: transaction.directory })
    transaction.release = await verifiedArchive(request, candidate, lifecycle.extractKernel)
    transaction.installBytes = (await snapshot(request.kind === 'kernel' ? candidate : join(candidate, 'app'))).filter(entry => entry.type === 'file').reduce((total, entry) => total + entry.size, 0)
    transaction.archive = join(transaction.directory, request.kind === 'kernel' ? 'kernel.tar.gz' : 'desktop.tar.gz')
    await fs.copyFile(request.archive, transaction.archive, constants.COPYFILE_EXCL)
    await fs.chmod(transaction.archive, 0o600)
    if (await fileHash(transaction.archive) !== transaction.release.asset.sha256) fail('Transferred archive changed')
    transaction.parent = await processIdentity(process.pid)
    await report(transaction, 'prepared', { parent: transaction.parent })
    await atomicJson(join(transaction.directory, 'transaction.json'), transaction)
    transaction.shutdownProcesses = await captureMigrationProcesses(request)
    transaction.progressIdentity = await lifecycle.openProgress?.(join(transaction.directory, 'transaction.json'))
    prepared = true
    if (!await lifecycle.prepareRestart()) {
      prepared = false
      await report(transaction, 'cancelled')
      await releaseGate(transaction)
      return { kind: 'cancelled' }
    }
    transaction.parent = await processIdentity(process.pid)
    transaction.cleanStop = true
    const installed = await detectUserDesktop(request.oldExecutable)
    if (!installed || installed.root !== request.root) fail('Whole desktop migration requires the running managed HOME release')
    transaction.oldInstallation = installed
    transaction.oldExecutable = await fs.realpath(request.oldExecutable)
    const worker = await fs.readFile(request.workerPath)
    if (worker.length < 1 || worker.length > 32 * 1024 ** 2) fail('Bundled migration worker size is invalid')
    transaction.workerPath = join(transaction.directory, 'worker.mjs')
    await fs.writeFile(transaction.workerPath, worker, { flag: 'wx', mode: 0o600 })
    await atomicJson(join(transaction.directory, 'transaction.json'), transaction)
    await handoffWorker(transaction)
    lifecycle.onProgress?.('waiting-parent')
    lifecycle.quitWithoutRelaunch()
    return { kind: 'handed-off', transactionId: transaction.transactionId, reportPath: join(transaction.directory, 'report.json') }
  } catch (error) {
    await recordFailure(transaction, { error: error.message })
    try { await releaseGate(transaction) }
    catch (cleanupError) { await recordFailure(transaction, { fallbackError: `无法释放升级锁：${cleanupError.message}` }) }
    if (prepared) {
      try { await lifecycle.recover() }
      catch (recoveryError) {
        await recordFailure(transaction, { fallbackError: recoveryError.message })
      }
    }
    throw error
  } finally { await fs.rm(candidate, { recursive: true, force: true }) }
}

export function startKernelMigration(request, lifecycle) {
  return startWholeDesktopUpgrade({ ...request, kind: 'kernel' }, lifecycle)
}

/** A different data epoch is admitted only by this kernel's durable, verified migration receipt. */
export async function validateKernelMigration({ home, dshHome, userData, kernelRoot, migration, receipt, release }) {
  if (typeof home !== 'string' || !/^[a-f0-9-]{36}$/.test(migration ?? '')) fail('Kernel migration receipt is missing')
  if (receipt) {
    if (receipt.schemaVersion !== 1 || receipt.phase !== 'healthy' || receipt.transactionId !== migration
      || receipt.kernelId !== release.asset.sha256 || receipt.version !== release.version || receipt.dataEpoch !== release.dataEpoch
      || !Number.isFinite(Date.parse(receipt.backupVerifiedAt)) || !Number.isFinite(Date.parse(receipt.healthyAt))
      || Date.parse(receipt.backupVerifiedAt) > Date.parse(receipt.healthyAt)) fail('Invalid durable kernel migration receipt')
    await assertWholeDesktopStartupAllowed({ home, dshHome, userData })
    return receipt
  }
  const transaction = await readTransaction(join(backupRoot(home), migration, 'transaction.json'))
  const signed = verifyFeed(transaction.envelope, transaction.publicKey, 'kernel')
  if (transaction.kind !== 'kernel' || transaction.kernelRoot !== kernelRoot || transaction.userData !== userData
    || signed.asset.sha256 !== release.asset.sha256 || signed.version !== release.version || signed.dataEpoch !== release.dataEpoch
    || !transaction.report.backupVerifiedAt || !['spawned', 'healthy'].includes(transaction.report.phase)) fail('Kernel migration receipt does not authorize this data epoch')
  if (transaction.report.phase !== 'healthy' && (process.env.DSH_WHOLE_DESKTOP_TRANSACTION !== migration
    || transaction.report.newDesktopPid !== process.pid)) fail('Kernel migration requires the selected target process or explicit recovery')
  return transaction.report
}


async function handoffWorker(transaction) {
  const log = await fs.open(join(transaction.directory, 'worker.log'), 'a', 0o600)
  let child
  try {
    child = spawn(transaction.node, [transaction.workerPath, 'run', join(transaction.directory, 'transaction.json')], {
      detached: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }, stdio: ['ignore', log.fd, log.fd, 'ipc'],
    })
    let timer
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Migration worker READY timed out')), 15_000)
      child.once('error', reject)
      child.once('exit', code => reject(new Error(`Migration worker exited before READY: ${code}`)))
      child.on('message', message => {
        if (message?.type === 'ready' && message.transactionId === transaction.transactionId) { clearTimeout(timer); resolve() }
      })
    }).finally(() => clearTimeout(timer))
    await new Promise((resolve, reject) => child.send({ type: 'go', transactionId: transaction.transactionId }, error => error ? reject(error) : resolve()))
    child.unref()
    child.channel?.unref()
  } catch (error) { child?.kill(); throw error }
  finally { await log.close() }
}

async function readTransaction(path) {
  const info = await fs.lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) || info.size > 256_000) fail('Invalid private migration transaction')
  const transaction = JSON.parse(await fs.readFile(path, 'utf8'))
  if (transaction.schemaVersion !== 1 || !/^[a-f0-9-]{36}$/.test(transaction.transactionId)
    || transaction.directory !== dirname(resolve(path))
    || transaction.directory !== join(backupRoot(transaction.home), transaction.transactionId)) fail('Invalid migration transaction location')
  transaction.report = JSON.parse(await fs.readFile(join(transaction.directory, 'report.json'), 'utf8'))
  return transaction
}


async function snapshot(path) {
  const entries = []
  async function visit(absolute, name) {
    const info = await fs.lstat(absolute, { bigint: true })
    if (info.uid !== BigInt(process.getuid()) || (Number(info.mode) & 0o7000)) fail('Backup sources must be user-owned ordinary data without special permissions')
    const entry = { path: name, mode: Number(info.mode) & 0o777, mtimeNs: String(info.mtimeNs),
      ctimeNs: String(info.ctimeNs), inode: `${info.dev}:${info.ino}`, size: Number(info.size) }
    if (info.isSymbolicLink()) { entry.type = 'link'; entry.target = await fs.readlink(absolute) }
    else if (info.isDirectory()) {
      entry.type = 'directory'
      entries.push(entry)
      for (const child of (await fs.readdir(absolute)).sort()) await visit(join(absolute, child), name ? `${name}/${child}` : child)
      return
    } else if (info.isFile()) { entry.type = 'file'; entry.sha256 = await fileHash(absolute) }
    else fail(`Unsupported special backup file: ${absolute}`)
    entries.push(entry)
    if (entries.length > 200_000) fail('Backup inventory exceeds its bounded file limit')
  }
  try { await fs.lstat(path) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  await visit(path, '')
  if (entries[0]?.type !== 'directory') fail('Backup roots must be actual directories')
  if (entries[0].mode & 0o022) fail('Backup roots must have no shared write permissions')
  return entries
}

async function copySnapshot(source, destination, entries) {
  if (entries === null) return
  const links = new Map()
  for (const entry of entries) {
    const target = join(destination, entry.path)
    if (entry.type === 'directory') await fs.mkdir(target, { mode: 0o700 })
    else if (entry.type === 'link') await fs.symlink(entry.target, target)
    else {
      if (links.has(entry.inode)) await fs.link(links.get(entry.inode), target)
      else { await fs.copyFile(join(source, entry.path), target, constants.COPYFILE_EXCL); links.set(entry.inode, target) }
      await fs.chmod(target, entry.mode)
      const handle = await fs.open(target, 'r')
      try { await handle.sync() } finally { await handle.close() }
    }
  }
  for (const entry of [...entries].reverse()) {
    const target = join(destination, entry.path)
    if (entry.type === 'link') {
      await fs.lutimes(target, Number(entry.mtimeNs) / 1e9, Number(entry.mtimeNs) / 1e9)
      continue
    }
    await fs.chmod(target, entry.mode)
    await fs.utimes(target, Number(entry.mtimeNs) / 1e9, Number(entry.mtimeNs) / 1e9)
    if (entry.type === 'directory') {
      const handle = await fs.open(target, 'r')
      try { await handle.sync() } finally { await handle.close() }
    }
  }
}

function content(entries) {
  return entries?.map(({ path, mode, type, size, sha256, target }) => ({ path, mode, type, ...(type === 'file' ? { size, sha256 } : {}), ...(type === 'link' ? { target } : {}) })) ?? null
}

async function verifySnapshot(directory, manifest) {
  for (const root of manifest.roots) {
    const actual = await snapshot(join(directory, root.name))
    if (JSON.stringify(content(actual)) !== JSON.stringify(content(root.entries))) fail(`Backup verification failed: ${root.name}`)
    for (let index = 0; index < (root.entries?.length ?? 0); index++) {
      const delta = BigInt(actual[index].mtimeNs) - BigInt(root.entries[index].mtimeNs)
      if (delta > 2_000_000n || delta < -2_000_000n) fail(`Backup timestamp verification failed: ${root.name}/${root.entries[index].path}`)
    }
  }
}

function installationPaths(transaction) {
  return [join(transaction.root, 'installation.json'), join(transaction.root, 'current'), join(transaction.root, 'previous'),
    join(transaction.home, '.local/bin/dsh-workbench'), join(transaction.xdgDataHome, 'applications/dsh-workbench.desktop')]
}

async function captureInstallation(transaction) {
  const entries = []
  for (const path of installationPaths(transaction)) {
    try {
      const info = await fs.lstat(path)
      entries.push(info.isSymbolicLink() ? { path, type: 'link', target: await fs.readlink(path) }
        : { path, type: 'file', mode: info.mode & 0o777, text: await fs.readFile(path, 'utf8') })
    } catch (error) { if (error.code !== 'ENOENT') throw error; entries.push({ path, type: 'missing' }) }
  }
  return entries
}

async function activateKernel(transaction, prepareRestart) {
  const root = transaction.kernelRoot
  const staging = await fs.mkdtemp(join(transaction.directory, '.kernel-install-'))
  try {
    const release = await verifiedArchive(transaction, staging)
    await atomicJson(join(staging, 'release.json'), transaction.envelope)
    if (!await prepareRestart()) fail('Kernel migration cutover was refused')
    await privateDirectory(root)
    await privateDirectory(join(root, 'kernels'))
    const destination = join(root, 'kernels', release.asset.sha256)
    try { await fs.rename(staging, destination) } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error
      await verifyKernelTree(destination, release)
      const previous = verifyFeed(JSON.parse(await fs.readFile(join(destination, 'release.json'), 'utf8')), transaction.publicKey, 'kernel')
      if (JSON.stringify(previous) !== JSON.stringify(release)) fail('Existing kernel release metadata mismatch')
    }
    let previous = null
    try { previous = JSON.parse(await fs.readFile(join(root, 'state.json'), 'utf8')).active }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    try {
      await atomicJson(join(root, 'state.json'), { schemaVersion: 1, previous,
        active: release.asset.sha256, pending: 'staged', dataEpoch: release.dataEpoch, migration: transaction.transactionId })
    } catch (error) { error.activationUncertain = true; throw error }
    return { executable: transaction.oldExecutable }
  } finally { await fs.rm(staging, { recursive: true, force: true }) }
}

/** CLI boundary shared with the Electron handoff; no second mock-only backup path exists. */
export async function runWholeDesktopMigration(path) {
  const transaction = await readTransaction(path)
  let activated = false
  let parentExited = false
  try {
    if (!process.send || transaction.cleanStop !== true || !await originalAlive(transaction.parent)) fail('Worker requires the live original parent and a clean Host receipt')
    const owner = JSON.parse(await fs.readFile(join(backupRoot(transaction.home), '.migration-lock/owner.json'), 'utf8'))
    if (owner.transactionId !== transaction.transactionId) fail('Migration admission gate ownership changed')
    await report(transaction, 'ready', { parent: transaction.parent, worker: await processIdentity(process.pid) })
    process.send({ type: 'ready', transactionId: transaction.transactionId })
    await new Promise((resolve, reject) => {
      process.once('message', message => message?.type === 'go' && message.transactionId === transaction.transactionId ? resolve() : reject(new Error('Invalid worker handoff')))
      process.once('disconnect', () => reject(new Error('Parent disconnected before handoff')))
    })
    process.disconnect()
    await report(transaction, 'waiting-parent')
    const deadline = Date.now() + 30_000
    while (await originalAlive(transaction.parent)) {
      if (Date.now() >= deadline) fail('Original Electron did not actually exit before the backup deadline')
      const additional = await captureMigrationProcesses(transaction, [transaction.parent, ...(transaction.shutdownProcesses ?? [])])
      transaction.shutdownProcesses = [...(transaction.shutdownProcesses ?? []),
        ...additional.filter(item => !(transaction.shutdownProcesses ?? []).some(known => known.pid === item.pid && known.startTime === item.startTime))]
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    parentExited = true
    const roots = [transaction.dshHome, transaction.userData, dirname(transaction.oldExecutable)]
    const names = ['dshHome', 'userData', 'desktop']
    const installation = await captureInstallation(transaction)
    const state = JSON.parse(installation.find(entry => entry.path === join(transaction.root, 'installation.json')).text)
    if (state.previous && state.previous !== state.current) {
      roots.push(join(transaction.root, 'versions', state.previous))
      names.push('previousDesktop')
    }
    const stopKnown = () => stopMigrationProcesses(transaction, processActions => report(transaction, 'stopping-processes', {
      processActions: [...(transaction.report.processActions ?? []), ...processActions].slice(-100) }))
    await stopKnown()
    await report(transaction, 'backup', { originalExitObservedAt: new Date().toISOString() })
    // Unknown writers may finish on their own; they are never authorized for forced termination.
    const writerDeadline = Date.now() + 30_000
    while (true) {
      try { await assertNoWriters(roots); break }
      catch (error) {
        if (Date.now() >= writerDeadline) throw error
        await stopKnown()
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
    let manifest, inodes
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        ;({ manifest, inodes } = await createMigrationBackup(transaction, roots, names, installation))
        break
      } catch (error) {
        if (attempt === 2 || !(await stopKnown()).length) throw error
        await fs.rm(join(transaction.directory, 'backup.staging'), { recursive: true, force: true })
        await report(transaction, 'backup', { backupRetry: attempt + 1 })
      }
    }
    await report(transaction, 'installing')
    const release = verifyFeed(transaction.envelope, transaction.publicKey, transaction.kind === 'kernel' ? 'kernel' : 'desktop')
    const prepareRestart = async () => {
      await assertNoWriters(roots, inodes)
      for (const root of manifest.roots) if (JSON.stringify(await snapshot(root.source)) !== JSON.stringify(root.entries)) fail('Source data changed before cutover')
      return true
    }
    const result = transaction.kind === 'kernel'
      ? await activateKernel(transaction, prepareRestart)
      : await installUserDesktop({ archive: transaction.archive, sha256: release.asset.sha256,
        version: release.version, linuxRevision: release.linuxRevision, home: transaction.home, root: transaction.root,
        xdgDataHome: transaction.xdgDataHome, prepareRestart })
    activated = true
    await report(transaction, 'spawned', { activatedAt: new Date().toISOString(), spawnedAt: new Date().toISOString(), executable: result.executable })
    const log = await fs.open(join(transaction.directory, 'desktop.log'), 'a', 0o600)
    try {
      const env = { ...process.env, HOME: transaction.home, DSH_HOME: transaction.dshHome,
        ELECTRON_RUN_AS_NODE: undefined, DSH_WHOLE_DESKTOP_TRANSACTION: transaction.transactionId }
      const child = spawn(result.executable, [], { detached: true, env, stdio: ['ignore', log.fd, log.fd] })
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
      const identity = await processIdentity(child.pid).catch(error => {
        if (error.code !== 'ENOENT') throw error
        return { pid: child.pid, startTime: null, bootId: transaction.parent.bootId }
      })
      await report(transaction, 'spawned', { newDesktopPid: child.pid, newDesktopIdentity: identity })
      child.unref()
      const deadline = Date.now() + 60_000
      while (true) {
        transaction.report = JSON.parse(await fs.readFile(join(transaction.directory, 'report.json'), 'utf8'))
        if (transaction.report.phase === 'healthy') return
        if (transaction.report.phase === 'failed') fail(transaction.report.error)
        if (!await originalAlive(identity)) fail('Selected desktop exited without a real Host healthy acknowledgement')
        if (Date.now() >= deadline) fail('Selected desktop timed out without a real Host healthy acknowledgement')
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    } finally { await log.close() }
  } catch (error) {
    activated ||= error.activationUncertain === true
    await recordFailure(transaction, { error: error.message, activated,
      recovery: transaction.report.backupVerifiedAt
        ? `Preserved snapshot; explicit whole-group restore: ${transaction.node} ${transaction.workerPath} restore ${path} EMPTY_HOME`
        : '升级在切换前中止，原程序和源数据未更换。请保留报告，解决错误后重试。' })
    if (!activated) {
      try { await releaseGate(transaction) }
      catch (cleanupError) { await recordFailure(transaction, { fallbackError: `无法释放升级锁：${cleanupError.message}` }) }
    }
    if (!activated && parentExited) await reopenOriginalDesktop(transaction)
    throw error
  }
}

async function createMigrationBackup(transaction, roots, names, installation) {
  await report(transaction, 'backup')
  const manifest = { schemaVersion: 1, transactionId: transaction.transactionId, originalHome: transaction.home,
    installation, roots: [] }
  for (let i = 0; i < roots.length; i++) manifest.roots.push({ name: names[i], source: roots[i], entries: await snapshot(roots[i]) })
  assertRestorableDataLinks(manifest.roots, transaction.home)
  for (const entry of manifest.installation) if (entry.type === 'link') relocatedInstallationLink(entry, manifest.roots, transaction.home, transaction.home)
  const inodes = new Set(manifest.roots.flatMap(root => (root.entries ?? []).map(entry => entry.inode)))
  await assertNoWriters(roots, inodes)
  const bytes = manifest.roots.reduce((total, root) => total + (root.entries ?? []).filter(entry => entry.type === 'file').reduce((size, entry) => size + entry.size, 0), 0)
  const disk = await fs.statfs(transaction.directory, { bigint: true })
  const requiredFreeBytes = BigInt(bytes) + BigInt(transaction.installBytes) * 2n + BigInt(transaction.release.asset.size) + 64n * 1024n ** 2n
  if (disk.bavail * disk.bsize < requiredFreeBytes) fail('Insufficient free space for a complete verified backup and installation')
  const staging = join(transaction.directory, 'backup.staging')
  await privateDirectory(staging)
  for (const root of manifest.roots) await copySnapshot(root.source, join(staging, root.name), root.entries)
  await report(transaction, 'verifying-backup')
  await verifySnapshot(staging, manifest)
  await assertNoWriters(roots, inodes)
  for (const root of manifest.roots) {
    if (JSON.stringify(await snapshot(root.source)) !== JSON.stringify(root.entries)) fail('Source data changed during backup; desktop cutover stopped')
  }
  await atomicJson(join(staging, 'manifest.json'), manifest)
  await fs.rename(staging, join(transaction.directory, 'backup'))
  await report(transaction, 'backup-verified', { backupVerifiedAt: new Date().toISOString(), backupBytes: bytes,
    installBytes: transaction.installBytes, requiredFreeBytes: String(requiredFreeBytes) })
  return { manifest, inodes }
}

async function reopenOriginalDesktop(transaction) {
  try {
    const child = spawn(transaction.oldExecutable, [], { detached: true, stdio: 'ignore', env: { ...process.env,
      HOME: transaction.home, DSH_HOME: transaction.dshHome, ELECTRON_RUN_AS_NODE: undefined,
      DSH_WHOLE_DESKTOP_TRANSACTION: undefined, DSH_WHOLE_DESKTOP_FAILED: transaction.report.error,
      DSH_WHOLE_DESKTOP_REPORT: join(transaction.directory, 'transaction.json') } })
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
    let earlyExit
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 1_500)
      child.once('exit', (code, signal) => {
        clearTimeout(timer)
        earlyExit = `原版本重新打开后提前退出：${signal ?? code}`
        resolve()
      })
    })
    if (earlyExit) await recordFailure(transaction, { fallbackError: [transaction.report.fallbackError, earlyExit].filter(Boolean).join('\n') })
    child.unref()
  } catch (error) {
    await recordFailure(transaction, { fallbackError: [transaction.report.fallbackError, `无法重新打开原版本：${error.message}`].filter(Boolean).join('\n') })
  }
}

async function readBackup(transaction) {
  const directory = join(transaction.directory, 'backup')
  const file = join(directory, 'manifest.json')
  const info = await fs.lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)
    || info.size > 128 * 1024 ** 2) fail('Invalid private backup manifest')
  const manifest = JSON.parse(await fs.readFile(file, 'utf8'))
  if (manifest.schemaVersion !== 1 || manifest.transactionId !== transaction.transactionId
    || manifest.originalHome !== transaction.home || !Array.isArray(manifest.roots)
    || ![JSON.stringify(['dshHome', 'userData', 'desktop']), JSON.stringify(['dshHome', 'userData', 'desktop', 'previousDesktop'])]
      .includes(JSON.stringify(manifest.roots.map(root => root.name)))) fail('Backup root mapping is invalid')
  const canonicalHomePath = path => typeof path === 'string' && !path.includes('\0') && isAbsolute(path)
    && resolve(path) === path && within(transaction.home, path) && path !== transaction.home
  const paths = installationPaths(transaction)
  if (!Array.isArray(manifest.installation) || manifest.installation.length !== paths.length
    || manifest.installation.some((entry, index) => !canonicalHomePath(entry.path) || entry.path !== paths[index])) {
    fail('Installation backup mapping differs from its recorded paths')
  }
  let state
  try { state = JSON.parse(manifest.installation[0].text) }
  catch (error) { fail('Installation backup mapping contains invalid state JSON') }
  if (manifest.installation[0].type !== 'file' || state?.schemaVersion !== 1 || state.kind !== 'dsh-linux-desktop'
    || !/^[a-f0-9]{64}$/.test(state.current) || !(state.previous === null || /^[a-f0-9]{64}$/.test(state.previous))
    || transaction.oldInstallation?.root !== transaction.root
    || ['schemaVersion', 'kind', 'current', 'previous'].some(key => state[key] !== transaction.oldInstallation[key])
    || dirname(transaction.oldExecutable) !== join(transaction.root, 'versions', state.current)) {
    fail('Installation backup mapping differs from the recorded old release')
  }
  const current = manifest.installation.find(entry => entry.path === join(transaction.root, 'current'))
  if (current.type !== 'link' || typeof current.target !== 'string'
    || resolve(dirname(current.path), current.target) !== join(transaction.root, 'versions', state.current)) {
    fail('Installation current pointer mapping differs from the recorded old release')
  }
  const previous = manifest.installation.find(entry => entry.path === join(transaction.root, 'previous'))
  if (state.previous === null ? previous.type !== 'missing'
    : previous.type !== 'link' || typeof previous.target !== 'string'
      || resolve(dirname(previous.path), previous.target) !== join(transaction.root, 'versions', state.previous)) {
    fail('Installation previous pointer mapping differs from the recorded old release')
  }
  const sources = new Map([['dshHome', transaction.dshHome], ['userData', transaction.userData],
    ['desktop', join(transaction.root, 'versions', state.current)]])
  if (state.previous && state.previous !== state.current) sources.set('previousDesktop', join(transaction.root, 'versions', state.previous))
  if (manifest.roots.length !== sources.size) fail('Backup source mapping differs from its recorded root count')
  for (const root of manifest.roots) {
    if (!canonicalHomePath(root.source) || root.source !== sources.get(root.name)) fail('Backup source mapping differs from its recorded path')
    for (const entry of root.entries ?? []) {
      if (entry.path !== '' && (entry.path.includes('\0') || entry.path.startsWith('/')
        || entry.path.split('/').some(part => !part || part === '.' || part === '..'))) fail('Backup manifest contains an unsafe path')
    }
  }
  for (const entry of manifest.installation) if (entry.type === 'link') relocatedInstallationLink(entry, manifest.roots, transaction.home, transaction.home)
  await verifySnapshot(directory, manifest)
  return { directory, manifest }
}

export async function verifyWholeDesktopBackup(path) {
  const transaction = await readTransaction(path)
  const { manifest } = await readBackup(transaction)
  return { transactionId: transaction.transactionId, verified: true, roots: manifest.roots.map(root => ({ name: root.name, source: root.source, missing: root.entries === null })) }
}

function assertRestorableDataLinks(roots, home) {
  for (const root of roots) for (const entry of root.entries ?? []) {
    if (entry.type === 'link' && isAbsolute(entry.target) && within(home, resolve(entry.target))) {
      fail(`HOME-internal absolute data symlink requires explicit relocation: ${root.name}/${entry.path}`)
    }
  }
}

function relocatedInstallationLink(entry, roots, home, destinationHome) {
  const programs = roots.filter(root => ['desktop', 'previousDesktop'].includes(root.name) && root.entries !== null).map(root => root.source)
  const source = resolve(dirname(entry.path), entry.target)
  if (!within(home, source) || !programs.some(root => within(root, source))) {
    fail('Installation symbolic link is outside its backed-up program; explicit recovery mapping is required')
  }
  return isAbsolute(entry.target) ? join(destinationHome, relative(home, source)) : entry.target
}

/** Restore is explicit and only targets a new empty HOME: no running source is rolled back. */
export async function restoreWholeDesktopBackup(path, destinationHome) {
  const transaction = await readTransaction(path)
  const { directory, manifest } = await readBackup(transaction)
  destinationHome = resolve(destinationHome)
  if (within(transaction.home, destinationHome) || within(destinationHome, transaction.home)) fail('Restore HOME must be separate from the source HOME')
  assertRestorableDataLinks(manifest.roots, transaction.home)
  for (const entry of manifest.installation) if (entry.type === 'link') relocatedInstallationLink(entry, manifest.roots, transaction.home, destinationHome)
  await privateDirectory(destinationHome)
  if (await fs.realpath(destinationHome) !== destinationHome || (await fs.readdir(destinationHome)).length) fail('Restore requires an empty, real, private HOME directory')
  const roots = []
  try {
    for (const root of manifest.roots) {
      const target = await dataPath(destinationHome, join(destinationHome, relative(transaction.home, root.source)))
      if (root.entries !== null) {
        await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 })
        await copySnapshot(join(directory, root.name), target, root.entries)
        if (JSON.stringify(content(await snapshot(target))) !== JSON.stringify(content(root.entries))) fail(`Restored data failed verification: ${root.name}`)
      }
      roots.push({ name: root.name, path: target, missing: root.entries === null })
    }
    for (const entry of manifest.installation) {
      if (entry.type === 'missing') continue
      const target = await dataPath(destinationHome, join(destinationHome, relative(transaction.home, entry.path)))
      await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 })
      if (entry.type === 'link') await fs.symlink(relocatedInstallationLink(entry, manifest.roots, transaction.home, destinationHome), target)
      else await fs.writeFile(target, entry.text.replaceAll(transaction.home, destinationHome), { flag: 'wx', mode: entry.mode })
    }
    await atomicJson(join(destinationHome, 'whole-desktop-restored.json'), { schemaVersion: 1, transactionId: transaction.transactionId, roots })
    return { transactionId: transaction.transactionId, restored: true, destinationHome, roots }
  } catch (error) {
    await atomicJson(join(destinationHome, 'whole-desktop-restore-failed.json'), { transactionId: transaction.transactionId, error: error.message })
    throw error
  }
}
