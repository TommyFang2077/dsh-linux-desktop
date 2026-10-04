import { extractKernelSync } from './core.mjs'
const [archive, destination] = process.argv.slice(2)
if (!archive || !destination) throw new Error('Archive and private extraction directory are required')
extractKernelSync(archive, destination)
