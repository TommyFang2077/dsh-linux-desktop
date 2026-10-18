import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as fs from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import semver from 'semver'
import * as tar from 'tar'
import { startWholeDesktopUpgrade, startKernelMigration, validateKernelMigration } from './whole-desktop.mjs'

const MAX_DOWNLOAD = 1024 ** 3
const MAX_UNPACKED = 4 * 1024 ** 3
const MAX_FILES = 100_000
const CHANNELS = ['kernel', 'desktop']
const fail = message => { throw new Error(message) }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const validVersion = value => typeof value === 'string' && semver.valid(value) === value
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const range = value => typeof value === 'string' && value.length < 200 && semver.validRange(value) !== null
const satisfies = (version, constraint) => semver.satisfies(version, constraint, { includePrerelease: true })

export function httpsUrl(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) fail('更新地址必须为无凭据的 HTTPS URL')
  return url.href
}

/** The only trusted release metadata is an Ed25519-signed, bounded envelope. */
export function verifyFeed(envelope, publicKey, channel) {
  if (!CHANNELS.includes(channel) || !object(envelope) || typeof envelope.payload !== 'string'
    || envelope.payload.length > 128_000 || typeof envelope.signature !== 'string') fail('无效的更新签名封装')
  const key = createPublicKey(publicKey)
  const payload = Buffer.from(envelope.payload, 'base64')
  const signature = Buffer.from(envelope.signature, 'base64')
  if (key.asymmetricKeyType !== 'ed25519' || signature.length !== 64
    || !verify(null, payload, key, signature)) fail('更新签名校验失败')
  const release = JSON.parse(payload.toString('utf8'))
  if (!object(release) || release.schemaVersion !== (channel === 'kernel' ? 1 : 2) || release.channel !== channel
    || release.platform !== 'linux' || release.arch !== 'x64' || !validVersion(release.version)
    || !Number.isSafeInteger(release.protocol) || release.protocol < 1
    || typeof release.dataEpoch !== 'string' || !/^[a-zA-Z0-9._-]{1,80}$/.test(release.dataEpoch)
    || !range(release.desktopRange) || !range(release.nodeRange)) fail('更新元数据无效或平台不匹配')
  const assets = [release.asset]
  if (channel === 'desktop' && release.assets !== undefined) {
    if (!object(release.assets)) fail('桌面安装包列表无效')
    assets.push(release.assets.deb, release.assets.rpm)
  }
  if (channel === 'desktop' && release.format !== 'tar.gz') fail('不支持的用户桌面归档格式')
  for (const asset of assets) {
    if (!object(asset) || !digest(asset.sha256) || !Number.isSafeInteger(asset.size)
      || asset.size <= 0 || asset.size > MAX_DOWNLOAD) fail('更新文件大小或摘要无效')
    httpsUrl(asset.url)
  }
  if (channel === 'kernel' && !digest(release.manifestSha256)) fail('内核清单摘要无效')
  if (channel === 'desktop' && (!range(release.kernelRange) || !validVersion(release.nodeVersion)
    || !Number.isSafeInteger(release.linuxRevision) || release.linuxRevision < 1)) fail('桌面兼容信息或 Linux 构建号无效')
  return release
}

export function checkCompatibility(kernel, desktop) {
  if (kernel.protocol !== desktop.protocol || kernel.dataEpoch !== desktop.dataEpoch
    || !satisfies(desktop.version, kernel.desktopRange) || !satisfies(desktop.nodeVersion, kernel.nodeRange)) {
    fail('内核与桌面协议、数据格式或 Node 版本不兼容')
  }
}

/** The independently shipped runtime owns Node; the shell owns only the Host interface. */
export function checkKernelInterface(kernel, desktop) {
  if (kernel.protocol !== desktop.protocol || !satisfies(desktop.version, kernel.desktopRange)) {
    fail('内核与桌面协议或版本不兼容，请先更新桌面适配')
  }
}

export async function verifyKernelRuntime(root, release) {
  const metadata = JSON.parse(await fs.readFile(join(root, 'runtime/primary-runtime/runtime.json'), 'utf8'))
  if (metadata.platform !== 'linux' || metadata.arch !== 'x64' || !validVersion(metadata.node)
    || !satisfies(metadata.node, release.nodeRange)) fail('目标内核自带 Node 版本不兼容')
  const node = join(root, 'runtime/primary-runtime/dependencies/node/bin/node')
  const result = await promisify(execFile)(node, ['--version'], {
    env: { PATH: '/usr/bin:/bin' }, timeout: 15_000, maxBuffer: 1024,
  })
  if (result.stdout.trim() !== `v${metadata.node}`) fail('目标内核自带 Node 身份不匹配')
}

