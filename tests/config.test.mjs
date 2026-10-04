import assert from 'node:assert/strict'
import test from 'node:test'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { stripTypeScriptTypes } from 'node:module'
import config, { hardenPermissions } from '../electron-builder.config.mjs'
import { desktopTargetPlatform, resolveDesktopBuildTarget } from '../build/upstream/apps/desktop/scripts/desktop-build-paths.mjs'

test('Linux x64 packages use independent identity and no official updater', () => {
  assert.equal(resolveDesktopBuildTarget({}, 'linux', 'x64'), 'linux-x64')
  assert.deepEqual(desktopTargetPlatform('linux-x64'), { platform: 'linux', arch: 'x64' })
  assert.throws(() => resolveDesktopBuildTarget({}, 'linux', 'arm64'), /unsupported target/)
  assert.deepEqual(config.linux.target, ['deb', 'rpm'])
  assert.equal(config.linux.executableName, 'dsh-workbench')
  assert.equal(config.extraMetadata.name, 'dsh-workbench')
  assert.equal(config.extraMetadata.desktopName, 'dsh-workbench.desktop')
  assert.equal(config.linux.syncDesktopName, true)
  assert.equal(config.artifactName, 'dsh-workbench-${version}-x64.${ext}')
  assert.equal(config.appId, 'io.github.tommyfang.DshWorkbench')
  assert.equal(config.extraMetadata.dshMandatoryUpdatePolicy, undefined)
  assert.equal(config.publish, null)
  assert.equal(config.asar, false)
  assert.ok(config.deb.depends.includes('python3') && config.deb.depends.includes('pkexec'))
  assert.ok(config.rpm.depends.includes('python3') && config.rpm.depends.includes('polkit') && config.rpm.depends.includes('dnf'))
  assert.deepEqual(config.protocols, [])
  assert.deepEqual(config.rpm.fpm, ['--rpm-rpmbuild-define', '_rpmformat 4', '--rpm-rpmbuild-define', '_smp_build_ncpus 2', '--rpm-compression-level', '1', '--log', 'info'])
  assert.deepEqual(config.deb.fpm, ['--deb-compression-level', '1'])
})

test('Linux creates the shared tray with its PNG and the existing open/quit actions', () => {
  const main = readFileSync(new URL('../build/upstream/apps/desktop/src/main.ts', import.meta.url), 'utf8')
  const start = main.indexOf('  const trayIconPath =')
  const end = main.indexOf('  const backgroundNotice =', start)
  assert.ok(start >= 0 && end > start)
  const source = main.slice(start, end)
  assert.ok(config.extraResources.some(resource => resource.to === 'icon.png' && resource.from.endsWith('/build/icon.png')))
  for (const platform of ['linux', 'win32', 'darwin']) {
    for (const development of [false, true]) {
      let opened = 0, quit = 0
      const locale = () => ({ id: 'zh' })
      const tray = runInNewContext(`let tray; ${source}; tray`, {
        process: { platform, resourcesPath: '/packaged/resources' }, development, join,
        applicationIconPath: development ? '/source/resources/icon-windows.png' : '/packaged/resources/icon.png',
        app: { getAppPath: () => '/source', quit: () => { quit++ } },
        currentDesktopLocale: locale, focusPrimaryWindow: () => { opened++ },
        DesktopTray: class { constructor(options) { Object.assign(this, options) } },
        console: { warn: (...args) => assert.fail(args.join(' ')) },
      })
      if (platform === 'darwin') { assert.equal(tray, undefined); continue }
      assert.ok(tray, `${platform} must create a tray`)
      assert.equal(tray.iconPath, platform === 'linux'
        ? development ? '/source/resources/icon-windows.png' : '/packaged/resources/icon.png'
        : development ? '/source/resources/tray-windows.ico' : '/packaged/resources/tray.ico')
      assert.equal(tray.locale, locale)
      tray.open()
      tray.quit()
      assert.equal(opened, 1)
      assert.equal(quit, 1)
    }
  }
})

test('Linux removes the native application menu instead of hiding its labels', () => {
  const main = readFileSync(new URL('../build/upstream/apps/desktop/src/main.ts', import.meta.url), 'utf8')
  const start = main.indexOf('  const refreshApplicationMenu =')
  const end = main.indexOf('  const trayIconPath =', start)
  assert.ok(start >= 0 && end > start)
  let menu = 'not set'
  runInNewContext(stripTypeScriptTypes(main.slice(start, end)), {
    process: { platform: 'linux' },
    Menu: { setApplicationMenu: value => { menu = value }, buildFromTemplate: value => value },
    darwin: false, tray: undefined, app: { name: 'dsh-workbench' }, devToolsItems: [],
    currentDesktopLocale: () => ({ messages: { application: '应用' } }),
    applicationItems: () => [], platformMenus: () => [{ role: 'editMenu' }],
  })
  assert.equal(menu, null)
})

test('packaged modes reject group/other writes without following symlinks', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'dsh-permissions-'))
  try {
    const directory = join(temporary, 'application')
    mkdirSync(directory)
    const executable = join(directory, 'binary')
    const outside = join(temporary, 'outside')
    writeFileSync(executable, 'executable')
    writeFileSync(outside, 'outside')
    chmodSync(directory, 0o777)
    chmodSync(executable, 0o777)
    chmodSync(outside, 0o777)
    symlinkSync(outside, join(directory, 'link'))
    hardenPermissions(directory)
    assert.equal(lstatSync(directory).mode & 0o777, 0o755)
    assert.equal(lstatSync(executable).mode & 0o777, 0o755)
    assert.equal(lstatSync(outside).mode & 0o777, 0o777)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})
