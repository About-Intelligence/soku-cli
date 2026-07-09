/** `soku seo-hosting` — manage file-based SEO Hosting pages and domain connections. */

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

import { Command } from 'commander'

import { apiRequest } from '../http/client.js'
import { bold, cyan, dim, emitError, emitSuccess, ExitCode, table } from '../output/envelope.js'
import { unwrapDispatch } from '../output/unwrap.js'

const CONNECTIONS_PATH = '/api/cli/seo-hosting/domain-connections'
const ASSETS_PATH = '/api/cli/seo-hosting/assets'
const SEO_HOSTING_CALL_PATH = '/api/cli/call/seo_hosting'
const DEFAULT_SECTIONS = ['blog']
const ALLOWED_SECTIONS = new Set(['blog', 'use-cases', 'alternatives'])

export interface DomainConnection {
  id: string
  brand_id: string
  hostname: string
  method: string
  expected_cname_target?: string | null
  origin_hostname?: string | null
  status: string
  ssl_status: string
  mounted_sections?: string[] | null
  last_verified_at?: string | null
  last_checked_at?: string | null
  last_error?: string | null
  created_at?: string | null
  cf_verification_data?: Record<string, unknown> | null
}

interface DomainConnectionListResponse {
  items: DomainConnection[]
  count: number
}

interface HostingStatusDomain {
  hostname: string
  method: string
  status: string
  live: boolean
  url_contract: string
  served_sections: string[]
  public_base_url: string
}

interface HostingStatusResponse {
  domains: HostingStatusDomain[]
  allowed_sections: string[]
  asset_cdn_base_url: string
  workspace_dir: string
  note: string
}

/** A file-based SEO page (no markdown body — the document IS the HTML file). */
interface SeoHostingPage {
  section: string
  slug: string
  title: string
  description?: string | null
  status: string
  template?: string | null
  url_path: string
  published_at?: string | null
  updated_at?: string | null
  public_url?: string | null
  served?: boolean
  /** Advisory dead-internal-link warnings from publish (do not block publishing). */
  link_warnings?: string[]
}

interface PageListResponse {
  items: SeoHostingPage[]
  count: number
}

interface AssetUploadResponse {
  url: string
  path: string
  size_bytes: number
}

export interface WorkerProbeResponse {
  is_cloudflare: boolean
  conflicts: string[]
  serves_next_assets: boolean
  is_vercel: boolean
}

interface WorkerRiskOptions {
  acceptConflicts?: boolean
  acceptNextAssetsWarning?: boolean
}

interface WorkerConnectOptions extends WorkerRiskOptions {
  hostname: string
  sections?: string
  cfTokenEnv?: string
  cfTokenStdin?: boolean
}

interface CloudflareTokenOptions {
  cfTokenEnv?: string
  cfTokenStdin?: boolean
}

interface HtmlBodyOptions {
  html?: string
  htmlFile?: string
  htmlStdin?: boolean
}

interface PagePutOptions extends HtmlBodyOptions {
  section: string
  slug: string
  title: string
  description?: string
  template?: string
  seo?: string
}

export class SeoHostingUsageError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message)
  }
}

export function domainConnectionPath(connectionId?: string, suffix?: string): string {
  if (!connectionId) return CONNECTIONS_PATH
  const encoded = encodeURIComponent(connectionId)
  return `${CONNECTIONS_PATH}/${encoded}${suffix ? `/${suffix}` : ''}`
}

export function seoHostingCallPath(action: string): string {
  return `${SEO_HOSTING_CALL_PATH}/${encodeURIComponent(action)}`
}

export function parseSections(raw?: string): string[] {
  if (!raw || !raw.trim()) return [...DEFAULT_SECTIONS]
  const sections = raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  const unknown = sections.filter((section) => !ALLOWED_SECTIONS.has(section))
  if (unknown.length > 0) {
    throw new SeoHostingUsageError(
      `Unsupported section: ${unknown.join(', ')}`,
      'Allowed sections: blog, use-cases, alternatives.',
    )
  }
  return [...new Set(sections)]
}

export function validateCloudflareTokenOptions(opts: CloudflareTokenOptions): void {
  const sources = [opts.cfTokenEnv, opts.cfTokenStdin].filter(Boolean)
  if (sources.length !== 1) {
    throw new SeoHostingUsageError(
      'Provide exactly one Cloudflare token source.',
      'Use --cf-token-env NAME or --cf-token-stdin.',
    )
  }
}

async function readAll(input: AsyncIterable<Buffer | string>): Promise<string> {
  let out = ''
  for await (const chunk of input) out += chunk.toString()
  return out
}

