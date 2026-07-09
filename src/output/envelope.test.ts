import assert from 'node:assert/strict'
import { test } from 'node:test'

import { renderHumanData } from './envelope.js'

test('renders a plain object as readable key-value lines', () => {
  assert.equal(
    renderHumanData({
      signed_in: true,
      owner_id: 'user_123',
      scope_type: 'user_session',
    }),
    ['Signed In: true', 'Owner Id: user_123', 'Scope Type: user_session'].join('\n'),
  )
})

test('renders a list of records as a table', () => {
  assert.equal(
    renderHumanData([
      { id: 'ads', label: 'Ads' },
      { id: 'ga4', label: 'GA4' },
    ]),
    ['ID   LABEL', 'ads  Ads  ', 'ga4  GA4  '].join('\n'),
  )
})

test('renders nested record lists without falling back to pretty JSON', () => {
  const rendered = renderHumanData({
    count: 2,
    rows: [
      { campaign: 'A', clicks: 10 },
      { campaign: 'B', clicks: 20 },
    ],
  })

  assert.match(rendered, /Count: 2/)
  assert.match(rendered, /Rows/)
  assert.match(rendered, /CAMPAIGN/)
  assert.doesNotMatch(rendered, /^\{/)
})
