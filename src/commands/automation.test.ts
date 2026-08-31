import { strict as assert } from 'node:assert'
import test from 'node:test'

import { Command } from 'commander'

import {
  AutomationUsageError,
  automationPath,
  automationRunsPath,
  buildAutomationCreatePayload,
  buildAutomationUpdatePayload,
  conversationUrl,
  registerAutomationCommands,
  renderAutomationDependencies,
  renderAutomationRuns,
  renderAutomations,
  runsWithConversationUrls,
} from './automation.js'

test('automation command exposes the full lifecycle, not just create and rebuild', () => {
  const program = new Command()
  registerAutomationCommands(program)
  const automation = program.commands.find((cmd) => cmd.name() === 'automation')
  assert.ok(automation)
  assert.deepEqual(
    automation.commands.map((cmd) => cmd.name()).sort(),
    [
      'create',
      'delete',
      'deps',
      'get',
      'list',
      'pause',
      'resume',
      'runs',
      'trigger',
      'update',
    ],
  )
})

test('automation delete refuses to run without --confirm', () => {
  const program = new Command()
  registerAutomationCommands(program)
  const automation = program.commands.find((cmd) => cmd.name() === 'automation')
  const del = automation?.commands.find((cmd) => cmd.name() === 'delete')
  assert.ok(del)
  assert.ok(del.options.some((opt) => opt.long === '--confirm'))
})

test('automation paths encode ids and query params', () => {
  assert.equal(automationPath(), '/api/cli/automations')
  assert.equal(
    automationPath('id/with/slash', 'trigger'),
    '/api/cli/automations/id%2Fwith%2Fslash/trigger',
  )
  assert.equal(
    automationRunsPath('automation id', { limit: '5', offset: '10' }),
    '/api/cli/automations/automation%20id/runs?limit=5&offset=10',
  )
})

test('automation create payload accepts exactly one schedule', () => {
  assert.deepEqual(
    buildAutomationCreatePayload({
      name: 'Fast report',
      prompt: 'Run the report',
      cron: '* * * * *',
      timezone: 'UTC',
    }),
    {
      name: 'Fast report',
      prompt: 'Run the report',
      scheduleContract: {
        kind: 'local_cron',
        cron: '* * * * *',
        timezone: 'UTC',
        source: 'utc_escape',
      },
    },
  )

  assert.deepEqual(
    buildAutomationCreatePayload({
      name: 'Hourly',
      prompt: 'Check account health',
      intervalSeconds: '3600',
    }).scheduleContract,
    { kind: 'interval', everySeconds: 3600, source: 'agent' },
  )

  assert.throws(
    () =>
      buildAutomationCreatePayload({
        name: 'Bad',
        prompt: 'Missing schedule',
      }),
    AutomationUsageError,
  )
  assert.throws(
    () =>
      buildAutomationCreatePayload({
        name: 'Bad',
        prompt: 'Too many schedules',
        cron: '* * * * *',
        onceAt: '2026-06-25T00:00:00Z',
      }),
    AutomationUsageError,
  )
})

test('automation interval schedule matches server constraints', () => {
  for (const intervalSeconds of ['60', '3599', '3601']) {
    assert.throws(
      () =>
        buildAutomationCreatePayload({
          name: 'Bad interval',
          prompt: 'Check account health',
          intervalSeconds,
        }),
      AutomationUsageError,
    )
  }

  assert.deepEqual(
    buildAutomationCreatePayload({
      name: 'Two hours',
      prompt: 'Check account health',
      intervalSeconds: '7200',
    }).scheduleContract,
    { kind: 'interval', everySeconds: 7200, source: 'agent' },
  )
})

test('conversation urls use SOKU_WEB_BASE-compatible path joining', () => {
  assert.equal(
    conversationUrl('/o/org-slug/b/brand-slug/chat/123', 'http://localhost:47627'),
    'http://localhost:47627/o/org-slug/b/brand-slug/chat/123',
  )
  assert.equal(conversationUrl(null, 'http://localhost:47627'), null)
  assert.equal(
    conversationUrl('https://app.soku.ai/o/org/b/brand/chat/123', 'http://localhost:47627'),
    'https://app.soku.ai/o/org/b/brand/chat/123',
  )
})

