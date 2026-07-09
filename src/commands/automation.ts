/** `soku automation` — manage brand automations and inspect run history. */

import { Command } from 'commander'

import { apiRequest } from '../http/client.js'
import { bold, cyan, dim, emitError, emitSuccess, ExitCode, table } from '../output/envelope.js'

const AUTOMATIONS_PATH = '/api/cli/automations'
const DEFAULT_WEB_BASE = 'https://app.soku.ai'

type ScheduleContract =
  | {
      kind: 'local_cron'
      cron: string
      timezone: string
      source: 'agent' | 'utc_escape'
    }
  | {
      kind: 'interval'
      everySeconds: number
      source: 'agent'
    }
  | {
      kind: 'once_at'
      instantUtc: string
      source: 'agent'
    }

interface AutomationCreateOptions {
  name: string
  prompt: string
  cron?: string
  intervalSeconds?: string
  onceAt?: string
  timezone?: string
}

export interface AutomationCreatePayload {
  name: string
  prompt: string
  scheduleContract: ScheduleContract
}

export interface AutomationItem {
  id: string
  name: string
  prompt: string
  status: string
  nextRunAtMs?: number | null
  scheduleContract?: Record<string, unknown>
  timezone?: string
}

interface AutomationListResponse {
  items: AutomationItem[]
  count: number
}

export interface AutomationRun {
  id: string
  taskId: string
  conversationId?: string | null
  conversationPath?: string | null
  conversationUrl?: string | null
  status: string
  scheduledFor: string
  startedAt?: string | null
  finishedAt?: string | null
  summary?: string | null
  pendingReviewCount?: number
  artifactsCount?: number
}

interface AutomationRunsResponse {
  runs: AutomationRun[]
  total: number
  hasMore: boolean
}

interface AutomationTriggerResponse {
  runId: string
  conversationId?: string | null
}

export class AutomationUsageError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message)
  }
}

export function automationPath(automationId?: string, suffix?: string): string {
  if (!automationId) return AUTOMATIONS_PATH
  const encoded = encodeURIComponent(automationId)
  return `${AUTOMATIONS_PATH}/${encoded}${suffix ? `/${suffix}` : ''}`
}

export function automationRunsPath(automationId: string, opts: { limit?: string; offset?: string }): string {
  const params = new URLSearchParams()
  if (opts.limit) params.set('limit', opts.limit)
  if (opts.offset) params.set('offset', opts.offset)
  const query = params.toString()
  return `${automationPath(automationId, 'runs')}${query ? `?${query}` : ''}`
}

export function resolveWebBase(): string {
  return (process.env.SOKU_WEB_BASE || DEFAULT_WEB_BASE).replace(/\/$/, '')
}

export function conversationUrl(path?: string | null, base = resolveWebBase()): string | null {
  if (!path) return null
  if (/^https?:\/\//.test(path)) return path
  return `${base}${path.startsWith('/') ? path : `/${path}`}`
}

export function buildAutomationCreatePayload(opts: AutomationCreateOptions): AutomationCreatePayload {
  const scheduleSources = [opts.cron, opts.intervalSeconds, opts.onceAt].filter(
    (value) => value !== undefined,
  )
  if (scheduleSources.length !== 1) {
    throw new AutomationUsageError(
      'Provide exactly one schedule option.',
      'Use --cron, --interval-seconds, or --once-at.',
    )
  }
  return {
    name: requiredText(opts.name, '--name'),
    prompt: requiredText(opts.prompt, '--prompt'),
    scheduleContract: buildScheduleContract(opts),
  }
}

function buildScheduleContract(opts: AutomationCreateOptions): ScheduleContract {
  if (opts.cron !== undefined) {
    const timezone = (opts.timezone || 'UTC').trim()
    if (!timezone) throw new AutomationUsageError('--timezone cannot be blank.')
    return {
      kind: 'local_cron',
      cron: requiredText(opts.cron, '--cron'),
      timezone,
      source: timezone === 'UTC' ? 'utc_escape' : 'agent',
    }
  }
  if (opts.intervalSeconds !== undefined) {
    const everySeconds = parseIntervalSeconds(opts.intervalSeconds)
    return { kind: 'interval', everySeconds, source: 'agent' }
  }
  if (opts.onceAt !== undefined) {
    return { kind: 'once_at', instantUtc: requiredText(opts.onceAt, '--once-at'), source: 'agent' }
  }
  throw new AutomationUsageError('Missing schedule option.')
}

function requiredText(value: string | undefined, flag: string): string {
  const trimmed = value?.trim()
  if (!trimmed) throw new AutomationUsageError(`${flag} cannot be blank.`)
  return trimmed
}

function parsePositiveInt(raw: string, flag: string): number {
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new AutomationUsageError(`${flag} must be a positive integer.`)
  }
  return value
}

