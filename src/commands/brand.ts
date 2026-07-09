/** `soku brand list | use <id>` */

import { Command } from 'commander'

import { loadConfig, updateConfig } from '../config.js'
import { apiRequest } from '../http/client.js'
import { cyan, dim, emitError, emitSuccess, ExitCode, green, table } from '../output/envelope.js'
import { matchRef, type MatchResult } from '../resolve.js'
import { registerBrandSkillCommands } from './brand-skill.js'

interface Brand {
  id: string
  name: string
  slug: string
  org_id: string
  org_name?: string
  org_slug?: string | null
}

export function registerBrandCommands(program: Command): void {
  const brand = program.command('brand').description('Manage the active brand')
  registerBrandSkillCommands(brand)

  brand
    .command('list')
    .description('List brands in the active organization')
    .option('--org <orgId>', 'Organization to list brands for (defaults to active org)')
    .action(async (opts) => {
      const orgId = opts.org || loadConfig().activeOrgId
      if (!orgId) {
        emitError(
          'no_org',
          'No active organization.',
          ExitCode.USAGE,
          'Run `soku org use <id>` or pass --org.',
        )
      }
      const data = await apiRequest<{ brands: Brand[]; count: number }>(
        `/api/cli/brands?org_id=${encodeURIComponent(orgId)}`,
      )
      const activeBrandId = loadConfig().activeBrandId
      emitSuccess(data, (d) =>
        table(
          d.brands.map((b) => ({
            active: b.id === activeBrandId ? green('●') : ' ',
            name: b.name,
            slug: b.slug,
            id: b.id,
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

  brand
    .command('find <query>')
    .description('Search accessible brands across all organizations')
    .option('--limit <n>', 'Maximum candidates to show', '20')
    .action(async (query: string, opts: { limit: string }) => {
      const limit = Number(opts.limit)
      if (!Number.isFinite(limit) || limit < 1) {
        emitError('usage', '--limit must be a positive number.', ExitCode.USAGE)
      }
      const data = await apiRequest<{ brands: Brand[]; count: number }>(
        `/api/cli/brands/search?q=${encodeURIComponent(query)}&limit=${encodeURIComponent(String(limit))}`,
      )
      emitSuccess(data, (d) =>
        table(
          d.brands.map((b) => ({
            name: b.name,
            slug: b.slug,
            org: b.org_slug || b.org_name || b.org_id,
            id: b.id,
          })),
          [
            { key: 'name', header: 'NAME' },
            { key: 'slug', header: 'SLUG' },
            { key: 'org', header: 'ORG' },
            { key: 'id', header: 'ID' },
          ],
        ),
      )
    })

  brand
    .command('use <brand>')
    .description('Set the active brand (accepts id, slug, or name)')
    .option('--any-org', 'Search all accessible organizations and set org+brand together')
    .action(async (ref: string, opts: { anyOrg?: boolean }) => {
      if (opts.anyOrg) {
        const { brands } = await apiRequest<{ brands: Brand[]; count: number }>(
          `/api/cli/brands/search?q=${encodeURIComponent(ref)}&limit=20`,
        )
        const res = resolveSearchMatch(brands, ref)
        if (res.kind === 'none') {
          emitError(
            'not_found',
            `No accessible brand matching "${ref}".`,
            ExitCode.NOT_FOUND,
            'Run `soku workspace resolve <brand>` to see candidates.',
          )
        }
        if (res.kind === 'ambiguous') {
          const candidates = res.matches
            .map((b) => `${b.slug} (${b.org_slug || b.org_name || b.org_id})`)
            .join(', ')
          emitError(
            'ambiguous',
            `"${ref}" matches ${res.matches.length} brands.`,
            ExitCode.USAGE,
            `Use an exact slug or id: ${candidates}`,
          )
        }
        const match = res.item
        updateConfig({ activeOrgId: match.org_id, activeBrandId: match.id })
        emitSuccess(
          {
            active_org_id: match.org_id,
            active_brand_id: match.id,
            name: match.name,
            org_name: match.org_name,
            org_slug: match.org_slug,
          },
          (d) =>
            `${green('✓')} Active workspace: ${cyan(d.org_slug || d.org_name || d.active_org_id)} / ${cyan(d.name)} ${dim(`(${d.active_brand_id})`)}\n  ${dim('Next: soku resources list')}`,
        )
        return
      }

      const cfg = loadConfig()
      if (!cfg.activeOrgId) {
        emitError(
          'no_org',
          'Select an organization first.',
          ExitCode.USAGE,
          'Run `soku org use <slug|id>`.',
        )
      }
      const { brands } = await apiRequest<{ brands: Brand[]; count: number }>(
        `/api/cli/brands?org_id=${encodeURIComponent(cfg.activeOrgId)}`,
      )
      const res = matchRef(brands, ref)
      if (res.kind === 'none') {
        emitError(
          'not_found',
          `No brand matching "${ref}" in the active org.`,
          ExitCode.NOT_FOUND,
          'Run `soku brand list` to see available brands.',
        )
      }
      if (res.kind === 'ambiguous') {
        const candidates = res.matches.map((b) => `${b.slug} (${b.id})`).join(', ')
        emitError(
          'ambiguous',
          `"${ref}" matches ${res.matches.length} brands.`,
          ExitCode.USAGE,
          `Use a slug or id: ${candidates}`,
        )
      }
      const match = res.item
      updateConfig({ activeBrandId: match.id })
      emitSuccess(
        { active_org_id: cfg.activeOrgId, active_brand_id: match.id, name: match.name },
        (d) =>
          `${green('✓')} Active brand: ${cyan(d.name)} ${dim(`(${d.active_brand_id})`)}\n  ${dim('Next: soku --help (data commands under each namespace)')}`,
      )
    })
}

function resolveSearchMatch(brands: Brand[], ref: string): MatchResult<Brand> {
  const exact = matchRef(brands, ref)
  if (exact.kind !== 'none') return exact
  if (brands.length === 1) return { kind: 'match', item: brands[0] }
  if (brands.length > 1) return { kind: 'ambiguous', matches: brands }
  return { kind: 'none' }
}
