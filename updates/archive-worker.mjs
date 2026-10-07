import { extractDesktopSync, extractKernelSync } from './core.mjs'
const [archive, destination, layout = 'kernel'] = process.argv.slice(2)
if (!archive || !destination || !['kernel', 'desktop'].includes(layout)) throw new Error('Archive, private extraction directory and supported layout are required')
if (layout === 'desktop') extractDesktopSync(archive, destination)
else extractKernelSync(archive, destination)
