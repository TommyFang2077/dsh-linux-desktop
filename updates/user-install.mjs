import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import semver from 'semver'
import { atomicJson, extractDesktop, fileHash, inventory } from './core.mjs'
import { readDesktopRuntime, verifyDesktopRuntime } from '../build/upstream/apps/desktop/src/runtime-tree.ts'

const fail = message => { throw new Error(message) }
const id = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const inside = (parent, path) => path.startsWith(parent + sep)
const markerName = 'installation.json'
export const defaultUserRoot = () => join(homedir(), 'Applications/dsh-linux-desktop')

async function exists(path) {
  try { await fs.lstat(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}

async function owned(path, directory = false) {
  const stat = await fs.lstat(path)
  if (stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o022)
    || !(directory ? stat.isDirectory() : stat.isFile())) fail('用户安装路径必须由当前用户所有，且不可被其他用户写入')
  return stat
}

async function readState(root) {
  const path = join(root, markerName)
  const info = await owned(path)
  if (info.size > 4096) fail('用户安装记录过大')
  const state = JSON.parse(await fs.readFile(path, 'utf8'))
  if (state?.schemaVersion !== 1 || state.kind !== 'dsh-linux-desktop'
    || ![state.current, state.previous].every(value => value === null || id(value))) fail('用户安装记录损坏')
  return state
}

async function linkVersion(root, name, value) {
  const path = join(root, name)
  if (await exists(path) && !(await fs.lstat(path)).isSymbolicLink()) fail('安装入口已被其他文件占用')
  if (value === null) { await fs.rm(path, { force: true }); return }
  const temporary = join(root, `.${name}-${randomUUID()}`)
  try {
    await fs.symlink(join('versions', value), temporary)
    await fs.rename(temporary, path)
  } finally { await fs.rm(temporary, { force: true }) }
}

async function activate(root, state) {
  await linkVersion(root, 'previous', state.previous)
  await linkVersion(root, 'current', state.current)
  await atomicJson(join(root, markerName), state)
}

async function userRoot(root, home) {
  root = resolve(root)
  home = await fs.realpath(home)
  if (process.getuid() === 0 || !inside(home, root)) fail('请以普通用户安装到 HOME 内，不要使用 sudo')
  let parent = root
  while (!await exists(parent)) parent = dirname(parent)
  const real = await fs.realpath(parent)
  if (real !== home && !inside(home, real)) fail('安装路径不能通过链接离开 HOME')
  if (await exists(root)) {
    await owned(root, true)
    if (!await exists(join(root, markerName)) && (await fs.readdir(root)).length) fail('目标目录包含非本安装器的文件')
  } else await fs.mkdir(root, { recursive: true, mode: 0o700 })
  await owned(root, true)
  return root
}

async function locked(root, action) {
  const lock = join(root, '.install-lock')
  // ponytail: one lock per install; after a crashed installer, remove this empty lock only after confirming it stopped.
  try { await fs.mkdir(lock, { mode: 0o700 }) } catch (error) {
    if (error.code === 'EEXIST') fail('已有用户安装操作，或上次安装中断留下锁目录')
    throw error
  }
  try { return await action() } finally { await fs.rmdir(lock) }
}

async function readJson(path) {
  const info = await fs.lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024 ** 2) fail('桌面归档元数据无效或过大')
  return JSON.parse(await fs.readFile(path, 'utf8'))
}