function parseIntervalSeconds(raw: string): number {
  const value = parsePositiveInt(raw, '--interval-seconds')
  if (value < 3600 || value % 60 !== 0) {
    throw new AutomationUsageError(
      '--interval-seconds must be at least 3600 and divisible by 60.',
      'Use --once-at for a near-immediate one-off run, or --trigger after create.',
    )
  }
  return value
}

function renderTime(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '-'
  if (typeof value === 'number') return new Date(value).toISOString()
  return value
}

export function renderAutomations(data: AutomationListResponse): string {
  return table(
    data.items.map((item) => ({
      id: item.id,
      name: item.name,
      status: item.status,
      next: renderTime(item.nextRunAtMs),
      timezone: item.timezone ?? '',
    })),
    [
      { key: 'id', header: 'ID' },
      { key: 'name', header: 'NAME' },
      { key: 'status', header: 'STATUS' },
      { key: 'next', header: 'NEXT RUN' },
      { key: 'timezone', header: 'TIMEZONE' },
    ],
  )
}

export function renderAutomation(item: AutomationItem): string {
  return [
    `${bold('ID')}: ${cyan(item.id)}`,
    `${bold('Name')}: ${item.name}`,
    `${bold('Status')}: ${item.status}`,
    `${bold('Next run')}: ${renderTime(item.nextRunAtMs)}`,
    `${bold('Timezone')}: ${item.timezone ?? '-'}`,
  ].join('\n')
}

export function runsWithConversationUrls(data: AutomationRunsResponse): AutomationRunsResponse {
  return {
    ...data,
    runs: data.runs.map((run) => ({
      ...run,
      conversationUrl: run.conversationUrl ?? conversationUrl(run.conversationPath),
    })),
  }
}

export function renderAutomationRuns(data: AutomationRunsResponse): string {
  if (data.runs.length === 0) return dim('No runs yet.')
  return table(
    data.runs.map((run) => ({
      id: run.id,
      status: run.status,
      scheduled: run.scheduledFor,
      started: renderTime(run.startedAt),
      summary: run.summary ?? '',
      link: run.conversationUrl ?? conversationUrl(run.conversationPath) ?? '',
    })),
    [
      { key: 'id', header: 'RUN ID' },
      { key: 'status', header: 'STATUS' },
      { key: 'scheduled', header: 'SCHEDULED' },
      { key: 'started', header: 'STARTED' },
      { key: 'summary', header: 'SUMMARY' },
      { key: 'link', header: 'LINK' },
    ],
  )
}

function usageError(error: unknown): never {
  if (error instanceof AutomationUsageError) {
    emitError('usage', error.message, ExitCode.USAGE, error.hint)
  }
  throw error
}

export function registerAutomationCommands(program: Command): void {
  const automation = program
    .command('automation')
    .description('Manage automations for the active brand')

  automation
    .command('list')
    .description('List automations in the active brand')
    .action(async () => {
      const data = await apiRequest<AutomationListResponse>(automationPath(), { workspace: true })
      emitSuccess(data, renderAutomations)
    })

  automation
    .command('create')
    .description('Create an automation in the active brand')
    .requiredOption('--name <name>', 'Automation name')
    .requiredOption('--prompt <prompt>', 'Prompt the automation sends to the agent')
    .option('--cron <expr>', 'Five-field cron expression, e.g. "* * * * *"')
    .option('--interval-seconds <seconds>', 'Interval schedule in seconds (>= 3600 and divisible by 60)')
    .option('--once-at <iso>', 'Run once at this UTC ISO timestamp')
    .option('--timezone <tz>', 'IANA timezone for --cron schedules', 'UTC')
    .action(async (opts: AutomationCreateOptions) => {
      let payload: AutomationCreatePayload
      try {
        payload = buildAutomationCreatePayload(opts)
      } catch (err) {
        usageError(err)
      }
      const data = await apiRequest<AutomationItem>(automationPath(), {
        method: 'POST',
        workspace: true,
        body: payload,
      })
      emitSuccess(data, renderAutomation)
    })

  automation
    .command('trigger <automation_id>')
    .description('Trigger one manual run for an automation')
    .action(async (automationId: string) => {
      const data = await apiRequest<AutomationTriggerResponse>(automationPath(automationId, 'trigger'), {
        method: 'POST',
        workspace: true,
      })
      emitSuccess(
        data,
        (d) => `${bold('Run')}: ${cyan(d.runId)}\n${bold('Conversation')}: ${d.conversationId ?? '-'}`,
      )
    })

  automation
    .command('runs <automation_id>')
    .description('List run history for an automation')
    .option('--limit <n>', 'Maximum runs to return (1-100)', '20')
    .option('--offset <n>', 'Pagination offset', '0')
    .action(async (automationId: string, opts: { limit?: string; offset?: string }) => {
      const data = await apiRequest<AutomationRunsResponse>(automationRunsPath(automationId, opts), {
        workspace: true,
      })
      const enriched = runsWithConversationUrls(data)
      emitSuccess(enriched, renderAutomationRuns)
    })
}
