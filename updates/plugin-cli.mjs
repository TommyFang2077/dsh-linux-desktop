/** Run the official CLI with explicit paths for both packaged and independently updated kernels. */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [dsh, runtime, ...args] = process.argv.slice(2)
if (!dsh || !runtime) throw new Error('Explicit dsh and support-runtime directories are required')
const entry = join(dsh, 'node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js')
process.argv = [process.execPath, entry, ...args]
const { runDesktopCli } = await import(pathToFileURL(entry).href)
await runDesktopCli(dsh, runtime)