/** Validate the authenticated desktop identity and its existing sealed dsh runtime. */
export async function verifyUserDesktop(tree, version, linuxRevision) {
  if (typeof version !== 'string' || semver.valid(version) !== version) fail('桌面版本无效')
  const app = join(tree, 'resources/app')
  const pkg = await readJson(join(app, 'package.json'))
  const metadata = await readJson(join(app, 'workbench/desktop.json'))
  if (pkg?.name !== 'dsh-workbench' || ![undefined, 'dsh-workbench'].includes(pkg.productName)
    || pkg.version !== version || metadata?.version !== version) fail('桌面归档身份或版本不匹配')
  const revision = metadata.linuxRevision ?? 0
  if (!Number.isSafeInteger(revision) || revision < 0 || (pkg.linuxRevision ?? 0) !== revision
    || (linuxRevision !== undefined && linuxRevision !== revision)) fail('桌面 Linux 构建号不匹配')
  const primary = await readJson(join(tree, 'resources/runtime/primary-runtime/runtime.json'))
  await readJson(join(app, 'dsh/desktop-runtime.json'))
  const runtime = readDesktopRuntime(join(app, 'dsh'))
  if (primary?.platform !== 'linux' || primary.arch !== 'x64' || primary.node !== metadata.nodeVersion
    || semver.valid(metadata.nodeVersion) !== metadata.nodeVersion
    || !semver.satisfies(metadata.nodeVersion, metadata.nodeRange, { includePrerelease: true })
    || !semver.satisfies(version, metadata.desktopRange, { includePrerelease: true })
    || typeof metadata.dataEpoch !== 'string' || !/^[a-zA-Z0-9._-]{1,80}$/.test(metadata.dataEpoch)
    || runtime.release.hostProtocolVersion !== metadata.protocol
    || !semver.satisfies(runtime.release.version, metadata.kernelRange, { includePrerelease: true })) fail('桌面归档运行时不兼容')
  await owned(join(tree, 'dsh-workbench'))
  await fs.access(join(tree, 'dsh-workbench'), constants.X_OK)
  await fs.access(join(tree, 'resources/runtime/primary-runtime/dependencies/node/bin/node'), constants.X_OK)
  await verifyDesktopRuntime(join(app, 'dsh'), runtime.release.version, { platform: 'linux', arch: 'x64' })
  return metadata
}

