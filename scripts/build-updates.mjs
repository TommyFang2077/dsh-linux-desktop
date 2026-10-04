import { createRequire } from 'node:module'
import { copyFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '..')
const upstream = join(root, 'build/upstream')
const require = createRequire(join(upstream, 'package.json'))
const { build } = require(require.resolve('esbuild', { paths: [join(upstream, 'node_modules/.pnpm/node_modules')] }))
const assets = join(root, 'build/workbench-assets')
mkdirSync(assets, { recursive: true })
for (const file of ['updates.html', 'updates.js', 'updates.css', 'preload.cjs', 'install.py', 'plugin-cli.mjs']) {
  copyFileSync(join(root, 'updates', file), join(assets, file))
}
for (const file of ['desktop.json', 'updates.json']) copyFileSync(join(root, file), join(assets, file))
for (const [entry, outfile] of [
  ['updates/core.mjs', 'build/update-core.mjs'],
  ['updates/desktop.mjs', 'build/upstream/apps/desktop/lib/workbench.mjs'],
  ['updates/archive-worker.mjs', 'build/upstream/apps/desktop/lib/workbench-archive.mjs'],
  ['scripts/release-updates.mjs', 'build/release-updates.mjs'],
]) {
  await build({ entryPoints: [join(root, entry)], outfile: join(root, outfile), bundle: true,
    platform: 'node', format: 'esm', target: 'node24', external: ['electron'],
    nodePaths: [join(upstream, 'node_modules')],
    banner: { js: "import { createRequire as __workbenchRequire } from 'node:module'; const require = __workbenchRequire(import.meta.url);" },
  })
}
