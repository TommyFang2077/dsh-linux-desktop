import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import config from '../electron-builder.config.mjs'

test('desktop packaging ships and verifies the standalone whole-desktop migration worker', async t => {
  assert.ok(config.files.includes('lib/workbench-migration-worker.mjs'))
  const appOutDir = await fs.mkdtemp('/tmp/workbench-worker-package-test-')
  t.after(() => fs.rm(appOutDir, { recursive: true, force: true }))
  const app = join(appOutDir, 'resources/app')
  await fs.mkdir(join(app, 'workbench'), { recursive: true })
  await fs.mkdir(join(app, 'lib'))
  for (const file of ['desktop.json', 'updates.json']) await fs.writeFile(join(app, 'workbench', file), '{}')
  const context = { appOutDir, packager: { getResourcesDir: directory => join(directory, 'resources') } }
  await assert.rejects(config.afterPack(context), /migration worker/)
  const worker = join(app, 'lib/workbench-migration-worker.mjs')
  await fs.writeFile(worker, '')
  await assert.rejects(config.afterPack(context), /migration worker/)
  await fs.writeFile(worker, 'export const fixture = true\n')
  await config.afterPack(context)
  assert.equal(await fs.readFile(worker, 'utf8'), 'export const fixture = true\n')
})
