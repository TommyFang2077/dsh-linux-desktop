import { chmodSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
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
  buildNumber: String(desktop.linuxRevision),
  productName: 'dsh-workbench',
  artifactName: `dsh-workbench-\${version}-r${desktop.linuxRevision}-linux-x64.\${ext}`,
  directories: { output },
  afterPack: async context => {
    await config.afterPack(context)
    const workbench = join(context.appOutDir, 'resources/app/workbench')
    for (const file of ['desktop.json', 'updates.json']) JSON.parse(readFileSync(join(workbench, file), 'utf8'))
    hardenPermissions(context.appOutDir)
  },
  protocols: [],
  files: [
    ...config.files,
    'lib/workbench.mjs',
    'lib/workbench-archive.mjs',
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
    target: ['deb', 'rpm'],
    executableName: 'dsh-workbench',
    syncDesktopName: true,
    icon,
    category: 'Development',
    synopsis: 'Unofficial DeepSeek Harness Linux desktop',
    maintainer: 'dsh-workbench contributors',
  },
  deb: {
    compression: 'gz',
    fpm: ['--deb-compression-level', '1'],
    depends: [
      'libgtk-3-0 | libgtk-3-0t64', 'libnss3', 'libxss1', 'libxtst6', 'libgbm1',
      'libasound2 | libasound2t64', 'libatspi2.0-0 | libatspi2.0-0t64', 'xdg-utils', 'python3', 'pkexec', 'apt',
    ],
  },
  rpm: {
    compression: 'gzip',
    fpm: ['--rpm-rpmbuild-define', '_rpmformat 4', '--rpm-rpmbuild-define', '_smp_build_ncpus 2', '--rpm-compression-level', '1', '--log', 'info'],
    depends: ['gtk3', 'nss', 'libXScrnSaver', 'libXtst', 'libdrm', 'mesa-libgbm', 'alsa-lib', 'at-spi2-core', 'xdg-utils', 'python3', 'polkit', 'dnf'],
  },
  publish: null,
}
