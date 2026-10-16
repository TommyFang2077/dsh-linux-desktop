import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import { createRequire, isBuiltin } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const workspace = resolve(import.meta.dirname, '..')
const upstream = process.env.DSH_UPSTREAM_SOURCE ?? join(workspace, 'build/upstream')
const dependencies = process.env.DSH_UPSTREAM_DEPENDENCIES ?? upstream
const require = createRequire(join(dependencies, 'package.json'))
const { build } = require(require.resolve('esbuild', { paths: [join(dependencies, 'node_modules/.pnpm/node_modules')] }))

test('real retained-CI entry excludes Linux while preserving official macOS and Windows inventories', async t => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'dsh-retain-ci-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const { commit } = JSON.parse(await fs.readFile(join(workspace, 'upstream.json'), 'utf8'))
  const archive = join(directory, 'source.tar')
  execFileSync('git', ['-C', upstream, 'archive', '--output=' + archive, commit,
    'apps/desktop/scripts', 'apps/desktop/package.json'])
  execFileSync('tar', ['-xf', archive, '-C', directory])
  const patch = await fs.readFile(join(workspace, 'patches/linux.patch'), 'utf8')
  for (const target of ['desktop-build-paths.mjs', 'retain-desktop-ci.ts']) {
    const path = 'apps/desktop/scripts/' + target
    const part = patch.split('diff --git ').find(item => item.startsWith('a/' + path + ' b/' + path + '\n'))
    assert.ok(part, 'Expected current Linux patch for ' + path)
    execFileSync('git', ['apply', '-'], { cwd: directory, input: 'diff --git ' + part })
  }
  const entry = join(directory, 'entry.mjs')
  await fs.writeFile(entry, "export { retainDesktopCi, desktopReleasesRoot } from './apps/desktop/scripts/retain-desktop-ci.ts';\nexport { verifyRetainedDesktopRelease } from './apps/desktop/scripts/desktop-release-store.ts';\n")
  const output = join(directory, 'retention.mjs')
  await build({ entryPoints: [entry], outfile: output, bundle: true, platform: 'node', format: 'esm',
    target: 'node24', packages: 'external',
    plugins: [{ name: 'fresh-native-dependencies', setup(plugin) {
      plugin.onResolve({ filter: /^[^./]/ }, args => isBuiltin(args.path) ? undefined : {
        path: require.resolve(args.path, { paths: [join(dependencies, 'apps/desktop/node_modules'),
          join(dependencies, 'node_modules'), join(dependencies, 'node_modules/.pnpm/node_modules')] }),
        external: true,
      })
    } }],
    banner: { js: "import { createRequire as __require } from 'node:module'; const require = __require(import.meta.url);" } })
  const { retainDesktopCi, desktopReleasesRoot, verifyRetainedDesktopRelease } = await import(pathToFileURL(output))

  await t.test('Linux rejects before reading machine presets or creating retention output', async () => {
    const root = join(directory, 'linux')
    await fs.mkdir(root)
    const env = { DSH_DESKTOP_TARGET_PLATFORM: 'linux', DSH_DESKTOP_TARGET_ARCH: 'x64' }
    for (const key of ['DSH_PACKAGING_CONFIG_DIR', 'DSH_DESKTOP_RELEASES_DIR']) {
      Object.defineProperty(env, key, { enumerable: true, get() { throw new Error('Linux must not read ' + key) } })
    }
    await assert.rejects(retainDesktopCi(env, root), /desktop retention: Linux uses the independent release workflow/)
    assert.deepEqual(await fs.readdir(root), [])
  })

  for (const target of ['mac-arm64', 'mac-x64', 'win-x64']) {
    await t.test(target + ' retains its exact installer and official feed inventory', async () => {
      const root = join(directory, target)
      const appRoot = join(root, 'checkout')
      const config = join(root, 'packaging')
      const artifacts = join(appRoot, '.desktop-build', 'targets', target, 'artifacts')
      await fs.mkdir(artifacts, { recursive: true })
      await fs.mkdir(join(config, 'presets'), { recursive: true })
      await fs.writeFile(join(appRoot, 'package.json'), '{"version":"1.0.0"}')
      await fs.writeFile(join(config, 'presets/test.env'), 'DSH_DESKTOP_AUTO_UPDATE_ENV=test\nDOWNLOAD_TEST_RELEASE_ID=' + 'a'.repeat(32) + '\n')
      const windows = target === 'win-x64'
      const base = 'deepseek-harness-1.0.0-' + target
      const names = windows
        ? [base + '.exe', base + '.exe.blockmap', target + '-release.json', 'nightly.yml']
        : [base + '.dmg', base + '.zip', base + '.zip.blockmap', target + '-release.json', 'nightly-mac.yml']
      await Promise.all(names.map(name => fs.writeFile(join(artifacts, name), 'fixture')))
      const env = {
        DSH_PACKAGING_CONFIG_DIR: config, DSH_PACKAGING_PRESET: 'test',
        DSH_DESKTOP_TARGET_PLATFORM: windows ? 'win32' : 'darwin',
        DSH_DESKTOP_TARGET_ARCH: target === 'mac-arm64' ? 'arm64' : 'x64',
        PACKAGE_SOURCE_REF: 'master', PACKAGE_SOURCE_SHA: 'b'.repeat(40), PACKAGE_VERSION: '1.0.0',
        PACKAGE_SIGNING: 'signed', PACKAGE_SKIP_NOTARIZATION: 'false', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2',
        GITHUB_REPOSITORY: 'owner/repository', GITHUB_SHA: 'b'.repeat(40), RUNNER_NAME: 'dedicated',
      }
      await retainDesktopCi(env, appRoot)
      const manifest = await verifyRetainedDesktopRelease(desktopReleasesRoot(env), '123', '2')
      assert.deepEqual(manifest.files.map(file => file.name), names)
      assert.equal(manifest.source.target, target)
      assert.equal(manifest.source.qualification, windows ? 'signed' : 'notarized')
      assert.equal(manifest.source.publishRequested, undefined)
    })
  }
})
