import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto'
import { createReadStream } from 'node:fs'
import * as fs from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import semver from 'semver'
import * as tar from 'tar'

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
  constructor({ root, config, desktop, bundled, verifyKernel, probeKernel, onProgress, extract = extractKernel, fetch: transport = globalThis.fetch }) {
    Object.assign(this, { root, config, desktop, bundled, verifyKernel, probeKernel, onProgress, extract, fetch: transport })
    this.candidates = {}
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
    if (this.state.pending === 'booting') await this.rollback('上次新内核启动中断，已恢复原内核')
    if (this.state.active) {
      try {
        const selected = await this.readKernel(this.state.active)
        if (semver.gte(selected.version, this.bundled.version)) this.selected = selected
        if (this.state.pending === 'staged') {
          this.state.pending = 'booting'
          await this.save()
        }
      } catch (error) {
        if (!this.state.pending) throw error
        await this.rollback(`新内核校验失败，已回滚：${error.message}`)
        if (this.state.active) this.selected = await this.readKernel(this.state.active)
      }
    }
    return this.selected
  }

  async readKernel(id) {
    if (!digest(id)) fail('内核标识无效')
    const directory = join(this.root, 'kernels', id)
    if ((await fs.lstat(directory)).isSymbolicLink()) fail('内核目录不能为符号链接')
    const envelope = JSON.parse(await fs.readFile(join(directory, 'release.json'), 'utf8'))
    const release = verifyFeed(envelope, this.source('kernel').publicKey, 'kernel')
    if (release.asset.sha256 !== id) fail('内核指针与摘要不一致')
    checkCompatibility(release, this.desktop)
    await verifyKernelTree(directory, release)
    await this.verifyKernel(join(directory, 'dsh'), release.version)
    return { ...release, dsh: join(directory, 'dsh'), runtime: join(directory, 'runtime'), id }
  }

  source(channel) {
    if (!CHANNELS.includes(channel) || !object(this.config[channel])
      || typeof this.config[channel].publicKey !== 'string') fail('此更新通道未配置发布源和签名公钥')
    httpsUrl(this.config[channel].url)
    return this.config[channel]
  }

  status() {
    return {
      busy: this.busy, progress: this.progress ?? '', notice: this.notice, restartRequired: this.state.pending === 'staged',
      kernel: { version: this.selected.version, bundledVersion: this.bundled.version,
        available: this.candidates.kernel?.release.version ?? null, configured: Boolean(this.config.kernel) },
      desktop: { version: this.desktop.version, linuxRevision: this.desktop.linuxRevision ?? 0,
        available: this.candidates.desktop?.release.version ?? null,
        availableLinuxRevision: this.candidates.desktop?.release.linuxRevision ?? null,
        configured: Boolean(this.config.desktop) },
    }
  }

  step(message) { this.progress = message; this.onProgress?.(message) }

  async exclusive(operation) {
    if (this.busy) fail('更新操作正在进行中')
    this.busy = true
    try { return await operation() } finally { this.busy = false; this.progress = '' }
  }

  async response(url) {
    let address = new URL(httpsUrl(url))
    const releasePath = /^\/([^/]+\/[^/]+)\/releases\/(?:latest\/download|download\/[^/]+)\/([^/]+)$/
    const github = address.host === 'github.com' && address.pathname.match(releasePath)
    const signal = AbortSignal.timeout(120_000)
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
      if (channel === 'kernel') checkCompatibility(release, this.desktop)
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

  async download(asset, destination) {
    const response = await this.response(asset.url)
    const output = await fs.open(destination, 'wx', 0o600)
    const checksum = createHash('sha256')
    let size = 0
    try {
      for await (const chunk of response.body) {
        if ((size += chunk.length) > asset.size) fail('下载文件超过签名声明的大小')
        checksum.update(chunk)
        await output.writeFile(chunk)
      }
      await output.sync()
      if (size !== asset.size || checksum.digest('hex') !== asset.sha256) fail('下载文件摘要或大小不匹配')
    } finally { await output.close() }
  }

  async installKernel(prepareRestart, restart) {
    return this.exclusive(async () => {
      const candidate = this.candidates.kernel ?? fail('请先检查内核更新')
      if (this.state.pending) fail('请先重启以完成待激活内核')
      const { release, envelope } = candidate
      checkCompatibility(release, this.desktop)
      await fs.mkdir(join(this.root, 'kernels'), { recursive: true, mode: 0o700 })
      const staging = await fs.mkdtemp(join(this.root, '.kernel-'))
      const payload = join(staging, 'payload')
      try {
        await fs.mkdir(payload, { mode: 0o700 })
        this.step('正在下载内核并校验摘要')
        await this.download(release.asset, join(staging, 'kernel.tgz'))
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

  async installDesktop(prepareRestart, install, restart, format = 'tar.gz') {
    return this.exclusive(async () => {
      if (this.state.pending) fail('请先完成内核重启，再更新桌面端')
      const { release } = this.candidates.desktop ?? fail('请先检查桌面更新')
      checkCompatibility(this.selected, { version: release.version, protocol: release.protocol,
        dataEpoch: release.dataEpoch, nodeVersion: release.nodeVersion })
      const directory = await fs.mkdtemp(join(this.root, '.desktop-'))
      try {
        if (!['tar.gz', 'deb', 'rpm'].includes(format)) fail('未知桌面安装格式')
        const asset = (format === 'tar.gz' ? release.asset : release.assets?.[format]) ?? fail('此发行缺少对应桌面安装包')
        const path = join(directory, `desktop.${format}`)
        await this.download(asset, path)
        const result = await install({ archive: path, version: release.version, linuxRevision: release.linuxRevision, format, size: asset.size,
          sha256: asset.sha256, prepareRestart, restart })
        return result !== null
      } finally { await fs.rm(directory, { recursive: true, force: true }) }
    })
  }

  async markHealthy() {
    if (this.state.pending === 'booting') { this.state.pending = null; await this.save() }
  }

  async rollback(message = '新内核启动失败，已恢复原内核') {
    if (!this.state.pending) return false
    this.state = { schemaVersion: 1, active: this.state.previous, previous: null, pending: null }
    this.notice = message
    await this.save()
    this.selected = this.bundled
    if (this.state.active) {
      const previous = await this.readKernel(this.state.active)
      if (semver.gte(previous.version, this.bundled.version)) this.selected = previous
    }
    return true
  }

  save() { return atomicJson(join(this.root, 'state.json'), this.state) }
}
