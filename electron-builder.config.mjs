import { chmodSync, lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createElectronBuilderConfig } from './build/upstream/apps/desktop/scripts/electron-builder-config.mjs'

const root = import.meta.dirname
const output = process.env.DSH_WORKBENCH_OUTPUT ?? join(root, 'dist')
const icon = process.env.DSH_WORKBENCH_OUTPUT ? join(output, 'icon.png') : join(root, 'build/icon.png')
process.umask(0o022)

/** Strip writable group/other permissions without following symlinks; reject NTFS staging. */
export function hardenPermissions(directory) {
  const paths = [directory, ...readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(entry => !entry.isSymbolicLink()).map(entry => join(entry.parentPath, entry.name))]
  for (const path of paths) {
    chmodSync(path, (lstatSync(path).mode & 0o7777) & ~0o022)
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
  productName: 'dsh-workbench',
  artifactName: 'dsh-workbench-${version}-x64.${ext}',
  directories: { output },
  afterPack: async context => {
    await config.afterPack(context)
    hardenPermissions(context.appOutDir)
  },
  protocols: [],
  extraMetadata: {
    ...config.extraMetadata,
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
    depends: [
      'libgtk-3-0 | libgtk-3-0t64', 'libnss3', 'libxss1', 'libxtst6', 'libgbm1',
      'libasound2 | libasound2t64', 'libatspi2.0-0 | libatspi2.0-0t64', 'xdg-utils',
    ],
  },
  rpm: {
    fpm: ['--rpm-rpmbuild-define', '_rpmformat 4'],
    depends: ['gtk3', 'nss', 'libXScrnSaver', 'libXtst', 'libdrm', 'mesa-libgbm', 'alsa-lib', 'at-spi2-core', 'xdg-utils'],
  },
  publish: null,
}
