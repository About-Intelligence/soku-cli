/** `soku credits` — the workspace balance, and what your recent egress calls cost. */

import { Command } from 'commander'

import { apiRequest } from '../http/client.js'
import { bold, dim, emitSuccess, table } from '../output/envelope.js'

export interface CreditCharge {
  occurred_at: string
  provider: string | null
  endpoint: string | null
  path: string | null
  http_status: number | null
  credits: number
  balance_after: number | null
}

export interface CreditsResponse {
  balance: number
  plan: string | null
  window_days: number
  charges: CreditCharge[]
}

export function renderCredits(data: CreditsResponse): string {
  const plan = data.plan ? `plan ${data.plan}` : 'no paid plan'
  const heading = `${bold(`Balance: ${data.balance} credits`)} ${dim(`(${plan})`)}`
  if (data.charges.length === 0) {
    return `${heading}\n${dim(`No egress calls by you in the last ${data.window_days} days.`)}`
  }
  const spent = data.charges.reduce((sum, charge) => sum + charge.credits, 0)
  const rows = data.charges.map((charge) => ({
    when: charge.occurred_at.replace('T', ' ').slice(0, 19),
    provider: charge.provider ?? '',
    path: charge.path ?? charge.endpoint ?? '',
    status: charge.http_status ?? '',
    credits: charge.credits,
    balance: charge.balance_after ?? '',
  }))
  return [
    heading,
    `Your last ${data.charges.length} egress calls (${data.window_days} days): ${spent} credits`,
    table(rows, [
      { key: 'when', header: 'WHEN (UTC)' },
      { key: 'provider', header: 'PROVIDER' },
      { key: 'path', header: 'PATH' },
      { key: 'status', header: 'HTTP' },
      { key: 'credits', header: 'CREDITS' },
      { key: 'balance', header: 'BALANCE AFTER' },
    ]),
  ].join('\n')
}

export function registerCreditsCommands(program: Command): void {
  program
    .command('credits')
    .description('Show the workspace credit balance and what your recent egress calls cost')
    .action(async () => {
      const data = await apiRequest<CreditsResponse>('/api/cli/credits', { workspace: true })
      emitSuccess(data, renderCredits)
    })
}
