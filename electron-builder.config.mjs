import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { createElectronBuilderConfig } from './build/upstream/apps/desktop/scripts/electron-builder-config.mjs'

const root = import.meta.dirname
const desktop = JSON.parse(readFileSync(join(root, 'desktop.json'), 'utf8'))
const officialVersion = JSON.parse(readFileSync(join(root, 'upstream.json'), 'utf8')).version
if (desktop.version !== officialVersion) throw new Error('desktop.json version must match the pinned official shell version')
if (!Number.isInteger(desktop.linuxRevision) || desktop.linuxRevision < 1) throw new Error('desktop.json linuxRevision must be a positive integer')
const output = process.env.DSH_WORKBENCH_OUTPUT ?? join(root, 'dist')
const icon = process.env.DSH_WORKBENCH_OUTPUT ? join(output, 'icon.png') : join(root, 'build/icon.png')
process.umask(0o022)

/** Keep owner-writable user files without privilege bits; reject NTFS staging. */
export function hardenPermissions(directory) {
  const paths = [directory, ...readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(entry => !entry.isSymbolicLink()).map(entry => join(entry.parentPath, entry.name))]
  for (const path of paths) {
    const stat = lstatSync(path)
    chmodSync(path, ((stat.mode & 0o777) | (stat.isDirectory() ? 0o700 : 0o600)) & ~0o022)
    if (lstatSync(path).mode & 0o022) throw new Error('Packaging requires a filesystem with Unix permissions')
  }
}

/** Materialize only the locked Linux Python aliases in the final deployment copy. */
export function materializePythonAliases(directory) {
  directory = resolve(directory)
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) {
    throw new Error('Desktop staging must be a physical directory')
  }
  const bin = join(directory, 'resources/runtime/primary-runtime/dependencies/python/bin')
  const interpreter = 'python3.12'
  const aliases = ['python', 'python3'].map(name => join(bin, name))
  const pending = [directory]
  while (pending.length) {
    for (const entry of readdirSync(pending.pop(), { withFileTypes: true })) {
      const path = join(entry.parentPath, entry.name)
      if (entry.isSymbolicLink()) {
        if (!aliases.includes(path)) throw new Error('Desktop staging contains an unsupported symbolic link: ' + relative(directory, path))
      } else if (entry.isDirectory()) pending.push(path)
      else if (!entry.isFile()) throw new Error('Desktop staging contains a special file: ' + relative(directory, path))
    }
  }
  const fd = openSync(join(bin, interpreter), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let bytes, mode
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || !(stat.mode & 0o111)) throw new Error('Desktop Python interpreter must be an executable regular file')
    bytes = readFileSync(fd)
    mode = stat.mode & 0o777
  } finally { closeSync(fd) }
  for (const path of aliases) {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) {
      if (readlinkSync(path) !== interpreter) throw new Error('Desktop Python alias must point directly to ' + interpreter)
    } else if (!stat.isFile() || !readFileSync(path).equals(bytes)) {
      throw new Error('Desktop Python alias does not match its interpreter')
    }
  }
  const temporary = mkdtempSync(join(bin, '.workbench-python-'))
  try {
    for (const path of aliases) {
      const file = join(temporary, relative(bin, path))
      writeFileSync(file, bytes, { flag: 'wx', mode })
      chmodSync(file, mode)
    }
    for (const path of aliases) renameSync(join(temporary, relative(bin, path)), path)
  } finally { rmSync(temporary, { recursive: true, force: true }) }
}

const config = createElectronBuilderConfig({
  ...process.env,
  DSH_DESKTOP_APP_ID: 'io.github.tommyfang.DshWorkbench',
  DSH_DESKTOP_TARGET_PLATFORM: 'linux',
  DSH_DESKTOP_TARGET_ARCH: 'x64',
})

export default {
  ...config,
  // Linux Office uses WASM workers; real paths avoid Electron 44 ASAR's missing-file stat bug.
  asar: false,
  electronVersion: desktop.electronVersion,
  buildNumber: String(desktop.linuxRevision),
  productName: 'dsh-workbench',
  artifactName: `dsh-workbench-\${version}-r${desktop.linuxRevision}-linux-x64.\${ext}`,
  directories: { output },
  afterPack: async context => {
    await config.afterPack(context)
    // The custom app replaces this default ASAR; old OTA workers require physical files.
    rmSync(join(context.appOutDir, 'resources/default_app.asar'), { force: true })
    if (readdirSync(context.appOutDir, { recursive: true }).some(path => path.endsWith('.asar'))) {
      throw new Error('Desktop staging contains ASAR files incompatible with shipped OTA workers')
    }
    const workbench = join(context.appOutDir, 'resources/app/workbench')
    for (const file of ['desktop.json', 'updates.json']) JSON.parse(readFileSync(join(workbench, file), 'utf8'))
    let migrationWorker
    try { migrationWorker = readFileSync(join(context.appOutDir, 'resources/app/lib/workbench-migration-worker.mjs')) }
    catch (error) { throw new Error('Desktop staging is missing its standalone migration worker', { cause: error }) }
    if (!migrationWorker.length) throw new Error('Desktop staging contains an empty migration worker')
    for (const file of ['lib/workbench-migration-progress.mjs', 'workbench/migration-progress.html',
      'workbench/migration-progress.js', 'workbench/migration-progress.css', 'workbench/migration-progress-preload.cjs']) {
      if (!readFileSync(join(context.appOutDir, 'resources/app', file)).length) throw new Error('Desktop staging contains an empty migration progress asset: ' + file)
    }
    materializePythonAliases(context.appOutDir)
    hardenPermissions(context.appOutDir)
  },
  protocols: [],
  files: [
    ...config.files,
    'lib/workbench.mjs',
    'lib/workbench-archive.mjs',
    'lib/workbench-migration-worker.mjs',
    'lib/workbench-migration-progress.mjs',
    { from: join(root, 'build/workbench-assets'), to: 'workbench', filter: ['**/*'] },
  ],
  extraMetadata: {
    ...config.extraMetadata,
    version: desktop.version,
    linuxRevision: desktop.linuxRevision,
    name: 'dsh-workbench',
    desktopName: 'dsh-workbench.desktop',
    description: 'Unofficial Linux desktop build of DeepSeek Harness',
    author: { name: 'dsh-workbench contributors' },
    homepage: 'https://github.com/deepseek-ai/deepseek-harness',
  },
  extraResources: [
    ...config.extraResources.map(resource => resource.to === 'icon.png'
      ? { from: join(root, 'build', 'icon.png'), to: 'icon.png' } : resource),
    { from: join(root, 'build/upstream/LICENSE'), to: 'licenses/DeepSeek-Harness.LICENSE' },
    { from: join(root, 'build/upstream/THIRD_PARTY_NOTICES.md'), to: 'licenses/THIRD_PARTY_NOTICES.md' },
    { from: join(root, 'LICENSE'), to: 'licenses/dsh-workbench.LICENSE' },
    { from: join(root, 'resources/dsh.ico'), to: 'icon.ico' },
  ],
  linux: {
    target: ['dir'],
    executableName: 'dsh-workbench',
    syncDesktopName: true,
    icon,
    category: 'Development',
    synopsis: 'Unofficial DeepSeek Harness Linux desktop',
    maintainer: 'dsh-workbench contributors',
  },
  publish: null,
}
