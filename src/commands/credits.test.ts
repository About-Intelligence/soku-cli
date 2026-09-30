import { strict as assert } from 'node:assert'
import test from 'node:test'

import { Command } from 'commander'

import { registerCreditsCommands, renderCredits } from './credits.js'

test('credits is a top-level command', () => {
  const program = new Command()
  registerCreditsCommands(program)
  assert.ok(program.commands.some((cmd) => cmd.name() === 'credits'))
})

test('credits renders the balance, the plan, and each call with its cost', () => {
  const view = renderCredits({
    balance: -1495,
    plan: null,
    window_days: 7,
    charges: [
      {
        occurred_at: '2026-09-30T06:42:42.748715+00:00',
        provider: 'ahrefs',
        endpoint: 'ahrefs.v3',
        path: '/v3/keywords-explorer/matching-terms',
        http_status: 200,
        credits: 9429,
        balance_after: -1495,
      },
      {
        occurred_at: '2026-09-30T06:42:41.000000+00:00',
        provider: 'ahrefs',
        endpoint: 'ahrefs.v3',
        path: '/v3/keywords-explorer/matching-terms',
        http_status: 200,
        credits: 9429,
        balance_after: 7934,
      },
    ],
  })
  assert.match(view, /Balance: -1495 credits/)
  assert.match(view, /no paid plan/)
  assert.match(view, /18858 credits/)
  assert.match(view, /matching-terms/)
  assert.match(view, /2026-09-30 06:42:42/)
})

test('credits says so when there were no calls', () => {
  const view = renderCredits({ balance: 500, plan: 'creator', window_days: 7, charges: [] })
  assert.match(view, /plan creator/)
  assert.match(view, /No egress calls by you in the last 7 days/)
})
