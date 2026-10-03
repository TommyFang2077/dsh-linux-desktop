import assert from 'node:assert/strict'
import test from 'node:test'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  assert.deepEqual(config.protocols, [])
  assert.deepEqual(config.rpm.fpm, ['--rpm-rpmbuild-define', '_rpmformat 4'])
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
