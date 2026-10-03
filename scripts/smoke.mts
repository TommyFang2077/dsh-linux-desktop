/** Verify the packaged Linux runtime and boot its Host with isolated temporary data. */
import { join, resolve } from 'node:path'
import { readDesktopRuntime, verifyDesktopRuntime } from '../build/upstream/apps/desktop/src/runtime-tree.ts'
import { smokePreparedRuntime } from '../build/upstream/apps/desktop/scripts/smoke-prepared-runtime.ts'

const root = resolve(import.meta.dirname, '..')
const prepared = join(root, 'build/upstream/apps/desktop/.desktop-build/targets/linux-x64/dsh')
const descriptor = await verifyDesktopRuntime(prepared, readDesktopRuntime(prepared).release.version,
  { platform: 'linux', arch: 'x64' })
const application = join(process.env.DSH_WORKBENCH_OUTPUT ?? join(root, 'dist'), 'linux-unpacked')
const resources = join(application, 'resources')
const runtime = join(resources, 'app/dsh')
await verifyDesktopRuntime(runtime, descriptor.release.version, { platform: 'linux', arch: 'x64' })
await smokePreparedRuntime(runtime, join(application, 'dsh-workbench'), join(resources, 'runtime'), descriptor)
console.log('Packaged Linux runtime and Host smoke passed')