export async function readCloudflareToken(opts: CloudflareTokenOptions): Promise<string> {
  validateCloudflareTokenOptions(opts)
  if (opts.cfTokenEnv) {
    const token = process.env[opts.cfTokenEnv]?.trim()
    if (!token) {
      throw new SeoHostingUsageError(
        `Environment variable ${opts.cfTokenEnv} is empty or unset.`,
        `Export ${opts.cfTokenEnv} before running connect-worker.`,
      )
    }
    return token
  }
  const token = (await readAll(process.stdin)).trim()
  if (!token) {
    throw new SeoHostingUsageError(
      'No Cloudflare token was received on stdin.',
      'Pipe the token into the command, for example: printf %s "$CF_TOKEN" | soku seo-hosting connections connect-worker --cf-token-stdin ...',
    )
  }
  return token
}

export function workerProbeBlocker(
  probe: WorkerProbeResponse,
  opts: WorkerRiskOptions,
): SeoHostingUsageError | null {
  if (!probe.is_cloudflare) {
    const hint = probe.is_vercel
      ? 'This hostname appears to be on Vercel. Use the Web OAuth flow until Vercel CLI support lands.'
      : 'Cloudflare Worker routes require the hostname zone to be on Cloudflare.'
    return new SeoHostingUsageError('Hostname is not using Cloudflare nameservers.', hint)
  }
  if (probe.conflicts.length > 0 && !opts.acceptConflicts) {
    return new SeoHostingUsageError(
      `Mount paths already serve content: ${probe.conflicts.join(', ')}.`,
      'Pass --accept-conflicts after confirming the SEO Hosting Worker may shadow those paths.',
    )
  }
  if (probe.serves_next_assets && !opts.acceptNextAssetsWarning) {
    return new SeoHostingUsageError(
      'The hostname appears to serve its own Next.js assets.',
      'Pass --accept-next-assets-warning after confirming /_next/static/* can be routed through the Worker.',
    )
  }
  return null
}

export async function callSeoHostingAction<T>(
  action: string,
  payload: Record<string, unknown> = {},
): Promise<T> {
  const result = await apiRequest(seoHostingCallPath(action), {
    method: 'POST',
    workspace: true,
    body: payload,
  })
  return unwrapDispatch(result) as T
}

export function parseSeoOverride(raw?: string): Record<string, unknown> | undefined {
  if (!raw) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new SeoHostingUsageError('--seo must be valid JSON.')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SeoHostingUsageError('--seo must be a JSON object.')
  }
  return parsed as Record<string, unknown>
}

/** Read the page HTML from exactly one of --html / --html-file / --html-stdin. */
export async function readHtmlBody(opts: HtmlBodyOptions): Promise<string> {
  const sources = [opts.html !== undefined, opts.htmlFile, opts.htmlStdin].filter(Boolean)
  if (sources.length !== 1) {
    throw new SeoHostingUsageError(
      'Provide exactly one HTML source.',
      'Use --html, --html-file, or --html-stdin.',
    )
  }
  let html: string
  if (opts.htmlFile) {
    try {
      html = readFileSync(opts.htmlFile, 'utf8')
    } catch (err) {
      throw new SeoHostingUsageError(
        `Could not read HTML file: ${opts.htmlFile}`,
        (err as Error).message,
      )
    }
  } else if (opts.htmlStdin) {
    html = await readAll(process.stdin)
  } else {
    html = opts.html ?? ''
  }
  if (!html.trim()) {
    throw new SeoHostingUsageError('Page HTML cannot be empty.')
  }
  return html
}

export async function buildPagePutPayload(
  opts: PagePutOptions,
): Promise<Record<string, unknown>> {
  const html = await readHtmlBody(opts)
  const payload: Record<string, unknown> = {
    section: opts.section,
    slug: opts.slug,
    title: opts.title,
    html,
  }
  addString(payload, 'description', opts.description)
  addString(payload, 'template', opts.template)
  const seo = parseSeoOverride(opts.seo)
  if (seo) payload.seo = seo
  return payload
}

function addString(payload: Record<string, unknown>, key: string, value?: string): void {
  if (value !== undefined && value.trim()) payload[key] = value
}

export function renderHostingStatus(status: HostingStatusResponse): string {
  const rows = [
    `${bold('Allowed sections')}: ${status.allowed_sections.join(', ')}`,
    `${bold('Asset CDN')}: ${status.asset_cdn_base_url}`,
    `${bold('Workspace dir')}: ${status.workspace_dir}`,
  ]
  if (status.domains.length > 0) {
    rows.push('', bold('Domains'), renderStatusDomains(status.domains))
  } else {
    rows.push('', dim('No domain connections yet.'))
  }
  return rows.join('\n')
}

