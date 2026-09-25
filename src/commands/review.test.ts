import { strict as assert } from 'node:assert'
import test from 'node:test'

import { isSettled, waitForReviews, type Review } from './review.js'

function review(id: string, status: string): Review {
  return { id, namespace: 'ads', action: 'upload_video', status, summary: `upload ${id}` }
}

/** A clock that only moves when the code under test sleeps. */
function fakeClock() {
  let t = 0
  const sleeps: number[] = []
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms)
      t += ms
    },
    sleeps,
  }
}

test('pending and executing are the only unsettled states', () => {
  assert.equal(isSettled('pending'), false)
  assert.equal(isSettled('executing'), false)
  for (const status of ['approved', 'failed', 'rejected']) assert.equal(isSettled(status), true)
})

test('waits until the person decides and the write finishes', async () => {
  const clock = fakeClock()
  const timeline = ['pending', 'pending', 'executing', 'approved']
  let calls = 0
  const outcome = await waitForReviews(
    ['r1'],
    async (id) => review(id, timeline[Math.min(calls++, timeline.length - 1)]),
    { timeoutMs: 600_000, now: clock.now, sleep: clock.sleep },
  )

  assert.deepEqual(outcome.unsettled, [])
  assert.deepEqual(outcome.settled.map((r) => r.status), ['approved'])
  // Backs off 3s → 6s → 12s rather than hammering the API.
  assert.deepEqual(clock.sleeps, [3_000, 6_000, 12_000])
})

test('a settled review is not fetched again while others are still pending', async () => {
  const clock = fakeClock()
  const fetched: string[] = []
  let r2Calls = 0
  const outcome = await waitForReviews(
    ['r1', 'r2'],
    async (id) => {
      fetched.push(id)
      if (id === 'r1') return review(id, 'rejected')
      return review(id, r2Calls++ < 2 ? 'pending' : 'approved')
    },
    { timeoutMs: 600_000, now: clock.now, sleep: clock.sleep },
  )

  assert.deepEqual(fetched, ['r1', 'r2', 'r2', 'r2'])
  assert.deepEqual(outcome.settled.map((r) => `${r.id}:${r.status}`), ['r1:rejected', 'r2:approved'])
})

test('gives up at the deadline and reports what is still waiting', async () => {
  const clock = fakeClock()
  const outcome = await waitForReviews(['r1'], async (id) => review(id, 'pending'), {
    timeoutMs: 20_000,
    now: clock.now,
    sleep: clock.sleep,
  })

  assert.deepEqual(outcome.unsettled.map((r) => r.id), ['r1'])
  assert.equal(clock.now(), 20_000)
})
