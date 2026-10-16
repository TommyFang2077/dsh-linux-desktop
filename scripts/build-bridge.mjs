#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

export const BRIDGE_BASELINE = 'workbench-v0.2.1-alpha.1-r7'
export const BRIDGE_REVISION = 9
const BASELINE_COMMIT = 'fd218dddff5225e0c0b6bb938a0570da4e718992'
const OFFICIAL_COMMIT = '5badb15009ae1756c3afe0ae0cef1faafc290ccc'
const FEED_ROOT = 'https://raw.githubusercontent.com/TommyFang2077/dsh-linux-desktop/update-feed/'

export function releaseFeedNames({ version, linuxRevision, dataEpoch }) {
  assert.match(dataEpoch, /^dsh-[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/, 'Invalid release data epoch')
  assert.ok(Number.isSafeInteger(linuxRevision) && linuxRevision > 0, 'Invalid Linux revision')
  if (dataEpoch === 'dsh-0.2.1-alpha.1') {
    assert.ok(version === '0.2.1-alpha.1' && linuxRevision === BRIDGE_REVISION, `Only genuine alpha.1 r${BRIDGE_REVISION} may replace legacy feeds`)
    return { kernel: 'kernel-latest.json', desktop: 'desktop-latest.json' }
  }
  return { kernel: `kernel-${dataEpoch}-latest.json`, desktop: `desktop-${dataEpoch}-latest.json` }
}

export function bridgePlan(root = resolve(import.meta.dirname, '..')) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const baselineCommit = git('rev-parse', `${BRIDGE_BASELINE}^{commit}`).trim()
  assert.equal(baselineCommit, BASELINE_COMMIT, 'Bridge baseline tag must resolve to the reviewed r7 commit')
  const fromTag = file => JSON.parse(git('show', `${BRIDGE_BASELINE}:${file}`))
  const upstream = fromTag('upstream.json')
  assert.equal(upstream.repository, 'https://github.com/deepseek-ai/deepseek-harness.git')
  assert.equal(upstream.commit, OFFICIAL_COMMIT)
  assert.equal(upstream.version, '0.2.1-alpha.1')
  const desktop = { ...fromTag('desktop.json'), linuxRevision: BRIDGE_REVISION }
  assert.equal(desktop.version, upstream.version)
  assert.equal(desktop.dataEpoch, 'dsh-0.2.1-alpha.1')
  const config = fromTag('updates.json')
  for (const channel of ['kernel', 'desktop']) assert.equal(config[channel].url, `${FEED_ROOT}${channel}-latest.json`)
  const current = JSON.parse(readFileSync(resolve(root, 'updates.json'), 'utf8'))
  config.desktopUpgrade = { ...current.desktopUpgrade }
  assert.equal(config.desktopUpgrade.url, `${FEED_ROOT}desktop-dsh-0.2.1-alpha.2-latest.json`)
  assert.equal(config.desktopUpgrade.publicKey, config.desktop.publicKey)
  return { baselineTag: BRIDGE_BASELINE, baselineCommit, upstream, desktop, config }
}

