import assert from 'node:assert/strict'
import test from 'node:test'
import { encodeIco } from '../scripts/build-icons.mjs'

test('ICO entries preserve PNG bytes and encode 256px as zero without overlapping payloads', () => {
  const images = [{ size: 16, png: Buffer.from('small PNG') }, { size: 256, png: Buffer.from('large PNG') }]
  const ico = encodeIco(images)
  assert.equal(ico.readUInt16LE(0), 0)
  assert.equal(ico.readUInt16LE(2), 1)
  assert.equal(ico.readUInt16LE(4), 2)
  let offset = 6 + 16 * images.length
  images.forEach((image, index) => {
    const entry = 6 + 16 * index
    assert.equal(ico[entry], image.size % 256)
    assert.equal(ico[entry + 1], image.size % 256)
    assert.equal(ico.readUInt16LE(entry + 6), 32)
    assert.equal(ico.readUInt32LE(entry + 12), offset)
    assert.deepEqual(ico.subarray(offset, offset + image.png.length), image.png)
    offset += image.png.length
  })
  assert.equal(ico.length, offset)
  assert.throws(() => encodeIco([{ size: 512, png: Buffer.alloc(1) }]), /Invalid ICO/)
})
