/** `soku workspace` — inspect and resolve the active org/brand selection. */

import { Command } from 'commander'

import { loadConfig, updateConfig } from '../config.js'
import { apiRequest } from '../http/client.js'
import { cyan, dim, emitError, emitSuccess, ExitCode, green, table } from '../output/envelope.js'
import { matchRef, type MatchResult } from '../resolve.js'

interface Org {
  id: string
  name: string
  slug: string | null
}

interface Brand {
  id: string
  name: string
  slug: string
  org_id: string
  org_name?: string
  org_slug?: string | null
}

interface BrandResolveResult {
  resolved: boolean
  reason: 'match' | 'ambiguous' | 'not_found'
  brand: Brand | null
  candidates: Brand[]
}

function resolveSearchMatch(brands: Brand[], ref: string): MatchResult<Brand> {
  const exact = matchRef(brands, ref)
  if (exact.kind !== 'none') return exact
  if (brands.length === 1) return { kind: 'match', item: brands[0] }
  if (brands.length > 1) return { kind: 'ambiguous', matches: brands }
  return { kind: 'none' }
}

async function searchBrands(query: string, limit: number): Promise<Brand[]> {
  const data = await apiRequest<{ brands: Brand[]; count: number }>(
    `/api/cli/brands/search?q=${encodeURIComponent(query)}&limit=${encodeURIComponent(String(limit))}`,
  )
  return data.brands
}

function resolveBrandCandidates(brands: Brand[], ref: string): BrandResolveResult {
  const res = resolveSearchMatch(brands, ref)
  if (res.kind === 'match') {
    return { resolved: true, reason: 'match', brand: res.item, candidates: [res.item] }
  }
  if (res.kind === 'ambiguous') {
    return { resolved: false, reason: 'ambiguous', brand: null, candidates: res.matches }
  }
  return { resolved: false, reason: 'not_found', brand: null, candidates: [] }
}

function renderBrandCandidates(candidates: Brand[]): string {
  return table(
    candidates.map((b) => ({
      name: b.name,
      slug: b.slug,
      org: b.org_slug || b.org_name || b.org_id,
      id: b.id,
    })),
    [
      { key: 'name', header: 'BRAND' },
      { key: 'slug', header: 'SLUG' },
      { key: 'org', header: 'ORG' },
      { key: 'id', header: 'ID' },
    ],
  )
}

function useResolvedBrand(result: BrandResolveResult, ref: string): Brand {
  if (result.resolved && result.brand) return result.brand
  if (result.reason === 'not_found') {
    emitError('not_found', `No accessible brand matching "${ref}".`, ExitCode.NOT_FOUND, 'Run `soku workspace resolve <brand>` to inspect candidates.')
  }
  const candidates = result.candidates.map((b) => `${b.slug} (${b.org_slug || b.org_name || b.org_id})`).join(', ')
  return emitError(
    'ambiguous',
    `"${ref}" matches ${result.candidates.length} brands.`,
    ExitCode.USAGE,
    `Use an exact slug or id: ${candidates}`,
  )
}

export function registerWorkspaceCommands(program: Command): void {
  const workspace = program.command('workspace').description('Inspect or set the active Soku workspace')

  workspace
    .command('status')
    .description('Show the active organization and brand')
    .action(async () => {
      const cfg = loadConfig()
      const orgsData = await apiRequest<{ orgs: Org[]; count: number }>('/api/cli/orgs')
      const org = cfg.activeOrgId ? orgsData.orgs.find((item) => item.id === cfg.activeOrgId) : undefined
      let brand: Brand | undefined
      if (org && cfg.activeBrandId) {
        const brandsData = await apiRequest<{ brands: Brand[]; count: number }>(
          `/api/cli/brands?org_id=${encodeURIComponent(org.id)}`,
        )
        brand = brandsData.brands.find((item) => item.id === cfg.activeBrandId)
      }

      const data = {
        active_org_id: cfg.activeOrgId ?? null,
        active_org_name: org?.name ?? null,
        active_org_slug: org?.slug ?? null,
        active_brand_id: cfg.activeBrandId ?? null,
        active_brand_name: brand?.name ?? null,
        active_brand_slug: brand?.slug ?? null,
        workspace_ready: Boolean(org && brand),
      }
      emitSuccess(data, (d) => {
        const orgLabel = d.active_org_slug || d.active_org_name || d.active_org_id || '(none)'
        const brandLabel = d.active_brand_slug || d.active_brand_name || d.active_brand_id || '(none)'
        const ready = d.workspace_ready ? green('ready') : 'not ready'
        return [
          `Workspace: ${ready}`,
          `Org: ${orgLabel}`,
          `Brand: ${brandLabel}`,
          d.workspace_ready
            ? dim('Next: soku resources list')
            : dim('Next: soku workspace use-brand <brand>'),
        ].join('\n')
      })
    })

  workspace
    .command('resolve <brand>')
    .description('Resolve a brand across all accessible organizations without changing workspace')
    .option('--limit <n>', 'Maximum candidates to inspect', '20')
    .action(async (ref: string, opts: { limit: string }) => {
      const limit = Number(opts.limit)
      if (!Number.isFinite(limit) || limit < 1) {
        emitError('usage', '--limit must be a positive number.', ExitCode.USAGE)
      }
      const result = resolveBrandCandidates(await searchBrands(ref, limit), ref)
      emitSuccess(result, (d) => {
        if (d.resolved && d.brand) {
          const org = d.brand.org_slug || d.brand.org_name || d.brand.org_id
          return [
            `${green('✓')} Resolved brand: ${cyan(org)} / ${cyan(d.brand.name)} ${dim(`(${d.brand.id})`)}`,
            dim(`Next: soku workspace use-brand ${ref}`),
          ].join('\n')
        }
        if (d.reason === 'not_found') return `${dim('(no accessible brand candidates)')}\n${dim('Try a different brand name or slug.')}`
        return [
          `${dim(`Ambiguous: ${d.candidates.length} candidates`)}`,
          renderBrandCandidates(d.candidates),
          dim('Next: rerun with an exact brand slug or id.'),
        ].join('\n')
      })
    })

  workspace
    .command('use-brand <brand>')
    .description('Resolve a brand across all organizations and set org+brand together')
    .action(async (ref: string) => {
      const result = resolveBrandCandidates(await searchBrands(ref, 20), ref)
      const match = useResolvedBrand(result, ref)
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
    })
}
