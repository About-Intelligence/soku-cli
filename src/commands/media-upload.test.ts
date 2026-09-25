import { strict as assert } from 'node:assert'
import test from 'node:test'

import { mediaContentType } from './media-upload.js'

test('the upload type comes from the extension and must match the kind', () => {
  assert.equal(mediaContentType('/c/Clip.MP4', 'video'), 'video/mp4')
  assert.equal(mediaContentType('/c/clip.mov', 'video'), 'video/quicktime')
  assert.equal(mediaContentType('/c/hero.JPG', 'image'), 'image/jpeg')
  const mismatch = mediaContentType('/c/hero.png', 'video')
  assert.equal(typeof mismatch, 'object')
  assert.match((mismatch as { error: string }).error, /hero\.png is not a supported video file/)
  assert.equal(typeof mediaContentType('/c/notes.txt', 'image'), 'object')
})
