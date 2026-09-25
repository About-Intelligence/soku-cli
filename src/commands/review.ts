/** `soku review list | show <id> | open [id] | wait <id...> | approve <id> | deny <id>`
 *
 * HITL for review-gated write actions: a `soku call` of a write action returns
 * a pending review id and an `approve_url`. The person opens that link in a
 * browser where they are signed in to Soku and decides there; an agent waits
 * for the decision with `soku review wait`. `approve` / `deny` remain for a
 * person deciding in their own terminal.
 */

import { Command } from 'commander'
import open from 'open'

import { apiRequest } from '../http/client.js'
import {
  cyan,
  dim,
  emitError,
  emitSuccess,
  emitSuccessExit,
  ExitCode,
  green,
  red,
  table,
} from '../output/envelope.js'

export interface Review {
  id: string
  namespace: string
  action: string
  status: string
  decision?: string | null
  summary: string
  result?: unknown
  error?: unknown
  execution_task_id?: string | null
  created_at?: string | null
  auto_approved?: boolean
  approve_url?: string | null
}

/** A review is settled once it is neither waiting for a person nor running. */
export function isSettled(status: string): boolean {
  return status !== 'pending' && status !== 'executing'
}

export interface WaitOptions {
  timeoutMs: number
  /** First poll gap; doubles up to `maxIntervalMs`. */
  intervalMs?: number
  maxIntervalMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export interface WaitOutcome {
  settled: Review[]
  unsettled: Review[]
}

/** Poll each review until it settles or the deadline passes.
 *
 * Pure apart from the injected fetch, clock and sleep, so the command's
 * behaviour is testable without waiting in real time.
 */
export async function waitForReviews(
  ids: string[],
  fetchReview: (id: string) => Promise<Review>,
  opts: WaitOptions,
): Promise<WaitOutcome> {
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const maxInterval = opts.maxIntervalMs ?? 15_000
  let interval = opts.intervalMs ?? 3_000
  const deadline = now() + opts.timeoutMs
  const latest = new Map<string, Review>()
  for (;;) {
    for (const id of ids) {
      const previous = latest.get(id)
      if (previous && isSettled(previous.status)) continue
      latest.set(id, await fetchReview(id))
    }
    const reviews = ids.map((id) => latest.get(id) as Review)
    const unsettled = reviews.filter((r) => !isSettled(r.status))
    if (unsettled.length === 0 || now() >= deadline) {
      return { settled: reviews.filter((r) => isSettled(r.status)), unsettled }
    }
    await sleep(Math.min(interval, Math.max(0, deadline - now())))
    interval = Math.min(interval * 2, maxInterval)
  }
}

function statusMark(status: string): string {
  if (status === 'approved') return green('approved')
  if (status === 'executing') return cyan('executing')
  if (status === 'failed' || status === 'rejected') return red(status)
  return dim(status)
}

function statusIcon(status: string): string {
  if (status === 'approved') return green('✓')
  if (status === 'executing') return cyan('…')
  return red('✖')
}

function truncate(text: string, max: number): string {
  const one = (text ?? '').replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/** Pull a one-line error message out of a review's result/error blobs (which
 * arrive in several shapes across platforms). Empty string when there's no
 * actionable error to show. */
function describeReviewError(review: Review): string {
  const fromError = (e: unknown): string => {
    if (!e) return ''
    if (typeof e === 'string') return e
    if (typeof e === 'object') {
      const obj = e as Record<string, unknown>
      const msg = obj.error ?? obj.message
      if (typeof msg === 'string') return msg
    }
    return JSON.stringify(e)
  }
  // The dispatcher wraps the platform error under result.error / result.raw.error,
  // or surfaces it directly under review.error. Prefer the most specific message.
  const result = review.result as Record<string, unknown> | null | undefined
  const candidate =
    fromError(result?.error) ||
    fromError((result?.raw as Record<string, unknown> | undefined)?.error) ||
    fromError(review.error)
  return candidate ? truncate(candidate, 240) : ''
}

export function registerReviewCommands(program: Command): void {
  const review = program
    .command('review')
    .description('Approve or inspect review-gated write actions')

  review
    .command('list')
    .description('List your review-gated actions (pending and decided)')
    .option('--status <status>', 'Filter: pending | executing | approved | failed | rejected')
    .action(async (opts: { status?: string }) => {
      const q = opts.status ? `?status=${encodeURIComponent(opts.status)}` : ''
      const data = await apiRequest<{
        reviews: Review[]
        count: number
        inbox_url?: string | null
      }>(`/api/cli/reviews${q}`, {
        workspace: true,
      })
      emitSuccess(data, (d) => {
        const rows = table(
          d.reviews.map((r) => ({
            id: r.id,
            action: `${r.namespace}/${r.action}`,
            status: statusMark(r.status),
            summary: truncate(r.summary, 48),
          })),
          [
            { key: 'id', header: 'ID' },
            { key: 'action', header: 'ACTION' },
            { key: 'status', header: 'STATUS' },
            { key: 'summary', header: 'SUMMARY' },
          ],
        )
        const pending = d.reviews.some((r) => r.status === 'pending')
        return pending && d.inbox_url
          ? `${rows}\n${dim('Approve pending reviews in Soku:')} ${d.inbox_url}`
          : rows
      })
    })

  review
    .command('show <id>')
    .description('Show one review (full payload, executed payload, result)')
    .action(async (id: string) => {
      emitSuccess(
        await apiRequest(`/api/cli/reviews/${encodeURIComponent(id)}`, { workspace: true }),
      )
    })

  review
    .command('open [id]')
    .description(
      'Open the approval page for a review in your browser (all pending reviews when no id is given)',
    )
    .action(async (id?: string) => {
      const url = id
        ? (
            await apiRequest<Review>(`/api/cli/reviews/${encodeURIComponent(id)}`, {
              workspace: true,
            })
          ).approve_url
        : (
            await apiRequest<{ inbox_url?: string | null }>('/api/cli/reviews?status=pending', {
              workspace: true,
            })
          ).inbox_url
      if (!url) {
        return emitError(
          'no_approval_link',
          'Soku did not return an approval page for this workspace.',
          ExitCode.RUNTIME,
          id ? `Approve in this terminal with: soku review approve ${id}` : undefined,
        )
      }
      // Best effort: a headless shell has no browser; the URL is printed either way.
      await open(url).catch(() => undefined)
      emitSuccess({ url }, (d) => `Opened ${d.url}`)
    })

  review
    .command('wait <ids...>')
    .description(
      'Wait until reviews are decided and executed, then print the outcome (exit 5 if any was denied or failed)',
    )
    .option('--timeout <seconds>', 'Stop waiting after this many seconds', '540')
    .action(async (ids: string[], opts: { timeout: string }) => {
      const seconds = Number(opts.timeout)
      if (!Number.isFinite(seconds) || seconds <= 0) {
        return emitError('usage', '--timeout must be a positive number of seconds.', ExitCode.USAGE)
      }
      const outcome = await waitForReviews(
        ids,
        (id) => apiRequest<Review>(`/api/cli/reviews/${encodeURIComponent(id)}`, { workspace: true }),
        { timeoutMs: seconds * 1000 },
      )
      if (outcome.unsettled.length > 0) {
        const links = outcome.unsettled
          .map((r) => `${r.id}: ${r.approve_url ?? `soku review approve ${r.id}`}`)
          .join('; ')
        return emitError(
          'review_wait_timeout',
          `Still waiting on ${outcome.unsettled.length} review(s).`,
          ExitCode.RUNTIME,
          `Ask the user to decide: ${links}. Run \`soku review wait\` again to keep waiting.`,
          { pending: outcome.unsettled.map((r) => ({ id: r.id, status: r.status, approve_url: r.approve_url ?? null })) },
        )
      }
      const allApproved = outcome.settled.every((r) => r.status === 'approved')
      return emitSuccessExit(
        { reviews: outcome.settled },
        allApproved ? ExitCode.OK : ExitCode.RUNTIME,
        (d) =>
          d.reviews
            .map((r) => {
              const head = `${statusIcon(r.status)} ${statusMark(r.status)}: ${cyan(`${r.namespace}/${r.action}`)} ${dim(r.id)}`
              const errMsg = describeReviewError(r)
              return errMsg ? `${head}\n  ${red('error')} ${errMsg}` : head
            })
            .join('\n'),
      )
    })

  review
    .command('approve <id>')
    .description(
      'Approve a review from this terminal — executes or queues the write (for people; agents hand the user the approve_url instead)',
    )
    .action(async (id: string) => {
      const r = await apiRequest<Review>(`/api/cli/reviews/${encodeURIComponent(id)}/respond`, {
        method: 'POST',
        body: { decision: 'approve' },
        workspace: true,
      })
      emitSuccess(r, (d) => {
        const head = `${statusIcon(d.status)} ${statusMark(d.status)}: ${cyan(`${d.namespace}/${d.action}`)}`
        if (d.status === 'executing') {
          const task = d.execution_task_id ?? '(queued)'
          return `${head}\n  ${dim('task')} ${task}\n  ${dim('Poll with:')} soku review show ${d.id}`
        }
        // When execution failed (e.g. missing creative, CBO budget rule), surface the
        // error inline so the user can correct and retry without a separate `review show`.
        const errMsg = describeReviewError(d)
        return errMsg ? `${head}\n  ${red('error')} ${errMsg}` : head
      })
    })

  review
    .command('deny <id>')
    .description('Reject a review — the action is not executed')
    .option('--feedback <text>', 'Reason for rejecting')
    .action(async (id: string, opts: { feedback?: string }) => {
      const r = await apiRequest<Review>(`/api/cli/reviews/${encodeURIComponent(id)}/respond`, {
        method: 'POST',
        body: { decision: 'reject', feedback: opts.feedback },
        workspace: true,
      })
      emitSuccess(r, (d) => `${red('✖')} rejected: ${cyan(`${d.namespace}/${d.action}`)}`)
    })
}
