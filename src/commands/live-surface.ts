/** `soku live-surfaces open | list | revoke | rotate-credential`
 *
 * A live surface is a link you hand to a person. They open it in their own
 * browser and watch the resource change as you work on it, edit it themselves,
 * and clear the writes that need a human.
 *
 * The approval credential is printed once, by `open` and `rotate-credential`,
 * and never appears in the URL. That separation is the whole point: a link
 * travels — forwarded, pasted, screenshotted — and a credential travelling with
 * it would prove nothing while looking like proof. What gets recorded as
 * "who approved this" depends on it.
 */

import { Command } from 'commander'

import { apiRequest } from '../http/client.js'
import { bold, dim, emitSuccess, table } from '../output/envelope.js'

interface OpenedSurface {
  url: string
  expiresAt?: string | null
  approvalCredential?: string | null
  approvalCredentialNote?: string | null
}

interface ListedSurface {
  url: string
  capabilities: string[]
  origin: string
  expiresAt?: string | null
  lastSeenAt?: string | null
}

export function registerLiveSurfaceCommands(program: Command): void {
  const surfaces = program
    .command('live-surfaces')
    .description('Hand someone a live link to a resource you are working on')

  surfaces
    .command('open <resource-id>')
    .description('Open a link for a resource and print it with its approval code')
    .option('--type <type>', "Resource kind (default: 'remix_project')", 'remix_project')
    .option('--read-only', 'Let them watch but not edit')
    .option('--no-approvals', 'Do not issue an approval code for this link')
    .option('--ttl-hours <hours>', 'How long the link stays usable (default 12, max 168)')
    .action(
      async (
        resourceId: string,
        opts: { type: string; readOnly?: boolean; approvals: boolean; ttlHours?: string },
      ) => {
        const data = await apiRequest<OpenedSurface>('/api/cli/live-surfaces', {
          method: 'POST',
          workspace: true,
          body: {
            resource_type: opts.type,
            resource_id: resourceId,
            writable: !opts.readOnly,
            approvable: opts.approvals,
            ...(opts.ttlHours ? { ttl_hours: Number(opts.ttlHours) } : {}),
          },
        })
        emitSuccess(data, (d) => {
          const lines = [bold('Link  ') + d.url]
          if (d.expiresAt) lines.push(dim('Expires ') + d.expiresAt)
          if (d.approvalCredential) {
            lines.push('')
            lines.push(bold('Approval code  ') + d.approvalCredential)
            // Printed on its own line, away from the URL, because the two must
            // reach the person by different routes.
            lines.push(dim(d.approvalCredentialNote ?? 'Give this to the person, not the link.'))
          }
          return lines.join('\n')
        })
      },
    )

  surfaces
    .command('list <resource-id>')
    .description('Links still open on a resource, so you do not hand out a second one')
    .option('--type <type>', "Resource kind (default: 'remix_project')", 'remix_project')
    .action(async (resourceId: string, opts: { type: string }) => {
      const query = `?resource_id=${encodeURIComponent(resourceId)}&resource_type=${encodeURIComponent(opts.type)}`
      const data = await apiRequest<{ surfaces: ListedSurface[] }>(
        `/api/cli/live-surfaces${query}`,
        { workspace: true },
      )
      emitSuccess(data, (d) =>
        table(
          d.surfaces.map((s) => ({
            url: s.url,
            can: s.capabilities.join(','),
            origin: s.origin,
            expires: s.expiresAt ?? '',
          })),
          [
            { key: 'url', header: 'URL' },
            { key: 'can', header: 'CAN' },
            { key: 'origin', header: 'OPENED BY' },
            { key: 'expires', header: 'EXPIRES' },
          ],
        ),
      )
    })

  surfaces
    .command('revoke <handle>')
    .description('Kill a link. Anyone still holding it loses access immediately')
    .action(async (handle: string) => {
      emitSuccess(
        await apiRequest(`/api/cli/live-surfaces/${encodeURIComponent(handle)}`, {
          method: 'DELETE',
          workspace: true,
        }),
        () => 'Revoked.',
      )
    })

  surfaces
    .command('rotate-credential <handle>')
    .description('Issue a fresh approval code, leaving the link itself alive')
    .action(async (handle: string) => {
      const data = await apiRequest<{ approvalCredential: string }>(
        `/api/cli/live-surfaces/${encodeURIComponent(handle)}/approval-credential`,
        { method: 'POST', workspace: true },
      )
      // Rotating is for a code that reached the wrong person. Killing the link
      // as well would cost the right person their work surface for someone
      // else's mistake, so the two are separate commands.
      emitSuccess(data, (d) => bold('New approval code  ') + d.approvalCredential)
    })
}