export async function fileHash(path) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest('hex')
}

function relativePath(value) {
  if (typeof value !== 'string' || value === '' || value.includes('\\') || value.includes('\0')
    || posix.isAbsolute(value) || value.split('/').some(part => part === '..' || part === '' || part === '.')) {
    fail('内核包包含不安全路径')
  }
  return value
}

/** Default inventory seals dsh and runtime; [''] inventories one complete desktop tree. */
export async function inventory(root, directories = ['dsh', 'runtime']) {
  const files = []
  async function walk(directory, prefix) {
    const directoryStat = await fs.lstat(directory)
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) fail('内核目录不能为链接或特殊文件')
    for (const name of (await fs.readdir(directory)).sort()) {
      const path = prefix ? `${prefix}/${name}` : name
      relativePath(path)
      const absolute = join(directory, name)
      const stat = await fs.lstat(absolute)
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) fail('内核树包含符号链接或特殊文件')
      if (stat.isDirectory()) await walk(absolute, path)
      else {
        if (files.length >= MAX_FILES) fail('内核文件数量超限')
        files.push({ path, size: stat.size, executable: Boolean(stat.mode & 0o111), sha256: await fileHash(absolute) })
      }
    }
  }
  for (const name of directories) await walk(join(root, name), name)
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}

export async function verifyKernelTree(root, release) {
  const manifestPath = join(root, 'kernel.json')
  const stat = await fs.lstat(manifestPath)
  if (!stat.isFile() || stat.size > 32 * 1024 ** 2) fail('内核清单无效或过大')
  const bytes = await fs.readFile(manifestPath)
  if (hash(bytes) !== release.manifestSha256) fail('内核清单被修改')
  const manifest = JSON.parse(bytes)
  for (const key of ['version', 'protocol', 'dataEpoch', 'desktopRange', 'nodeRange']) {
    if (manifest[key] !== release[key]) fail(`内核清单与签名不匹配：${key}`)
  }
  if (!Array.isArray(manifest.files) || JSON.stringify(await inventory(root)) !== JSON.stringify(manifest.files)) {
    fail('内核文件完整性校验失败')
  }
}