export async function stageBridge({ root = resolve(import.meta.dirname, '..'), directory = join(root, 'build/bridge-alpha1'),
  sourceRepository = join(root, 'build/upstream-alpha.1-backup') } = {}) {
  root = resolve(root)
  directory = resolve(directory)
  const within = relative(join(root, 'build'), directory)
  assert.ok(within && !within.startsWith('..') && !isAbsolute(within), 'Bridge staging must stay inside the build directory')
  const plan = bridgePlan(root)
  await fs.access(join(root, 'patches/bridge-migration.patch'))
  for (const file of ['whole-desktop.mjs', 'migration-worker.mjs']) await fs.access(join(root, 'updates', file))
  try { await fs.lstat(directory); throw new Error('Bridge staging directory already exists; choose a fresh build directory') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  await fs.mkdir(dirname(directory), { recursive: true })
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
  git(root, 'clone', '--no-hardlinks', '--no-checkout', root, directory)
  git(directory, 'checkout', '--detach', BRIDGE_BASELINE)
  const upstream = join(directory, 'build/upstream')
  await fs.mkdir(dirname(upstream), { recursive: true })
  try { await fs.access(sourceRepository) } catch { sourceRepository = plan.upstream.repository }
  git(directory, 'clone', '--no-hardlinks', '--no-checkout', sourceRepository, upstream)
  git(upstream, 'checkout', '--detach', plan.upstream.commit)
  const officialTag = `dsh-v${plan.upstream.version}`
  assert.equal(git(upstream, 'rev-parse', `${officialTag}^{commit}`).trim(), plan.upstream.commit, 'Official alpha.1 tag differs from the pinned commit')
  assert.equal(JSON.parse(await fs.readFile(join(upstream, 'package.json'), 'utf8')).version, plan.upstream.version)
  const historicalPatch = join(directory, 'patches/linux.patch')
  git(upstream, 'apply', '--check', historicalPatch)
  git(upstream, 'apply', historicalPatch)
  const backport = join(root, 'patches/bridge-migration.patch')
  git(upstream, 'apply', '--check', backport)
  git(upstream, 'apply', backport)
  // Include new files from the historical patch, not just modifications to tracked files.
  git(upstream, 'add', '--intent-to-add', '--all')
  const composite = git(upstream, 'diff', '--binary', 'HEAD')
  await fs.writeFile(historicalPatch, composite)
  git(upstream, 'apply', '--reverse', '--check', historicalPatch)
  for (const path of ['updates', 'patches/bridge-migration.patch', 'electron-builder.config.mjs', 'scripts/build-updates.mjs', 'scripts/release-updates.mjs', 'scripts/build-bridge.mjs',
    '.github/workflows/linux-updates.yml', 'tests/workflow.test.mjs', 'tests/manifest.test.mjs', 'tests/bridge-update.test.mjs', 'tests/fixtures/legacy-r7-core.mjs']) {
    await fs.mkdir(dirname(join(directory, path)), { recursive: true })
    await fs.cp(join(root, path), join(directory, path), { recursive: true })
  }
  for (const [path, value] of [['desktop.json', plan.desktop], ['updates.json', plan.config]]) {
    await fs.writeFile(join(directory, path), JSON.stringify(value, null, 2) + '\n')
  }
  const sources = {}
  for (const path of ['updates/core.mjs', 'updates/desktop.mjs', 'updates/user-install.mjs', 'updates/whole-desktop.mjs', 'updates/migration-worker.mjs',
    'scripts/build-updates.mjs', 'electron-builder.config.mjs', 'patches/linux.patch', 'patches/bridge-migration.patch',
    'build/upstream/apps/desktop/src/main.ts']) {
    sources[path] = createHash('sha256').update(await fs.readFile(join(directory, path))).digest('hex')
  }
  const provenance = { schemaVersion: 1, baselineTag: plan.baselineTag, baselineCommit: plan.baselineCommit,
    officialTag, officialCommit: plan.upstream.commit, version: plan.desktop.version,
    linuxRevision: plan.desktop.linuxRevision, dataEpoch: plan.desktop.dataEpoch, sources }
  await fs.writeFile(join(directory, 'bridge-build.json'), JSON.stringify(provenance, null, 2) + '\n')
  return { ...plan, directory }
}

// Bundlers merge import.meta URLs, so imports must also preserve the CLI's explicit identity.
if (process.argv[1] && basename(fileURLToPath(import.meta.url)) === 'build-bridge.mjs'
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { build: { type: 'boolean', default: false }, directory: { type: 'string' },
    'source-repository': { type: 'string' }, 'reuse-dependencies': { type: 'boolean', default: false } } })
  const root = resolve(import.meta.dirname, '..')
  const sourceRepository = values['source-repository'] ?? join(root, 'build/upstream-alpha.1-backup')
  const result = await stageBridge({ root, directory: values.directory, sourceRepository })
  if (values['reuse-dependencies']) {
    execFileSync('cp', ['-a', '--reflink=auto', join(sourceRepository, 'node_modules'), join(result.directory, 'build/upstream/node_modules')], { stdio: 'inherit' })
  }
  if (values.build) {
    for (const target of ['package', 'verify']) execFileSync('make', [target], { cwd: result.directory, stdio: 'inherit' })
    execFileSync(process.execPath, ['--test', 'tests/bridge-update.test.mjs', 'tests/workflow.test.mjs', 'tests/manifest.test.mjs'],
      { cwd: result.directory, stdio: 'inherit' })
  }
  console.log(JSON.stringify({ directory: result.directory, version: result.desktop.version,
    linuxRevision: result.desktop.linuxRevision, dataEpoch: result.desktop.dataEpoch, built: values.build }))
}
