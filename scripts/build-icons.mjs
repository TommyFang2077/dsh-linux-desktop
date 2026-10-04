import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** PNG-backed ICO entries supported by modern Windows; 256 is encoded as zero. */
export function encodeIco(images) {
  const directory = Buffer.alloc(6 + images.length * 16)
  directory.writeUInt16LE(1, 2)
  directory.writeUInt16LE(images.length, 4)
  let offset = directory.length
  images.forEach(({ size, png }, index) => {
    if (!Number.isInteger(size) || size < 1 || size > 256 || !Buffer.isBuffer(png)) throw new Error('Invalid ICO image')
    const entry = 6 + index * 16
    directory[entry] = size % 256
    directory[entry + 1] = size % 256
    directory.writeUInt16LE(1, entry + 4)
    directory.writeUInt16LE(32, entry + 6)
    directory.writeUInt32LE(png.length, entry + 8)
    directory.writeUInt32LE(offset, entry + 12)
    offset += png.length
  })
  return Buffer.concat([directory, ...images.map(image => image.png)])
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(import.meta.dirname, '..')
  const require = createRequire(join(root, 'build/upstream/apps/desktop/package.json'))
  const sharp = require('sharp')
  const source = join(root, 'resources/icon.svg')
  await mkdir(join(root, 'build'), { recursive: true })
  await sharp(source).resize(512).png().toFile(join(root, 'build/icon.png'))
  const images = await Promise.all([16, 24, 32, 48, 64, 128, 256].map(async size => ({ size, png: await sharp(source).resize(size).png().toBuffer() })))
  await writeFile(join(root, 'resources/dsh.ico'), encodeIco(images))
  console.log('Generated official dsh PNG and multi-resolution ICO')
}
