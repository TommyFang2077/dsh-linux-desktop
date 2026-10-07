import assert from 'node:assert/strict'
import test from 'node:test'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { stripTypeScriptTypes } from 'node:module'
import config, { hardenPermissions } from '../electron-builder.config.mjs'
import { desktopTargetPlatform, resolveDesktopBuildTarget } from '../build/upstream/apps/desktop/scripts/desktop-build-paths.mjs'

test('Linux x64 builds deb/rpm and keeps its independent identity with independent identity', () => {
  assert.equal(resolveDesktopBuildTarget({}, 'linux', 'x64'), 'linux-x64')
  assert.deepEqual(desktopTargetPlatform('linux-x64'), { platform: 'linux', arch: 'x64' })
  assert.throws(() => resolveDesktopBuildTarget({}, 'linux', 'arm64'), /unsupported target/)
  assert.deepEqual(config.linux.target, ['deb', 'rpm'])
  assert.equal(config.linux.executableName, 'dsh-workbench')
  assert.equal(config.extraMetadata.name, 'dsh-workbench')
  assert.equal(config.extraMetadata.desktopName, 'dsh-workbench.desktop')
  assert.equal(config.linux.syncDesktopName, true)
  assert.equal(config.artifactName, `dsh-workbench-\${version}-r${config.extraMetadata.linuxRevision}-linux-x64.\${ext}`)
  assert.equal(config.extraMetadata.version, JSON.parse(readFileSync(new URL('../upstream.json', import.meta.url), 'utf8')).version)
  assert.equal(config.extraMetadata.linuxRevision, JSON.parse(readFileSync(new URL('../desktop.json', import.meta.url), 'utf8')).linuxRevision)
  assert.equal(config.buildNumber, String(config.extraMetadata.linuxRevision))
  assert.equal(config.appId, 'io.github.tommyfang.DshWorkbench')
  assert.equal(config.extraMetadata.dshMandatoryUpdatePolicy, undefined)
  assert.equal(config.publish, null)
  assert.equal(config.asar, false)
  assert.ok(config.deb.depends.includes('pkexec'))
  assert.ok(config.rpm.depends.includes('dnf'))
  assert.deepEqual(config.protocols, [])
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

test('normal, selected and candidate Linux Hosts use the Node from their own payload', async () => {
  const main = readFileSync(new URL('../build/upstream/apps/desktop/src/main.ts', import.meta.url), 'utf8')
  const resourcesSource = main.slice(main.indexOf('async function runtimeResources('), main.indexOf('/** Check a candidate Host'))
  const probeSource = main.slice(main.indexOf('async function probeWorkbenchKernel('), main.indexOf('function developmentPrimaryRuntime('))
  assert.ok(resourcesSource && probeSource)
  const calls = []
  const context = {
    join, dirname: path => join(path, '..'), AbortController, URL, setTimeout, clearTimeout,
    process: { execPath: '/shell/electron', resourcesPath: '/bundled/resources', platform: 'linux', env: {} },
    app: { isPackaged: true, getAppPath: () => '/bundled/app', getPath: () => '/tmp' },
    selectedKernel: undefined,
    developmentPrimaryRuntime: () => '/development/primary-runtime',
    resolveDesktopHostNode: async (primary, electron) => {
      assert.equal(electron, '/shell/electron')
      calls.push(primary)
      return join(primary, 'dependencies/node/bin/node')
    },
    readDesktopRuntime: () => ({ release: { version: '1.0.0' } }),
    mkdtemp: async () => '/isolated/probe', rm: async () => {},
    resolveDesktopPaths: home => ({ profile: join(home, 'profiles/desktop') }),
    DesktopProjectManager: class { async applyRelease() {} },
    DesktopHostUncleanExitError: class extends Error {},
    DesktopHostProcess: class {
      constructor(node, _dsh, _profile, _inspect, _environment, _failure, primary) {
        assert.equal(node, join('/candidate/runtime/primary-runtime', 'dependencies/node/bin/node'))
        assert.equal(primary, '/candidate/runtime/primary-runtime')
      }
      async start() { return { url: 'http://127.0.0.1:3080/', injections: [] } }
      async stop(graceful) { assert.equal(graceful, true) }
    },
    fetch: async () => ({ ok: true, headers: { getSetCookie: () => [], get: () => 'text/html' } }),
  }
  const resources = runInNewContext(stripTypeScriptTypes(`${resourcesSource}; runtimeResources`), context)
  assert.equal((await resources()).node, '/bundled/resources/runtime/primary-runtime/dependencies/node/bin/node')
  context.app.isPackaged = false
  assert.equal((await resources()).node, '/development/primary-runtime/dependencies/node/bin/node')
  context.selectedKernel = { dsh: '/selected/dsh', runtime: '/selected/runtime' }
  assert.equal((await resources()).node, '/selected/runtime/primary-runtime/dependencies/node/bin/node')
  const probe = runInNewContext(stripTypeScriptTypes(`${probeSource}; probeWorkbenchKernel`), context)
  await probe({ dsh: '/candidate/dsh', runtime: '/candidate/runtime' })
  assert.deepEqual(calls, ['/bundled/resources/runtime/primary-runtime', '/development/primary-runtime',
    '/selected/runtime/primary-runtime', '/candidate/runtime/primary-runtime'])
})

test('packaged modes reject group/other writes without following symlinks', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'dsh-permissions-'))
  try {
    const directory = join(temporary, 'application')
    mkdirSync(directory)
    const executable = join(directory, 'binary')
    const outside = join(temporary, 'outside')
    const readonly = join(directory, 'readonly')
    const privileged = join(directory, 'privileged')
    writeFileSync(executable, 'executable')
    writeFileSync(outside, 'outside')
    writeFileSync(readonly, 'readonly')
    writeFileSync(privileged, 'privileged')
    chmodSync(readonly, 0o444)
    chmodSync(privileged, 0o4755)
    chmodSync(directory, 0o777)
    chmodSync(executable, 0o777)
    chmodSync(outside, 0o777)
    symlinkSync(outside, join(directory, 'link'))
    hardenPermissions(directory)
    assert.equal(lstatSync(directory).mode & 0o777, 0o755)
    assert.equal(lstatSync(executable).mode & 0o777, 0o755)
    assert.equal(lstatSync(readonly).mode & 0o777, 0o644)
    assert.equal(lstatSync(privileged).mode & 0o7777, 0o755)
    assert.equal(lstatSync(outside).mode & 0o777, 0o777)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})
