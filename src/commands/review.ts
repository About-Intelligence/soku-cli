/** `soku review list | show <id> | approve <id> | deny <id>`
 *
 * HITL for review-gated write actions: a `soku call` of a write action returns
 * a pending review id; the user approves it here, which executes the action.
 */

import { Command } from 'commander'

import { apiRequest } from '../http/client.js'
import { cyan, dim, emitSuccess, green, red, table } from '../output/envelope.js'

interface Review {
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
      const data = await apiRequest<{ reviews: Review[]; count: number }>(`/api/cli/reviews${q}`, {
        workspace: true,
      })
      emitSuccess(data, (d) =>
        table(
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
        ),
      )
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
    .command('approve <id>')
    .description('Approve a review — executes or queues the write action')
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