function entryFiles(root, home, xdgDataHome) {
  const shell = value => "'" + value.replaceAll("'", "'\\''") + "'"
  const desktop = value => '"' + value.replace(/[\\"`$]/g, character => '\\' + character) + '"'
  if (/[\r\n%]/.test(root)) fail('安装路径包含不支持的启动入口字符')
  const launcher = `#!/bin/sh\n# dsh-linux-desktop user launcher\nexec ${shell(join(root, 'current/dsh-workbench'))} "$@"\n`
  const menu = `# dsh-linux-desktop user desktop entry\n[Desktop Entry]\nName=dsh-workbench\nExec=${desktop(join(home, '.local/bin/dsh-workbench'))} %U\nTerminal=false\nType=Application\nIcon=${join(root, 'current/resources/icon.png')}\nStartupWMClass=dsh-workbench\nComment=Unofficial user-installed DeepSeek Harness Linux desktop\nCategories=Development;\n`
  return [[join(home, '.local/bin/dsh-workbench'), launcher, 0o755],
    [join(xdgDataHome, 'applications/dsh-workbench.desktop'), menu, 0o644]]
}

async function protectedEntryParent(directory) {
  const info = await fs.lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()) fail('用户启动入口目录必须由当前用户所有')
  if (!(info.mode & 0o022)) return
  // A 0700 ancestor protects an existing 0775 ~/.local/bin without changing the user's directory modes.
  for (let parent = dirname(directory); parent !== dirname(parent); parent = dirname(parent)) {
    const stat = await fs.lstat(parent)
    if (stat.isSymbolicLink()) fail('用户启动入口不能经链接绕过目录保护')
    if (stat.isDirectory() && stat.uid === process.getuid() && !(stat.mode & 0o077)) return
  }
  fail('用户启动入口目录可被其他用户写入且没有私有上级目录保护')
}

async function checkEntries(entries) {
  for (const [path, content] of entries) {
    if (await exists(path)) {
      await owned(path)
      if (await fs.readFile(path, 'utf8') !== content) fail('用户启动入口已存在，拒绝覆盖其他命令或自定义配置')
    }
  }
}

/** Install already authenticated bytes into a private HOME prefix; only GUI callers provide restart hooks. */
export async function installUserDesktop({ archive, sha256, version, linuxRevision, root = defaultUserRoot(), home = homedir(),
  xdgDataHome = process.env.XDG_DATA_HOME ?? join(home, '.local/share'),
  extract = extractDesktop, prepareRestart = async () => true, restart }) {
  if (!id(sha256) || typeof version !== 'string' || semver.valid(version) !== version) fail('归档摘要或桌面版本无效')
  const archiveStat = await fs.lstat(archive)
  if (!archiveStat.isFile() || archiveStat.isSymbolicLink() || archiveStat.nlink !== 1
    || archiveStat.size < 1 || archiveStat.size > 1024 ** 3) fail('桌面归档必须为大小受限的普通文件')
  if (await fileHash(archive) !== sha256) fail('桌面归档 SHA-256 不匹配')
  root = await userRoot(root, home)
  const entries = entryFiles(root, resolve(home), resolve(xdgDataHome))
  return locked(root, async () => {
    await checkEntries(entries)
    const before = await exists(join(root, markerName)) ? await readState(root)
      : { schemaVersion: 1, kind: 'dsh-linux-desktop', current: null, previous: null }
    if (!await exists(join(root, markerName))) await atomicJson(join(root, markerName), before)
    const staging = await fs.mkdtemp(join(root, '.stage-'))
    const created = []
    try {
      await extract(archive, staging)
      const tree = join(staging, 'app')
      await verifyUserDesktop(tree, version, linuxRevision)
      if (await fileHash(archive) !== sha256) fail('校验后桌面归档发生改变')
      await fs.mkdir(join(root, 'versions'), { recursive: true, mode: 0o700 })
      await owned(join(root, 'versions'), true)
      const destination = join(root, 'versions', sha256)
      if (await exists(destination)) {
        await owned(destination, true)
        await verifyUserDesktop(destination, version, linuxRevision)
        if (JSON.stringify(await inventory(destination, [''])) !== JSON.stringify(await inventory(tree, ['']))) fail('已存在的桌面版本与认证归档不一致')
      } else await fs.rename(tree, destination)
      if (!await prepareRestart()) return null
      const next = { ...before, current: sha256, previous: before.current === sha256 ? before.previous : before.current }
      try {
        await activate(root, next)
        for (const [path, content, mode] of entries) {
          if (await exists(path)) continue
          await fs.mkdir(dirname(path), { recursive: true, mode: 0o755 })
          await protectedEntryParent(dirname(path))
          await fs.writeFile(path, content, { flag: 'wx', mode })
          created.push(path)
        }
        const executable = join(destination, 'dsh-workbench')
        if (restart) await restart(executable)
        return { root, version, executable }
      } catch (error) {
        await activate(root, before)
        for (const path of created) await fs.rm(path)
        throw error
      }
    } finally { await fs.rm(staging, { recursive: true, force: true }) }
  })
}

/** Detect the running managed user release, not an unrelated installed system package. */
export async function detectUserDesktop(executable) {
  const actual = await fs.realpath(executable)
  const release = dirname(actual)
  const root = dirname(dirname(release))
  if (dirname(release) !== join(root, 'versions') || !id(release.split(sep).at(-1))
    || !await exists(join(root, markerName))) return null
  await owned(root, true)
  const state = await readState(root)
  if (state.current !== release.split(sep).at(-1)
    || await fs.realpath(join(root, 'current/dsh-workbench')) !== actual) return null
  return { root, ...state }
}

/** Explicit manual rollback only; no watchdog is added around Electron startup. */
export async function rollbackUserDesktop({ root = defaultUserRoot(), home = homedir() } = {}) {
  if (!await exists(join(resolve(root), markerName))) fail('没有受管理的 HOME 桌面安装')
  root = await userRoot(root, home)
  return locked(root, async () => {
    const state = await readState(root)
    if (!state.previous) fail('没有可回退的用户桌面版本')
    await owned(join(root, 'versions'), true)
    const tree = join(root, 'versions', state.previous)
    await owned(tree, true)
    const pkg = await readJson(join(tree, 'resources/app/package.json'))
    await verifyUserDesktop(tree, pkg.version)
    await activate(root, { ...state, current: state.previous, previous: state.current })
    return join(tree, 'dsh-workbench')
  })
}