function renderStatusDomains(items: HostingStatusDomain[]): string {
  return table(
    items.map((item) => ({
      hostname: item.hostname,
      method: item.method,
      status: item.status,
      live: item.live ? 'yes' : 'no',
      contract: item.url_contract,
      sections: item.served_sections.join(',') || '',
    })),
    [
      { key: 'hostname', header: 'HOSTNAME' },
      { key: 'method', header: 'METHOD' },
      { key: 'status', header: 'STATUS' },
      { key: 'live', header: 'LIVE' },
      { key: 'contract', header: 'CONTRACT' },
      { key: 'sections', header: 'SECTIONS' },
    ],
  )
}

export function renderPages(items: SeoHostingPage[]): string {
  return table(
    items.map((item) => ({
      section: item.section,
      slug: item.slug,
      status: item.status,
      title: item.title || '',
      url: item.url_path,
    })),
    [
      { key: 'section', header: 'SECTION' },
      { key: 'slug', header: 'SLUG' },
      { key: 'status', header: 'STATUS' },
      { key: 'title', header: 'TITLE' },
      { key: 'url', header: 'URL' },
    ],
  )
}

export function renderPage(page: SeoHostingPage): string {
  const rows = [
    `${bold('Section')}: ${page.section}`,
    `${bold('Slug')}: ${cyan(page.slug)}`,
    `${bold('Title')}: ${page.title}`,
    `${bold('Status')}: ${page.status}`,
    `${bold('URL path')}: ${page.url_path}`,
  ]
  if (page.description) rows.push(`${bold('Description')}: ${page.description}`)
  if (page.template) rows.push(`${bold('Template')}: ${page.template}`)
  if (page.published_at) rows.push(`${bold('Published')}: ${page.published_at}`)
  if (page.public_url) rows.push(`${bold('Public URL')}: ${page.public_url}`)
  if (page.served !== undefined) {
    rows.push(`${bold('Served')}: ${page.served ? 'yes' : 'no'}`)
  }
  if (page.link_warnings && page.link_warnings.length > 0) {
    rows.push(`${bold('Link warnings')}:`)
    for (const w of page.link_warnings) rows.push(`  - ${w}`)
  }
  return rows.join('\n')
}

export function renderAssetUpload(asset: AssetUploadResponse): string {
  return [
    `${bold('URL')}: ${cyan(asset.url)}`,
    `${bold('Path')}: ${asset.path}`,
    `${bold('Size')}: ${asset.size_bytes} bytes`,
  ].join('\n')
}

export function renderConnections(items: DomainConnection[]): string {
  return table(
    items.map((item) => ({
      id: item.id,
      hostname: item.hostname,
      method: item.method,
      status: item.status,
      ssl: item.ssl_status,
      sections: item.mounted_sections?.join(',') || '',
    })),
    [
      { key: 'id', header: 'ID' },
      { key: 'hostname', header: 'HOSTNAME' },
      { key: 'method', header: 'METHOD' },
      { key: 'status', header: 'STATUS' },
      { key: 'ssl', header: 'SSL' },
      { key: 'sections', header: 'SECTIONS' },
    ],
  )
}

export function renderConnection(connection: DomainConnection): string {
  const rows = [
    `${bold('ID')}: ${cyan(connection.id)}`,
    `${bold('Hostname')}: ${connection.hostname}`,
    `${bold('Method')}: ${connection.method}`,
    `${bold('Status')}: ${connection.status}`,
    `${bold('SSL')}: ${connection.ssl_status}`,
  ]
  if (connection.expected_cname_target) {
    rows.push(`${bold('Expected CNAME')}: ${connection.expected_cname_target}`)
  }
  if (connection.mounted_sections?.length) {
    rows.push(`${bold('Sections')}: ${connection.mounted_sections.join(', ')}`)
  }
  if (connection.last_error) {
    rows.push(`${bold('Last error')}: ${connection.last_error}`)
  }
  return rows.join('\n')
}

export function renderWorkerProbe(probe: WorkerProbeResponse): string {
  return [
    `${bold('Cloudflare')}: ${probe.is_cloudflare ? 'yes' : 'no'}`,
    `${bold('Vercel')}: ${probe.is_vercel ? 'yes' : 'no'}`,
    `${bold('Conflicts')}: ${probe.conflicts.length ? probe.conflicts.join(', ') : dim('(none)')}`,
    `${bold('Next.js assets')}: ${probe.serves_next_assets ? 'yes' : 'no'}`,
  ].join('\n')
}