function archiveValidator(layout = 'kernel') {
  let bytes = 0, count = 0
  const paths = new Set()
  return entry => {
    const path = entry.path.replace(/^\.\//, '').replace(/\/$/, '')
    if (path === '' || path === '.') {
      if (entry.type !== 'Directory') fail('非法归档根目录')
      return
    }
    relativePath(path)
    if (!['File', 'Directory'].includes(entry.type) || paths.has(path)) fail('内核归档包含链接、特殊文件或重复路径')
    paths.add(path)
    const roots = layout === 'desktop' ? ['app'] : ['dsh', 'runtime', 'kernel.json']
    if (!roots.includes(path.split('/')[0])) fail('归档包含无关文件')
    const owner = entry.type === 'Directory' ? 0o700 : 0o600
    if (layout === 'desktop' && ((entry.mode & 0o7022) || (entry.mode & owner) !== owner)) fail('桌面归档包含不安全权限或不可写的用户文件')
    bytes += entry.size
    if (++count > MAX_FILES || bytes > MAX_UNPACKED) fail('内核解包大小超限')
  }
}

/** Node/test adapter; the Electron adapter runs the same bounded extractor in a child process. */
export async function extractKernel(archive, destination) {
  extractKernelSync(archive, destination)
}

/** Synchronous tar I/O is used only in the isolated worker to bound pending extraction buffers. */
export function extractKernelSync(archive, destination) {
  extractArchiveSync(archive, destination, 'kernel')
}

/** Desktop archives contain one app/ tree; kernel archives retain their original layout. */
export async function extractDesktop(archive, destination) {
  extractArchiveSync(archive, destination, 'desktop')
}

export function extractDesktopSync(archive, destination) {
  extractArchiveSync(archive, destination, 'desktop')
}

function extractArchiveSync(archive, destination, layout) {
  const inspect = archiveValidator(layout)
  tar.t({ file: archive, sync: true, strict: true, maxDecompressionRatio: 1000, onReadEntry: inspect })
  const inspectExtracted = archiveValidator(layout)
  let failure
  tar.x({ file: archive, cwd: destination, sync: true, strict: true, preservePaths: false, noMtime: true,
    maxDecompressionRatio: 1000, filter(_path, entry) {
      if (failure) return false
      try { inspectExtracted(entry); return true } catch (error) { failure = error; return false }
    },
  })
  if (failure) throw failure
}

export async function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}`
  const file = await fs.open(temporary, 'wx', 0o600)
  try { await file.writeFile(JSON.stringify(value) + '\n'); await file.sync() } finally { await file.close() }
  try {
    await fs.rename(temporary, path)
    const directory = await fs.open(dirname(path), 'r')
    try { await directory.sync() } finally { await directory.close() }
  } finally { await fs.rm(temporary, { force: true }) }
}

/** Separate channels share verification, never version state or installation destinations. */
export class UpdateManager {
  constructor({ root, config, desktop, bundled, migration, verifyKernel, probeKernel, onProgress, extract = extractKernel, fetch: transport = globalThis.fetch, signal }) {
    Object.assign(this, { root, config, desktop, bundled, migration, verifyKernel, probeKernel, onProgress, extract, fetch: transport, signal })
    this.candidates = {}
    this.latest = {}
    this.downloaded = {}
    this.busy = false
    this.state = { schemaVersion: 1, active: null, previous: null, pending: null }
    this.selected = bundled
    this.notice = ''
  }

  async boot() {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 })
    if ((await fs.lstat(this.root)).isSymbolicLink()) fail('更新目录不能为符号链接')
    await fs.chmod(this.root, 0o700)
    if ((await fs.stat(this.root)).mode & 0o077) fail('更新目录不支持私有 Unix 权限')
    try {
      const value = JSON.parse(await fs.readFile(join(this.root, 'state.json'), 'utf8'))
      if (!object(value) || value.schemaVersion !== 1 || ![null, 'staged', 'booting'].includes(value.pending)) fail('内核更新状态损坏')
      for (const ref of [value.active, value.previous]) if (ref !== null && !digest(ref)) fail('内核指针无效')
      this.state = value
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (this.state.pending === 'booting' && !this.state.migration) await this.rollback('上次新内核启动中断，已恢复原内核')
    if (this.state.active) {
      try {
        const selected = await this.readKernel(this.state.active, true)
        if (semver.gte(selected.version, this.bundled.version)) this.selected = selected
        if (this.state.pending === 'staged') {
          this.state.pending = 'booting'
          await this.save()
        }
      } catch (error) {
        if (!this.state.pending || this.state.migration) throw error
        await this.rollback(`新内核校验失败，已回滚：${error.message}`)
        if (this.state.active) this.selected = await this.readKernel(this.state.active, true)
      }
    }
    return this.selected
  }

  async readKernel(id, allowSuperseded = false) {
    if (!digest(id)) fail('内核标识无效')
    const directory = join(this.root, 'kernels', id)
    if ((await fs.lstat(directory)).isSymbolicLink()) fail('内核目录不能为符号链接')
    const envelope = JSON.parse(await fs.readFile(join(directory, 'release.json'), 'utf8'))
    const release = verifyFeed(envelope, this.source('kernel').publicKey, 'kernel')
    if (release.asset.sha256 !== id) fail('内核指针与摘要不一致')
    // A full desktop installation may supersede an older data epoch; never execute that old tree.
    if (allowSuperseded && release.dataEpoch !== this.desktop.dataEpoch
      && semver.lt(release.version, this.bundled.version)) {
      this.notice = '完整桌面已升级，使用自带内核；旧数据版本的内核文件保留，回退须恢复升级前数据备份'
      return this.bundled
    }
    if (this.state.migration) {
      if (this.state.dataEpoch !== release.dataEpoch) fail('内核迁移状态与签名数据纪元不匹配')
      const receipt = await validateKernelMigration({ ...this.migration, kernelRoot: this.root,
        migration: this.state.migration, receipt: this.state.migrationReceipt, release })
      if (receipt.phase === 'healthy' && this.state.pending) {
        this.state = { ...this.state, pending: null }
        await this.save()
      }
      checkKernelInterface(release, this.desktop)
    } else checkCompatibility(release, this.desktop)
    await verifyKernelTree(directory, release)
    if (this.state.migration) await verifyKernelRuntime(directory, release)
    await this.verifyKernel(join(directory, 'dsh'), release.version)
    return { ...release, dsh: join(directory, 'dsh'), runtime: join(directory, 'runtime'), id }
  }

  source(channel) {
    if (![...CHANNELS, 'desktopUpgrade'].includes(channel) || !object(this.config[channel])
      || typeof this.config[channel].publicKey !== 'string') fail('此更新通道未配置发布源和签名公钥')
    httpsUrl(this.config[channel].url)
    return this.config[channel]
  }

  get dataEpoch() { return this.state.migration && this.selected.id === this.state.active ? this.selected.dataEpoch : this.desktop.dataEpoch }

  validateKernelTarget(release) {
    if (this.desktop.followOfficial === true) checkKernelInterface(release, this.desktop)
    else checkCompatibility(release, this.desktop)
  }

  desktopAlreadyCovered(release) {
    return this.desktop.followOfficial === true && semver.gt(this.selected.version, this.desktop.version)
      && semver.lte(release.version, this.selected.version)
  }

  status() {
    return {
      downloaded: { ...this.downloaded },
      busy: this.busy, progress: this.progress ?? '', notice: this.notice, restartRequired: this.state.pending === 'staged',
      kernel: { version: this.selected.version, bundledVersion: this.bundled.version,
        followOfficial: this.desktop.followOfficial === true,
        available: this.candidates.kernel?.release.version ?? null, latest: this.latest.kernel?.version ?? null, configured: Boolean(this.config.kernel),
        crossEpoch: Boolean(this.latest.kernel) && this.latest.kernel.dataEpoch !== this.dataEpoch },
      desktop: { version: this.desktop.version, linuxRevision: this.desktop.linuxRevision ?? 0,
        available: this.candidates.desktop?.release.version ?? null,
        availableLinuxRevision: this.candidates.desktop?.release.linuxRevision ?? null,
        latest: this.latest.desktop?.version ?? null, latestLinuxRevision: this.latest.desktop?.linuxRevision ?? null,
        configured: Boolean(this.config.desktop),
        crossEpoch: Boolean(this.latest.desktop) && this.latest.desktop.dataEpoch !== this.dataEpoch },
      desktopUpgrade: { version: this.desktop.version, linuxRevision: this.desktop.linuxRevision ?? 0,
        available: this.candidates.desktopUpgrade?.release.version ?? null,
        availableLinuxRevision: this.candidates.desktopUpgrade?.release.linuxRevision ?? null,
        latest: this.latest.desktopUpgrade?.version ?? null,
        latestLinuxRevision: this.latest.desktopUpgrade?.linuxRevision ?? null,
        configured: Boolean(this.config.desktopUpgrade), handOff: this.wholeDesktopHandOff ?? null },
    }
  }

  step(message) { this.progress = message; this.onProgress?.(message) }

  async exclusive(operation) {
    if (this.busy) fail('更新操作正在进行中')
    this.busy = true
    try { return await operation() } finally { this.busy = false; this.progress = '' }
  }

  async response(url, timeout = 120_000) {
    let address = new URL(httpsUrl(url))
    const releasePath = /^\/([^/]+\/[^/]+)\/releases\/(?:latest\/download|download\/[^/]+)\/([^/]+)$/
    const github = address.host === 'github.com' && address.pathname.match(releasePath)
    const deadline = AbortSignal.timeout(timeout)
    const signal = this.signal ? AbortSignal.any([this.signal, deadline]) : deadline
    for (let redirects = 0; ; redirects++) {
      const manual = github && address.host === 'github.com'
      const response = await this.fetch(address.href, { redirect: manual ? 'manual' : 'error', signal })
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel()
        const location = response.headers.get('location')
        if (!manual || redirects >= 3 || !location) fail('更新下载重定向被拒绝或次数超限')
        const next = new URL(httpsUrl(new URL(location, address).href))
        const target = next.host === 'github.com' && next.pathname.match(releasePath)
        if (next.host !== 'release-assets.githubusercontent.com'
          && !(target && target[1] === github[1] && target[2] === github[2])) fail('更新下载重定向不属于原 GitHub Release')
        address = next
        continue
      }
      if (!response.ok || !response.body) fail(`更新下载失败：HTTP ${response.status}`)
      return response
    }
  }

  async check(channel) {
    return this.exclusive(async () => {
      delete this.candidates[channel]
      delete this.downloaded[channel]
      this.latest = { ...this.latest, [channel]: undefined }
      const source = this.source(channel)
      const response = await this.response(source.url)
      const chunks = []
      let size = 0
      for await (const chunk of response.body) {
        if ((size += chunk.length) > 128_000) fail('更新清单过大')
        chunks.push(chunk)
      }
      const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const release = verifyFeed(envelope, source.publicKey, channel)
      this.latest = { ...this.latest, [channel]: release }
      if (channel === 'desktop' && this.desktopAlreadyCovered(release)) return this.status()
      if (release.dataEpoch !== this.dataEpoch && !(channel === 'kernel' && this.desktop.followOfficial === true)) fail('新版本使用新的数据格式，普通更新不兼容；请使用「完整桌面升级」')
      if (channel === 'kernel') this.validateKernelTarget(release)
      else {
        checkCompatibility(this.selected, { version: release.version, protocol: release.protocol,
          dataEpoch: release.dataEpoch, nodeVersion: release.nodeVersion })
        if (!satisfies(this.selected.version, release.kernelRange)) fail('该桌面版本不支持当前内核，拒绝降级内核')
      }
      const current = channel === 'kernel' ? this.selected.version : this.desktop.version
      if (semver.gt(release.version, current) || (channel === 'desktop' && semver.eq(release.version, current)
        && release.linuxRevision > (this.desktop.linuxRevision ?? 0))) this.candidates[channel] = { release, envelope }
      return this.status()
    })
  }

  /** Explicit full-bundle candidate; ordinary check/install never cross protocol or data epochs. */
  async checkWholeDesktopUpgrade() {
    return this.exclusive(async () => {
      delete this.candidates.desktopUpgrade
      delete this.latest.desktopUpgrade
      const source = this.source('desktopUpgrade')
      const response = await this.response(source.url)
      const chunks = []
      let size = 0
      for await (const chunk of response.body) {
        if ((size += chunk.length) > 128_000) fail('更新清单过大')
        chunks.push(chunk)
      }
      const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const release = verifyFeed(envelope, source.publicKey, 'desktop')
      // This release brings its own runtime; matching the running kernel would defeat migration.
      if (!validVersion(release.electronVersion) || !satisfies(release.version, release.desktopRange)
        || !satisfies(release.version, release.kernelRange) || !satisfies(release.nodeVersion, release.nodeRange)) {
        fail('整包目标运行时元数据无效或不兼容')
      }
      this.latest.desktopUpgrade = release
      if (this.desktopAlreadyCovered(release)) return this.status()
      if (semver.gt(release.version, this.desktop.version) || (semver.eq(release.version, this.desktop.version)
        && release.linuxRevision > (this.desktop.linuxRevision ?? 0))) {
        this.candidates.desktopUpgrade = { release, envelope }
      }
      return this.status()
    })
  }

  async download(asset, destination, label = '正在下载') {
    this.step(label)
    // ponytail: ten-minute whole-transfer bound; use idle timeouts if slower links need support.
    const response = await this.response(asset.url, 600_000)
    const output = await fs.open(destination, 'wx', 0o600)
    const checksum = createHash('sha256')
    const mib = bytes => (bytes / 1024 ** 2).toFixed(0)
    let size = 0
    try {
      for await (const chunk of response.body) {
        if ((size += chunk.length) > asset.size) fail('下载文件超过签名声明的大小')
        this.progress = `${label}：${mib(size)} / ${mib(asset.size)} MiB（${Math.floor(size * 100 / asset.size)}%）`
        checksum.update(chunk)
        await output.writeFile(chunk)
      }
      await output.sync()
      if (size !== asset.size || checksum.digest('hex') !== asset.sha256) fail('下载文件摘要或大小不匹配')
    } finally { await output.close() }
  }

  validatedCandidate(channel) {
    const candidate = this.candidates[channel] ?? fail('请先检查更新')
    const release = verifyFeed(candidate.envelope, this.source(channel).publicKey, channel)
    if (JSON.stringify(release) !== JSON.stringify(candidate.release)) fail('更新目标已改变，请重新检查')
    if (channel === 'desktop' && this.desktopAlreadyCovered(release)) fail('当前桌面已适配此内核，无需更换桌面壳')
    if (release.dataEpoch !== this.dataEpoch && !(channel === 'kernel' && this.desktop.followOfficial === true)) fail('数据格式不兼容，拒绝普通更新')
    if (channel === 'kernel') this.validateKernelTarget(release)
    else {
      checkCompatibility(this.selected, { version: release.version, protocol: release.protocol,
        dataEpoch: release.dataEpoch, nodeVersion: release.nodeVersion })
      if (!satisfies(this.selected.version, release.kernelRange)) fail('该桌面版本不支持当前内核')
    }
    const current = channel === 'kernel' ? this.selected.version : this.desktop.version
    if (!semver.gt(release.version, current) && !(channel === 'desktop' && semver.eq(release.version, current)
      && release.linuxRevision > (this.desktop.linuxRevision ?? 0))) fail('更新目标已不再适用')
    return { release, envelope: candidate.envelope }
  }

  async validArchive(path, asset) {
    try {
      const stat = await fs.lstat(path)
      return stat.isFile() && !stat.isSymbolicLink() && stat.size === asset.size && await fileHash(path) === asset.sha256
    } catch (error) { if (error.code === 'ENOENT') return false; throw error }
  }

  async cachedArchive(channel, asset) {
    const directory = join(this.root, 'downloads')
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    const info = await fs.lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)) fail('下载缓存必须为私有目录')
    const path = join(directory, `${channel}-${asset.sha256}.tgz`)
    if (!await this.validArchive(path, asset)) {
      delete this.downloaded[channel]
      const temporary = join(directory, `.download-${randomUUID()}`)
      try {
        await this.download(asset, temporary)
        await fs.rename(temporary, path)
      } finally { await fs.rm(temporary, { force: true }) }
    }
    this.downloaded[channel] = asset.sha256
    for (const name of await fs.readdir(directory)) {
      if (name.startsWith(`${channel}-`) && /^[a-z]+-[a-f0-9]{64}\.tgz$/.test(name) && name !== `${channel}-${asset.sha256}.tgz`) {
        await fs.rm(join(directory, name), { force: true })
      }
    }
    return path
  }

  async prepareDownload(channel) {
    return this.exclusive(async () => {
      const { release } = this.validatedCandidate(channel)
      await this.cachedArchive(channel, release.asset)
      return this.status()
    })
  }

  async stageArchive(channel, asset, destination) {
    const cached = await this.cachedArchive(channel, asset)
    await fs.copyFile(cached, destination)
    if (!await this.validArchive(destination, asset)) fail('下载缓存已改变，请重新下载')
  }

  async installKernel(prepareRestart, restart) {
    return this.exclusive(async () => {
      const candidate = this.validatedCandidate('kernel')
      if (this.state.pending) fail('请先重启以完成待激活内核')
      const { release, envelope } = candidate
      if (release.dataEpoch !== this.dataEpoch) fail('跨数据格式内核升级必须先完成退出和备份事务')
      checkCompatibility(release, this.desktop)
      await fs.mkdir(join(this.root, 'kernels'), { recursive: true, mode: 0o700 })
      const staging = await fs.mkdtemp(join(this.root, '.kernel-'))
      const payload = join(staging, 'payload')
      try {
        await fs.mkdir(payload, { mode: 0o700 })
        await this.stageArchive('kernel', release.asset, join(staging, 'kernel.tgz'))
        this.step('正在检查归档并解包')
        await this.extract(join(staging, 'kernel.tgz'), payload)
        this.step('正在校验完整内核与配套运行时')
        await verifyKernelTree(payload, release)
        await this.verifyKernel(join(payload, 'dsh'), release.version)
        this.step('正在隔离环境中试启动新内核')
        await this.probeKernel({ dsh: join(payload, 'dsh'), runtime: join(payload, 'runtime') })
        const destination = join(this.root, 'kernels', release.asset.sha256)
        await atomicJson(join(payload, 'release.json'), envelope)
        try { await fs.rename(payload, destination) } catch (error) {
          if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error
          await this.readKernel(release.asset.sha256)
        }
        this.step('内核已通过验证，等待确认重启')
        if (!await prepareRestart()) return false
        const before = { ...this.state }
        try {
          this.state = { schemaVersion: 1, previous: this.state.active,
            active: release.asset.sha256, pending: 'staged' }
          await this.save()
          await restart()
          return true
        } catch (error) {
          this.state = before
          await this.save()
          throw error
        }
      } finally { await fs.rm(staging, { recursive: true, force: true }) }
    })
  }

  /** Crossing real data epochs keeps the shell and uses the existing offline backup worker. */
  async installKernelMigration(runtime, lifecycle) {
    return this.exclusive(async () => {
      if (this.state.pending) fail('请先完成待激活内核')
      const { release, envelope } = this.validatedCandidate('kernel')
      const directory = await fs.mkdtemp(join(this.root, '.kernel-migration-'))
      try {
        const archive = await this.cachedArchive('kernel', release.asset)
        const payload = join(directory, 'payload')
        await fs.mkdir(payload, { mode: 0o700 })
        await this.extract(archive, payload)
        await verifyKernelTree(payload, release)
        await verifyKernelRuntime(payload, release)
        await this.verifyKernel(join(payload, 'dsh'), release.version)
        this.step('正在隔离环境中试启动新内核')
        await this.probeKernel({ dsh: join(payload, 'dsh'), runtime: join(payload, 'runtime') })
        return await startKernelMigration({ ...runtime, archive, envelope,
          publicKey: this.source('kernel').publicKey, kernelRoot: this.root, desktop: this.desktop },
        { ...lifecycle, extractKernel: this.extract })
      } finally { await fs.rm(directory, { recursive: true, force: true }) }
    })
  }

  async installDesktop(prepareRestart, install, restart) {
    return this.exclusive(async () => {
      if (this.state.pending) fail('请先完成内核重启，再更新桌面端')
      const { release } = this.validatedCandidate('desktop')
      checkCompatibility(this.selected, { version: release.version, protocol: release.protocol,
        dataEpoch: release.dataEpoch, nodeVersion: release.nodeVersion })
      const directory = await fs.mkdtemp(join(this.root, '.desktop-'))
      try {
        const asset = release.asset
        const path = join(directory, 'desktop.tar.gz')
        await this.stageArchive('desktop', asset, path)
        this.step('正在校验并安装桌面更新')
        const result = await install({ archive: path, version: release.version, linuxRevision: release.linuxRevision, size: asset.size,
          sha256: asset.sha256, prepareRestart, restart })
        return result !== null
      } finally { await fs.rm(directory, { recursive: true, force: true }) }
    })
  }

  /** Download authenticated bytes, then hand off to the real exit/backup worker; never relaunch here. */
  async installWholeDesktopUpgrade(runtime, lifecycle) {
    return this.exclusive(async () => {
      if (this.state.pending) fail('请先完成内核重启，再升级整包桌面')
      const { envelope } = this.candidates.desktopUpgrade ?? fail('请先检查整包桌面升级')
      const publicKey = this.source('desktopUpgrade').publicKey
      const release = verifyFeed(envelope, publicKey, 'desktop')
      if (this.desktopAlreadyCovered(release)) fail('当前桌面已适配此内核，无需更换桌面壳')
      const directory = await fs.mkdtemp(join(this.root, '.whole-desktop-'))
      try {
        const archive = join(directory, 'desktop.tar.gz')
        await this.download(release.asset, archive, '正在下载完整桌面')
        this.step('正在解包并校验完整桌面')
        const result = await startWholeDesktopUpgrade({ ...runtime, archive, envelope, publicKey }, {
          ...lifecycle, onProgress: phase => { this.step(phase); lifecycle.onProgress?.(phase) },
        })
        if (result.kind === 'handed-off') this.wholeDesktopHandOff = result
        return result
      } finally { await fs.rm(directory, { recursive: true, force: true }) }
    })
  }

  async markHealthy() {
    if (this.state.migration) {
      const committed = JSON.parse(await fs.readFile(join(this.root, 'state.json'), 'utf8'))
      if (committed.active !== this.state.active || committed.migration !== this.state.migration
        || !committed.migrationReceipt) fail('内核健康状态缺少持久迁移回执')
      this.state = committed
    }
    if (this.state.pending === 'booting') { this.state.pending = null; await this.save() }
  }

  async rollback(message = '新内核启动失败，已恢复原内核') {
    if (!this.state.pending) return false
    if (this.state.migration) fail('新内核迁移未完成；已保留备份，必须恢复旧数据后才能回退内核')
    this.state = { schemaVersion: 1, active: this.state.previous, previous: null, pending: null }
    this.notice = message
    await this.save()
    this.selected = this.bundled
    if (this.state.active) {
      const previous = await this.readKernel(this.state.active, true)
      if (semver.gte(previous.version, this.bundled.version)) this.selected = previous
    }
    return true
  }

  save() { return atomicJson(join(this.root, 'state.json'), this.state) }
}
