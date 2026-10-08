import assert from 'node:assert/strict'
import test from 'node:test'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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

test('Linux pins the tested Electron runtime without changing the official shell version', () => {
  const desktop = JSON.parse(readFileSync(new URL('../desktop.json', import.meta.url), 'utf8'))
  assert.equal(desktop.electronVersion, '44.5.1')
  assert.equal(config.electronVersion, desktop.electronVersion)
  const prepare = readFileSync(new URL('../build/upstream/apps/desktop/scripts/prepare-runtime.ts', import.meta.url), 'utf8')
  const start = prepare.indexOf('  const { version: packageVersion }')
  const end = prepare.indexOf('  const archive =', start)
  assert.ok(start >= 0 && end > start)
  const source = stripTypeScriptTypes(prepare.slice(start, end))
  const select = (platform, electronVersion) => runInNewContext(`${source}; version`, {
    platform, process: { env: { DSH_DESKTOP_ELECTRON_VERSION: electronVersion } },
    require: () => ({ version: '44.0.0' }),
  })
  assert.equal(select('linux', desktop.electronVersion), desktop.electronVersion)
  for (const platform of ['darwin', 'win32']) assert.equal(select(platform, desktop.electronVersion), '44.0.0')
  for (const value of [undefined, '', '44.5.1/evil', '43.0.0']) {
    assert.throws(() => select('linux', value), /Electron version/)
  }
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

test('tray smoke requires the running process and exact object path in the watcher', async () => {
  const smoke = readFileSync(new URL('../scripts/gui-smoke.mjs', import.meta.url), 'utf8')
  const start = smoke.indexOf('async function verifyTrayRegistration(')
  const end = smoke.indexOf('\nconst root =', start)
  assert.ok(start >= 0 && end > start, 'GUI smoke needs an opt-in real watcher check')
  assert.match(smoke, /process\.argv\.includes\('--tray'\)/)
  const check = items => runInNewContext(`${smoke.slice(start, end)}; verifyTrayRegistration`, {
    assert, setTimeout: async () => {},
    execFileSync: (_file, args) => {
      assert.ok(args.includes('--session'))
      if (args.includes('org.freedesktop.DBus.GetNameOwner')) {
        assert.equal(args.at(-1), 'org.freedesktop.StatusNotifierItem-1234-1')
        return "(':1.99',)"
      }
      return items
    },
  })(1234)
  for (const items of ["(<['org.freedesktop.StatusNotifierItem-1234-1']>,)",
    "(<[':1.99@/StatusNotifierItem']>,)", "(<[':1.99@/StatusNotifierItem/1']>,)", "(<[':1.99/StatusNotifierItem/1']>,)",
    "(<['org.freedesktop.StatusNotifierItem-1234-1/StatusNotifierItem/1']>,)"]) {
    await check(items)
  }
  for (const items of ["(<@as []>,)", "(<[':1.999@/StatusNotifierItem/1']>,)",
    "(<[':1.99@/StatusNotifierItem/10']>,)"]) {
    await assert.rejects(check(items), /AppIndicator.*v66/)
  }
})

test('tray smoke retries a not-yet-owned service but preserves unrelated D-Bus failures', async () => {
  const smoke = readFileSync(new URL('../scripts/gui-smoke.mjs', import.meta.url), 'utf8')
  const start = smoke.indexOf('async function verifyTrayRegistration(')
  const end = smoke.indexOf('\nconst root =', start)
  let calls = 0
  const absent = Object.assign(new Error('not owned yet'), {
    stderr: 'org.freedesktop.DBus.Error.NameHasNoOwner',
  })
  const failure = new Error('watcher unavailable')
  const check = error => runInNewContext(`${smoke.slice(start, end)}; verifyTrayRegistration`, {
    assert, setTimeout: async () => {},
    execFileSync: (_file, args) => {
      if (calls++ === 0) throw error
      return args.includes('org.freedesktop.DBus.GetNameOwner')
        ? "(':1.99',)" : "(<['org.freedesktop.StatusNotifierItem-1234-1']>,)"
    },
  })(1234)
  await check(absent)
  assert.equal(calls, 3)
  calls = 0
  await assert.rejects(check(failure), error => error === failure)
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

test('settings version IPC validates its sender and boolean request and isolates channel errors', async () => {
  const source = readFileSync(new URL('../updates/desktop.mjs', import.meta.url), 'utf8')
  const start = source.indexOf("  ipcMain.handle('dsh-workbench:versions'")
  const end = source.indexOf("  ipcMain.handle('dsh-workbench:open-updates'", start)
  assert.ok(start >= 0 && end > start)
  let invoke
  const checked = []
  const context = {
    performing: false,
    ipcMain: { handle: (name, handler) => { assert.equal(name, 'dsh-workbench:versions'); invoke = handler } },
    options: { trustedSender: event => event.trusted === true },
    manager: { check: async channel => { checked.push(channel); if (channel === 'kernel') throw new Error('HTTP 404') },
      status: () => ({ desktop: { latest: '1.2.0' }, kernel: { version: '1.1.0' } }) },
  }
  runInNewContext(source.slice(start, end), context)
  await assert.rejects(invoke({ trusted: false }, true), /不可信/)
  await assert.rejects(invoke({ trusted: true }, 'install'), /参数无效/)
  assert.equal(checked.length, 0)
  const result = await invoke({ trusted: true }, true)
  assert.deepEqual(checked, ['kernel', 'desktop'])
  assert.equal(result.errors.kernel, 'HTTP 404')
  assert.equal(result.errors.desktop, undefined)
  assert.equal(result.desktop.latest, '1.2.0')
  await invoke({ trusted: true }, false)
  assert.equal(checked.length, 2)
  context.performing = true
  await assert.rejects(invoke({ trusted: true }, true), /确认对话框/ )
  await invoke({ trusted: true }, false)
  assert.equal(checked.length, 2, 'Read-only queries cannot change a release awaiting installation approval')
})

test('afterPack removes the default ASAR before all artifact formats and rejects remaining ASAR files', async t => {
  const appOutDir = mkdtempSync(join(tmpdir(), 'dsh-after-pack-'))
  t.after(() => rmSync(appOutDir, { recursive: true, force: true }))
  const workbench = join(appOutDir, 'resources/app/workbench')
  mkdirSync(workbench, { recursive: true })
  for (const file of ['desktop.json', 'updates.json']) writeFileSync(join(workbench, file), '{}')
  const defaultAsar = join(appOutDir, 'resources/default_app.asar')
  writeFileSync(defaultAsar, 'default app')
  let verified = false
  const afterPack = runInNewContext(`(${config.afterPack.toString()})`, {
    config: { afterPack: async () => { verified = true } }, join, rmSync, readdirSync, readFileSync, hardenPermissions,
  })
  await afterPack({ appOutDir })
  assert.equal(verified, true)
  assert.equal(readdirSync(join(appOutDir, 'resources')).includes('default_app.asar'), false)
  writeFileSync(join(workbench, 'unsupported.asar'), 'unsupported')
  await assert.rejects(afterPack({ appOutDir }), /ASAR/)
})

test('updater quits only after installer cleanup has completed and does not quit on cancellation', async () => {
  const source = readFileSync(new URL('../updates/desktop.mjs', import.meta.url), 'utf8')
  const start = source.indexOf("  ipcMain.handle('dsh-workbench:updates'")
  const end = source.indexOf('\n  return {\n    get selected()', start)
  assert.ok(start >= 0 && end > start)
  let invoke, cleaned = false, scheduled = 0, quits = 0, accepted = true
  const contents = { mainFrame: { url: 'file:///updates.html' } }
  const context = {
    ipcMain: { handle: (_name, handler) => { invoke = handler } },
    window: { webContents: contents }, url: contents.mainFrame.url, performing: false,
    dialog: { showMessageBox: async () => ({ response: 1 }) },
    userDesktop: { root: '/managed/home' }, extract: () => {},
    manager: { busy: false, status: () => ({ desktop: { available: '1.2.0', availableLinuxRevision: 5 } }),
      installDesktop: async (_prepare, install, restart) => {
        if (!accepted) return false
        await install({ restart })
        assert.equal(quits, 0, 'Actual process exit must not interrupt installer cleanup')
        cleaned = true
        return true
      } },
    installUserDesktop: async artifact => { await artifact.restart('/managed/new'); return { executable: '/managed/new' } },
    options: { prepareRestart: async () => true, restart: () => { scheduled++ },
      finishRestart: () => { assert.equal(cleaned, true); quits++ }, recover: () => assert.fail('Unexpected recovery') },
  }
  runInNewContext(source.slice(start, end), context)
  const event = { sender: contents, senderFrame: contents.mainFrame }
  await invoke(event, 'install', 'desktop')
  assert.equal(scheduled, 1)
  assert.equal(quits, 1)
  accepted = false
  await invoke(event, 'install', 'desktop')
  assert.equal(quits, 1)
})