function usageError(error: unknown): never {
  if (error instanceof SeoHostingUsageError) {
    emitError('usage', error.message, ExitCode.USAGE, error.hint)
  }
  throw error
}

export function registerSeoHostingCommands(program: Command): void {
  const seoHosting = program.command('seo-hosting').description('Manage SEO Hosting')

  seoHosting
    .command('status')
    .description('Show this brand SEO Hosting setup: domains, live state, URL contract')
    .action(async () => {
      const data = await callSeoHostingAction<HostingStatusResponse>('get_status')
      emitSuccess(data, renderHostingStatus)
    })

  const pages = seoHosting.command('pages').description('Manage SEO Hosting pages')

  pages
    .command('list')
    .description('List file-based SEO Hosting pages for the active brand')
    .option('--section <section>', 'Filter by section: blog, use-cases, alternatives')
    .option('--status <status>', 'Filter by status: draft, published, archived')
    .action(async (opts: { section?: string; status?: string }) => {
      const payload: Record<string, unknown> = {}
      addString(payload, 'section', opts.section)
      addString(payload, 'status', opts.status)
      const data = await callSeoHostingAction<PageListResponse>('list_pages', payload)
      emitSuccess(data, (d) => renderPages(d.items))
    })

  pages
    .command('put')
    .description('Create or overwrite a page (as draft) from an HTML document')
    .requiredOption('--section <section>', 'Content section: blog, use-cases, alternatives')
    .requiredOption('--slug <slug>', 'Page slug (folder name under the section)')
    .requiredOption('--title <title>', 'Page title')
    .option('--html <html>', 'The full HTML document')
    .option('--html-file <path>', 'Read the HTML document from a file')
    .option('--html-stdin', 'Read the HTML document from stdin')
    .option('--description <text>', 'Meta description')
    .option('--template <name>', 'Template name this page was built from')
    .option('--seo <json>', 'SEO overrides JSON object')
    .action(async (opts: PagePutOptions) => {
      let payload: Record<string, unknown>
      try {
        payload = await buildPagePutPayload(opts)
      } catch (err) {
        usageError(err)
      }
      const data = await callSeoHostingAction<SeoHostingPage>('put_page', payload)
      emitSuccess(data, renderPage)
    })

  pages
    .command('publish')
    .description('Validate and publish a page (makes it live once the domain is live)')
    .requiredOption('--section <section>', 'Content section')
    .requiredOption('--slug <slug>', 'Page slug')
    .action(async (opts: { section: string; slug: string }) => {
      const data = await callSeoHostingAction<SeoHostingPage>('publish_page', {
        section: opts.section,
        slug: opts.slug,
      })
      emitSuccess(data, renderPage)
    })

  pages
    .command('unpublish')
    .description('Unpublish a page (back to draft; stops serving)')
    .requiredOption('--section <section>', 'Content section')
    .requiredOption('--slug <slug>', 'Page slug')
    .action(async (opts: { section: string; slug: string }) => {
      const data = await callSeoHostingAction<SeoHostingPage>('unpublish_page', {
        section: opts.section,
        slug: opts.slug,
      })
      emitSuccess(data, renderPage)
    })

  pages
    .command('delete')
    .description('Delete a page folder (index.html + page.json)')
    .requiredOption('--section <section>', 'Content section')
    .requiredOption('--slug <slug>', 'Page slug')
    .option('--confirm', 'Confirm the delete')
    .action(async (opts: { section: string; slug: string; confirm?: boolean }) => {
      if (!opts.confirm) {
        emitError(
          'confirmation_required',
          'Delete requires explicit confirmation.',
          ExitCode.USAGE,
          'Re-run with --confirm.',
        )
      }
      const data = await callSeoHostingAction<Record<string, unknown>>('delete_page', {
        section: opts.section,
        slug: opts.slug,
      })
      emitSuccess(data, (d) => `Deleted ${d.section}/${d.slug} (${d.removed_objects} objects).`)
    })

  pages
    .command('upload-asset')
    .description('Upload an image / theme.css / font to the public CDN')
    .requiredOption('--path <path>', "Relative CDN asset path, e.g. 'blog/{slug}/hero.png'")
    .requiredOption('--file <path>', 'Local file to upload')
    .action(async (opts: { path: string; file: string }) => {
      // Direct multipart upload (no base64): stream the file to the CLI asset
      // endpoint, which reuses the same AssetPublisher validation as the data action.
      let bytes: Buffer
      try {
        bytes = readFileSync(opts.file)
      } catch (err) {
        usageError(
          new SeoHostingUsageError(
            `Could not read file: ${opts.file}`,
            (err as Error).message,
          ),
        )
      }
      const form = new FormData()
      form.append('path', opts.path)
      form.append('file', new Blob([bytes]), basename(opts.file))
      const data = await apiRequest<AssetUploadResponse>(ASSETS_PATH, {
        method: 'POST',
        workspace: true,
        body: form,
      })
      emitSuccess(data, renderAssetUpload)
    })

  const connections = seoHosting
    .command('connections')
    .description('Manage SEO Hosting domain connections')

  connections
    .command('list')
    .description('List domain connections for the active brand')
    .action(async () => {
      const data = await apiRequest<DomainConnectionListResponse>(CONNECTIONS_PATH, {
        workspace: true,
      })
      emitSuccess(data, (d) => renderConnections(d.items))
    })

  connections
    .command('probe')
    .description('Probe a hostname before Cloudflare Worker provisioning')
    .requiredOption('--hostname <hostname>', 'Customer hostname, for example example.com')
    .option('--sections <sections>', 'Comma-separated sections to mount', DEFAULT_SECTIONS.join(','))
    .action(async (opts: { hostname: string; sections?: string }) => {
      let sections: string[]
      try {
        sections = parseSections(opts.sections)
      } catch (err) {
        usageError(err)
      }
      const data = await apiRequest<WorkerProbeResponse>(`${CONNECTIONS_PATH}/worker/probe`, {
        method: 'POST',
        workspace: true,
        body: { hostname: opts.hostname, sections },
      })
      emitSuccess(data, renderWorkerProbe)
    })

  connections
    .command('connect-cname')
    .description('Connect a CNAME SEO Hosting hostname')
    .requiredOption('--hostname <hostname>', 'Customer hostname, for example blog.example.com')
    .action(async (opts: { hostname: string }) => {
      const data = await apiRequest<DomainConnection>(CONNECTIONS_PATH, {
        method: 'POST',
        workspace: true,
        body: { hostname: opts.hostname },
      })
      emitSuccess(data, renderConnection)
    })

  connections
    .command('connect-worker')
    .description('Connect a Cloudflare Worker reverse proxy')
    .requiredOption('--hostname <hostname>', 'Customer hostname, for example example.com')
    .option('--sections <sections>', 'Comma-separated sections to mount', DEFAULT_SECTIONS.join(','))
    .option('--cf-token-env <name>', 'Read the Cloudflare API token from this environment variable')
    .option('--cf-token-stdin', 'Read the Cloudflare API token from stdin')
    .option('--accept-conflicts', 'Allow SEO Hosting routes to shadow existing mounted paths')
    .option('--accept-next-assets-warning', 'Allow /_next/static/* to route through the Worker')
    .action(async (opts: WorkerConnectOptions) => {
      let sections: string[]
      try {
        sections = parseSections(opts.sections)
        validateCloudflareTokenOptions(opts)
      } catch (err) {
        usageError(err)
      }

      const probe = await apiRequest<WorkerProbeResponse>(`${CONNECTIONS_PATH}/worker/probe`, {
        method: 'POST',
        workspace: true,
        body: { hostname: opts.hostname, sections },
      })
      const blocker = workerProbeBlocker(probe, opts)
      if (blocker) usageError(blocker)

      let token: string
      try {
        token = await readCloudflareToken(opts)
      } catch (err) {
        usageError(err)
      }

      const connection = await apiRequest<DomainConnection>(`${CONNECTIONS_PATH}/worker`, {
        method: 'POST',
        workspace: true,
        body: { hostname: opts.hostname, sections, api_token: token },
      })
      emitSuccess({ connection, probe }, (d) =>
        [renderConnection(d.connection), '', bold('Probe'), renderWorkerProbe(d.probe)].join('\n'),
      )
    })

  connections
    .command('verify <connectionId>')
    .description('Run one verification pass')
    .action(async (connectionId: string) => {
      const data = await apiRequest<DomainConnection>(domainConnectionPath(connectionId, 'verify'), {
        method: 'POST',
        workspace: true,
      })
      emitSuccess(data, renderConnection)
    })

  connections
    .command('disconnect <connectionId>')
    .description('Disconnect a domain connection')
    .option('--confirm', 'Confirm the disconnect')
    .action(async (connectionId: string, opts: { confirm?: boolean }) => {
      if (!opts.confirm) {
        emitError(
          'confirmation_required',
          'Disconnect requires explicit confirmation.',
          ExitCode.USAGE,
          'Re-run with --confirm.',
        )
      }
      const data = await apiRequest<DomainConnection>(domainConnectionPath(connectionId), {
        method: 'DELETE',
        workspace: true,
      })
      emitSuccess(data, renderConnection)
    })
}
