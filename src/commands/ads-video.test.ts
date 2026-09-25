import { strict as assert } from 'node:assert'
import test from 'node:test'

import {
  buildVideoItems,
  deployVideosSummary,
  outcomeFromCall,
  renderVideoUploads,
  uploadVideoSummary,
} from './ads-video.js'

test('each file and library video becomes one item with a unique client_ref', () => {
  const items = buildVideoItems({
    files: ['/clips/intro.mp4', '/other/intro.mp4'],
    videoIds: ['77'],
  })
  assert.ok(Array.isArray(items))
  assert.deepEqual(items, [
    { client_ref: 'intro', name: 'intro', file: '/clips/intro.mp4' },
    { client_ref: 'intro-2', name: 'intro', file: '/other/intro.mp4' },
    { client_ref: 'video-77', name: 'Video 77', video_id: '77' },
  ])
})

test('an items file keeps per-item copy and needs exactly one video source', () => {
  const items = buildVideoItems({
    files: [],
    videoIds: [],
    itemsFromFile: [{ file: '/c/a.mp4', headline: 'A' }, { video_id: '9', name: 'Nine' }],
  })
  assert.deepEqual(items, [
    { file: '/c/a.mp4', headline: 'A', client_ref: 'a', name: 'a' },
    { video_id: '9', name: 'Nine', client_ref: 'item-2' },
  ])

  const twoSources = buildVideoItems({
    files: [],
    videoIds: [],
    itemsFromFile: [{ file: '/c/a.mp4', video_id: '9' }],
  })
  assert.ok(!Array.isArray(twoSources))
})

test('nothing to deploy, or a file that is not a video, is a usage error', () => {
  assert.ok(!Array.isArray(buildVideoItems({ files: [], videoIds: [] })))
  const notVideo = buildVideoItems({ files: ['/c/cover.png'], videoIds: [] })
  assert.ok(!Array.isArray(notVideo))
  assert.match(notVideo.error, /cover\.png is not a supported video file/)
})

test('the default approval header names the ad set and the videos', () => {
  assert.equal(
    deployVideosSummary('120250667120980043', ['a', 'b']),
    'Create 2 paused Meta video ads in ad set 120250667120980043: a, b',
  )
  assert.match(
    deployVideosSummary('1', ['a', 'b', 'c', 'd', 'e', 'f', 'g']),
    /: a, b, c, d, e and 2 more$/,
  )
  assert.equal(uploadVideoSummary('act_1', 'a.mp4'), 'Upload video a.mp4 to Meta ad account act_1')
})

test('an upload reads the same whether a person or an Always rule approves it', () => {
  assert.deepEqual(
    outcomeFromCall('/c/a.mp4', 'vid-a', {
      status: 'pending_review',
      pending_review_id: 'r1',
      approve_url: 'https://soku.test/approvals/r1',
    }),
    {
      file: '/c/a.mp4',
      media_asset_id: 'vid-a',
      review_id: 'r1',
      status: 'pending',
      approve_url: 'https://soku.test/approvals/r1',
    },
  )
  assert.equal(
    outcomeFromCall('/c/a.mp4', 'vid-a', { status: 'executing', review_id: 'r2', auto_approved: true })
      .status,
    'executing',
  )
})

test('the human view points at the inbox and the wait command', () => {
  const text = renderVideoUploads({
    videos: [
      { file: '/c/a.mp4', review_id: 'r1', status: 'pending' },
      { file: '/c/b.mp4', error: 'unsupported' },
    ],
    inbox_url: 'https://soku.test/approvals',
    review_ids: ['r1'],
  })
  assert.match(text, /a\.mp4 — waiting for approval \(review r1\)/)
  assert.match(text, /b\.mp4 — unsupported/)
  assert.match(text, /https:\/\/soku\.test\/approvals/)
  assert.match(text, /soku review wait r1/)
})
