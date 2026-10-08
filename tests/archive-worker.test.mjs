import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'

const root = resolve(import.meta.dirname, '..')
const upstream = join(root, 'build/upstream')
const require = createRequire(join(upstream, 'package.json'))
const tar = require('tar')
const { build } = require(require.resolve('esbuild', { paths: [join(upstream, 'node_modules/.pnpm/node_modules')] }))
const distribution = join(upstream, 'apps/desktop/.desktop-build/targets/linux-x64/electron')
const electron = process.env.DSH_WORKBENCH_TEST_APP ?? join(distribution, 'electron')

test('Electron worker extracts ASAR bytes natively in both layouts and still rejects links', {
  skip: !existsSync(electron) || !existsSync(join(distribution, 'resources/default_app.asar'))
    ? 'Prepare packaged Electron first; CI reruns this check after make package' : false,
}, async t => {
  const temporary = await fs.mkdtemp('/tmp/dsh-archive-worker-test-')
  t.after(() => fs.rm(temporary, { recursive: true, force: true }))
  const worker = join(temporary, 'worker.mjs')
  await build({ entryPoints: [join(root, 'updates/archive-worker.mjs')], outfile: worker,
    bundle: true, platform: 'node', format: 'esm', target: 'node24',
    nodePaths: [join(upstream, 'node_modules')],
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  })
  const bytes = await fs.readFile(join(distribution, 'resources/default_app.asar'))
  for (const layout of ['desktop', 'kernel']) {
    const input = join(temporary, `${layout}-input`)
    const member = layout === 'desktop' ? 'app/resources/default_app.asar' : 'dsh/default_app.asar'
    await fs.mkdir(dirname(join(input, member)), { recursive: true, mode: 0o755 })
    await fs.writeFile(join(input, member), bytes, { mode: 0o644 })
    const archive = join(temporary, `${layout}.tar.gz`)
    await tar.c({ file: archive, gzip: true, portable: true, cwd: input }, [layout === 'desktop' ? 'app' : 'dsh'])
    const destination = join(temporary, `${layout}-output`)
    await fs.mkdir(destination, { mode: 0o700 })
    const extract = () => spawnSync(electron, ['--max-old-space-size=256', worker, archive, destination, layout],
      { env: { PATH: '/usr/bin:/bin', ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 30_000 })
    const result = extract()
    assert.equal(result.status, 0, result.stderr || String(result.error))
    assert.deepEqual(await fs.readFile(join(destination, member)), bytes)
    await fs.rm(destination, { recursive: true })
    await fs.mkdir(destination, { mode: 0o700 })
    await fs.symlink('/etc/passwd', join(input, dirname(member), 'escape'))
    await tar.c({ file: archive, gzip: true, portable: true, cwd: input }, [layout === 'desktop' ? 'app' : 'dsh'])
    const rejected = extract()
    assert.notEqual(rejected.status, 0)
    assert.match(rejected.stderr, /链接、特殊文件或重复路径/)
    assert.deepEqual(await fs.readdir(destination), [])
  }
})