test('automation renderers include status and canonical links', () => {
  const list = renderAutomations({
    count: 1,
    items: [
      {
        id: 'automation-1',
        name: 'Daily check',
        prompt: 'Check things',
        status: 'active',
        nextRunAtMs: 1782369600000,
        timezone: 'UTC',
      },
    ],
  })
  assert.match(list, /Daily check/)
  assert.match(list, /active/)

  const runs = runsWithConversationUrls({
    total: 1,
    hasMore: false,
    runs: [
      {
        id: 'run-1',
        taskId: 'automation-1',
        conversationId: 'conversation-1',
        conversationPath: '/o/org-slug/b/brand-slug/chat/conversation-1',
        status: 'done',
        scheduledFor: '2026-06-25T00:00:00Z',
        startedAt: '2026-06-25T00:01:00Z',
        summary: 'Agent handoff started',
      },
    ],
  })
  assert.equal(
    runs.runs[0].conversationUrl,
    'https://app.soku.ai/o/org-slug/b/brand-slug/chat/conversation-1',
  )
  assert.match(renderAutomationRuns(runs), /Agent handoff started/)
  assert.match(renderAutomationRuns(runs), /\/o\/org-slug\/b\/brand-slug\/chat/)
})


test('automation update payload sends only the fields that were passed', () => {
  assert.deepEqual(buildAutomationUpdatePayload({ name: 'Renamed' }), { name: 'Renamed' })
  assert.deepEqual(buildAutomationUpdatePayload({ status: 'paused' }), { status: 'paused' })
  assert.deepEqual(
    buildAutomationUpdatePayload({ prompt: 'New prompt', cron: '30 9 * * *', timezone: 'Asia/Shanghai' }),
    {
      prompt: 'New prompt',
      scheduleContract: {
        kind: 'local_cron',
        cron: '30 9 * * *',
        timezone: 'Asia/Shanghai',
        source: 'agent',
      },
    },
  )
})

test('automation update payload rejects empty, multi-schedule, and bad status input', () => {
  assert.throws(() => buildAutomationUpdatePayload({}), AutomationUsageError)
  assert.throws(
    () => buildAutomationUpdatePayload({ cron: '* * * * *', onceAt: '2026-01-01T00:00:00Z' }),
    AutomationUsageError,
  )
  assert.throws(() => buildAutomationUpdatePayload({ status: 'sleeping' }), AutomationUsageError)
})

test('automation update rejects a lone --timezone instead of silently ignoring it', () => {
  // The server rebuilds the stored schedule from a whole contract, so a
  // timezone with no cron would look accepted and change nothing.
  assert.throws(
    () => buildAutomationUpdatePayload({ timezone: 'Asia/Shanghai' }),
    AutomationUsageError,
  )
})

test('automation deps renders resolvable and missing dependencies distinctly', () => {
  const rendered = renderAutomationDependencies({
    automationId: 'auto-1',
    brandId: 'brand-1',
    attachments: [
      { id: 'att-ok', status: 'ok', name: 'brief.pdf', sizeBytes: 2048 },
      { id: 'att-gone', status: 'missing' },
    ],
    contextReferences: [
      { id: 'act_123', type: 'account', name: 'Meta Ads', brandPinned: true },
      { id: 'soku-ads-report', type: 'skill', name: 'Ads report', brandPinned: false },
    ],
    missingAttachmentCount: 1,
    brandPinnedReferenceCount: 1,
    ready: false,
  })

  assert.match(rendered, /1 missing/)
  assert.match(rendered, /att-gone/)
  assert.match(rendered, /brand-pinned/)
  assert.match(rendered, /portable/)
  assert.match(rendered, /must be re-picked/)
})
