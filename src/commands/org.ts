/** `soku org list | use <id>` */

import { Command } from 'commander'

import { loadConfig, updateConfig } from '../config.js'
import { apiRequest } from '../http/client.js'
import { cyan, dim, emitError, emitSuccess, ExitCode, green, table } from '../output/envelope.js'
import { matchRef } from '../resolve.js'

interface Org {
  id: string
  name: string
  slug: string | null
}

export function registerOrgCommands(program: Command): void {
  const org = program.command('org').description('Manage the active organization')

  org
    .command('list')
    .description('List organizations you belong to')
    .action(async () => {
      const data = await apiRequest<{ orgs: Org[]; count: number }>('/api/cli/orgs')
      const activeOrgId = loadConfig().activeOrgId
      emitSuccess(data, (d) =>
        table(
          d.orgs.map((o) => ({
            active: o.id === activeOrgId ? green('●') : ' ',
            name: o.name,
            slug: o.slug ?? '',
            id: o.id,
          })),
          [
            { key: 'active', header: ' ' },
            { key: 'name', header: 'NAME' },
            { key: 'slug', header: 'SLUG' },
            { key: 'id', header: 'ID' },
          ],
        ),
      )
    })

  org
    .command('use <org>')
    .description('Set the active organization (accepts id, slug, or name)')
    .action(async (ref: string) => {
      const { orgs } = await apiRequest<{ orgs: Org[]; count: number }>('/api/cli/orgs')
      const res = matchRef(orgs, ref)
      if (res.kind === 'none') {
        emitError(
          'not_found',
          `No organization matching "${ref}".`,
          ExitCode.NOT_FOUND,
          'Run `soku org list` to see available orgs.',
        )
      }
      if (res.kind === 'ambiguous') {
        const candidates = res.matches.map((o) => `${o.slug ?? o.id} (${o.id})`).join(', ')
        emitError(
          'ambiguous',
          `"${ref}" matches ${res.matches.length} organizations.`,
          ExitCode.USAGE,
          `Use a slug or id: ${candidates}`,
        )
      }
      const match = res.item
      // Switching org clears the brand — it may not belong to the new org.
      const prev = loadConfig()
      updateConfig({
        activeOrgId: match.id,
        activeBrandId: prev.activeOrgId === match.id ? prev.activeBrandId : undefined,
      })
      emitSuccess(
        { active_org_id: match.id, name: match.name, slug: match.slug },
        (d) =>
          `${green('✓')} Active org: ${cyan(d.name ?? d.active_org_id)} ${dim(`(${d.active_org_id})`)}\n  ${dim('Next: soku brand use <slug|id>')}`,
      )
    })
}
