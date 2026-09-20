/** `soku brand skill ...` — manage skills in the active brand workspace. */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { Command, InvalidArgumentError, Option } from 'commander'
import { zipSync } from 'fflate'

import { apiRequest } from '../http/client.js'
import { bold, cyan, dim, emitError, emitSuccess, ExitCode, green, table } from '../output/envelope.js'
import { isSafeSlug } from './skill.js'

const BRAND_SKILLS_PATH = '/api/cli/brand-skills'

interface InstalledSkill {
  slug: string
  version: string
  installed_at: string
  source_sha: string
  last_edited_at?: string | null
  last_edited_by?: string | null
  modified: boolean
}

interface UploadedSkillMeta {
  name: string
  description: string
  version?: string | null
  tags: string[]
}

interface UploadedSkill {
  slug: string
  uploaded_by: string
  uploaded_at: string
  original_filename: string
  zip_sha256: string
  byte_size: number
  file_count: number
  skill_meta: UploadedSkillMeta
  last_edited_at?: string | null
  last_edited_by?: string | null
  source?: string | null
}

interface CatalogSkill {
  slug: string
  name: string
  description: string
  version: string
  providers: string[]
  tags: string[]
  category?: string | null
  state: 'installed' | 'uninstalled' | 'never_installed'
  installed: boolean
  modified: boolean
}

interface CommunitySkill {
  slug: string
  name: string
  version: string
  publisher_org_name: string
  status: string
  price_credits: number
  entitlement: string | null
  installed_version: string | null
  update_available: boolean
  pending_version?: { version: string; review_status: string; review_note?: string | null } | null
}

interface CommunitySkillListResponse {
  brand_id: string
  skills: CommunitySkill[]
  count: number
  total: number
}

function integerOption(min: number, max = Number.MAX_SAFE_INTEGER) {
  return (raw: string): number => {
    const value = Number(raw)
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
      throw new InvalidArgumentError(`Expected an integer from ${min} to ${max}.`)
    }
    return value
  }
}

export function renderCommunitySkills(data: CommunitySkillListResponse): string {
  return `${table(data.skills.map((skill) => ({
    slug: skill.slug,
    name: skill.name,
    version: skill.version,
    publisher: skill.publisher_org_name,
    credits: skill.price_credits,
    entitlement: skill.entitlement ?? 'purchase required',
    installed: skill.installed_version ?? '',
    update: skill.update_available ? 'available' : '',
  })), [
    { key: 'slug', header: 'SLUG' },
    { key: 'name', header: 'NAME' },
    { key: 'version', header: 'VERSION' },
    { key: 'publisher', header: 'PUBLISHER' },
    { key: 'credits', header: 'CREDITS' },
    { key: 'entitlement', header: 'ENTITLEMENT' },
    { key: 'installed', header: 'INSTALLED' },
    { key: 'update', header: 'UPDATE' },
  ])}\nShowing ${data.count} of ${data.total}; use --offset to see more.`
}

interface BrandSkillListResponse {
  brand_id: string
  installed: InstalledSkill[]
  uploaded: UploadedSkill[]
  count: number
}

interface BrandSkillCatalogResponse {
  brand_id: string
  skills: CatalogSkill[]
  count: number
}

interface BrandSkillMutationResponse {
  brand_id: string
  skill: InstalledSkill | UploadedSkill
}

interface BrandSkillDeleteResponse {
  brand_id: string
  deleted: string
}

interface SkillFile {
  path: string
  byte_size: number
  mime_type: string
}

interface SkillFilesResponse {
  brand_id: string
  slug: string
  files: SkillFile[]
  count: number
}

interface SkillFileContent {
  path: string
  content: string
  byte_size: number
}

interface SkillFileReadResponse {
  brand_id: string
  slug: string
  file: SkillFileContent
}

interface SkillFileSaveResult {
  path: string
  byte_size: number
  updated_at: string
  skill_meta?: UploadedSkillMeta | null
}

interface SkillFileMutationResponse {
  brand_id: string
  slug: string
  file: SkillFileSaveResult
}

interface SkillDownloadResponse {
  brand_id: string
  slug: string
  target_dir: string
  files: Array<{
    path: string
    output_path: string
    byte_size: number
  }>
  count: number
}

interface DownloadTarget {
  path: string
  outputPath: string
  byteSize: number
}

export function brandSkillFilePath(slug: string, relPath: string): string {
  validateSkillRelPath(relPath)
  return `${BRAND_SKILLS_PATH}/uploaded/${encodeURIComponent(slug)}/files/${encodeSkillPath(relPath)}`
}

export function packageSkillPath(inputPath: string): { bytes: Uint8Array; filename: string } {
  const abs = resolve(inputPath)
  if (!existsSync(abs)) {
    emitError('usage', `Path does not exist: ${inputPath}`, ExitCode.USAGE)
  }
  const stat = lstatSync(abs)
  if (stat.isSymbolicLink()) {
    emitError('usage', `Refusing to upload symlink: ${inputPath}`, ExitCode.USAGE)
  }
  if (stat.isFile()) {
    if (!abs.toLowerCase().endsWith('.zip')) {
      emitError('usage', 'Upload path must be a .zip file or a directory.', ExitCode.USAGE)
    }
    return { bytes: readFileSync(abs), filename: basename(abs) }
  }
  if (!stat.isDirectory()) {
    emitError('usage', `Upload path must be a .zip file or directory: ${inputPath}`, ExitCode.USAGE)
  }
  const files = collectZipFiles(abs)
  if (!Object.prototype.hasOwnProperty.call(files, 'SKILL.md')) {
    emitError(
      'usage',
      'Skill directory must contain SKILL.md at its root.',
      ExitCode.USAGE,
      'Pass the skill directory itself, not its parent.',
    )
  }
  const zipped = zipSync(files, { level: 6 })
  return { bytes: zipped, filename: `${basename(abs)}.zip` }
}

export function planSkillDownloadTargets(
  files: Array<{ path: string; byte_size: number }>,
  targetDir: string,
  force = false,
): DownloadTarget[] {
  const root = resolve(targetDir)
  return files.map((file) => {
    validateSkillRelPath(file.path)
    const outputPath = resolve(root, ...file.path.split('/'))
    const relFromRoot = relative(root, outputPath)
    if (relFromRoot.startsWith('..') || isAbsolute(relFromRoot)) {
      throw new Error(`Refusing to write outside target directory: ${file.path}`)
    }
    if (!force && existsSync(outputPath)) {
      throw new Error(`Refusing to overwrite existing file: ${outputPath}`)
    }
    return { path: file.path, outputPath, byteSize: file.byte_size }
  })
}

export function renderBrandSkillList(data: BrandSkillListResponse): string {
  const installedRows = data.installed.map((skill) => ({
    source: 'catalog',
    name: skill.slug,
    slug: skill.slug,
    version: skill.version,
    modified: skill.modified ? 'yes' : '',
    files: '',
  }))
  const uploadedRows = data.uploaded.map((skill) => ({
    source: 'uploaded',
    name: skill.skill_meta.name || skill.slug,
    slug: skill.slug,
    version: skill.skill_meta.version || '',
    modified: skill.last_edited_at ? 'yes' : '',
    files: skill.file_count,
  }))
  return table([...installedRows, ...uploadedRows], [
    { key: 'source', header: 'SOURCE' },
    { key: 'name', header: 'NAME' },
    { key: 'slug', header: 'SLUG' },
    { key: 'version', header: 'VERSION' },
    { key: 'modified', header: 'MOD' },
    { key: 'files', header: 'FILES' },
  ])
}

export function renderBrandSkillCatalog(data: BrandSkillCatalogResponse): string {
  return table(
    data.skills.map((skill) => ({
      state: skill.state,
      name: skill.name,
      slug: skill.slug,
      version: skill.version,
      modified: skill.modified ? 'yes' : '',
      description: skill.description,
    })),
    [
      { key: 'state', header: 'STATE' },
      { key: 'name', header: 'NAME' },
      { key: 'slug', header: 'SLUG' },
      { key: 'version', header: 'VERSION' },
      { key: 'modified', header: 'MOD' },
      { key: 'description', header: 'DESCRIPTION' },
    ],
  )
}

function encodeSkillPath(relPath: string): string {
  return relPath
    .split('/')
    .filter((part) => part.length > 0)
    .map((part) => encodeURIComponent(part))
    .join('/')
}

function validateSlug(slug: string): void {
  if (!isSafeSlug(slug)) {
    emitError('usage', `Invalid skill slug: ${slug}`, ExitCode.USAGE)
  }
}

function readTextFile(file: string): string {
  try {
    return readFileSync(file, 'utf8')
  } catch (err) {
    emitError('usage', `Could not read file: ${file}`, ExitCode.USAGE, (err as Error).message)
  }
}

function validateSkillRelPath(path: string): void {
  if (!path || path.includes('\0')) {
    throw new Error(`Invalid skill file path: ${path}`)
  }
  if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) {
    throw new Error(`Skill file path must be relative: ${path}`)
  }
  const parts = path.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`Skill file path contains an unsafe segment: ${path}`)
  }
}

function checkedBrandSkillFilePath(slug: string, path: string): string {
  try {
    return brandSkillFilePath(slug, path)
  } catch (err) {
    emitError('usage', (err as Error).message, ExitCode.USAGE)
  }
}

function collectZipFiles(root: string): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {}
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === '.DS_Store' || name === '__MACOSX' || name.startsWith('._')) continue
      const abs = join(dir, name)
      const stat = lstatSync(abs)
      if (stat.isSymbolicLink()) {
        emitError('usage', `Refusing to package symlink: ${abs}`, ExitCode.USAGE)
      }
      if (stat.isDirectory()) {
        visit(abs)
        continue
      }
      if (!stat.isFile()) continue
      const rel = relative(root, abs).split(sep).join('/')
      out[rel] = readFileSync(abs)
    }
  }
  visit(root)
  return out
}

function renderMutation(data: BrandSkillMutationResponse): string {
  const skill = data.skill
  const name = 'skill_meta' in skill ? skill.skill_meta.name : skill.slug
  return `${green('✓')} ${cyan(name)} ${dim(`(${skill.slug})`)}`
}

function renderDelete(data: BrandSkillDeleteResponse): string {
  return `${green('✓')} Deleted ${cyan(data.deleted)}`
}

function renderFiles(data: SkillFilesResponse): string {
  return table(
    data.files.map((file) => ({
      path: file.path,
      bytes: file.byte_size,
      mime: file.mime_type,
    })),
    [
      { key: 'path', header: 'PATH' },
      { key: 'bytes', header: 'BYTES' },
      { key: 'mime', header: 'MIME' },
    ],
  )
}

function renderFileRead(data: SkillFileReadResponse): string {
  return data.file.content
}

function renderFileMutation(data: SkillFileMutationResponse): string {
  return `${green('✓')} Saved ${cyan(data.file.path)} ${dim(`(${data.file.byte_size} bytes) at ${data.file.updated_at}`)}`
}

function renderFileDelete(data: SkillFileMutationResponse): string {
  return `${green('✓')} Deleted ${cyan(data.file.path)} ${dim(`at ${data.file.updated_at}`)}`
}

function renderDownload(data: SkillDownloadResponse): string {
  return `${green('✓')} Downloaded ${data.count} files to ${cyan(data.target_dir)}`
}

export function registerBrandSkillCommands(brand: Command): void {
  const skill = brand
    .command('skill')
    .description('Manage skills in the active brand workspace (requires brand-skills)')

  const community = skill.command('community').description('Browse and install community skills')

  community.command('list')
    .description('List community skills with prices, purchase eligibility, and brand install state')
    .option('--query <text>', 'Search name and description')
    .option('--category <slug>', 'Filter by category')
    .addOption(new Option('--sort <order>', 'Sort order').choices(['recent', 'installs']).default('recent'))
    .option('--limit <n>', 'Page size (1-100)', integerOption(1, 100), 30)
    .option('--offset <n>', 'Pagination offset', integerOption(0), 0)
    .action(async (opts: { query?: string; category?: string; sort: string; limit: number; offset: number }) => {
      const query = new URLSearchParams({ sort: opts.sort, limit: String(opts.limit), offset: String(opts.offset) })
      if (opts.query !== undefined) query.set('q', opts.query)
      if (opts.category !== undefined) query.set('category', opts.category)
      const data = await apiRequest<CommunitySkillListResponse>(`${BRAND_SKILLS_PATH}/community?${query}`, { workspace: true })
      emitSuccess(data, renderCommunitySkills)
    })

  community.command('install <slug>')
    .description('Install or upgrade a community skill; a paid purchase requires an explicitly agreed price')
    .option('--expected-price-credits <credits>', 'Authorize this one-time purchase at the exact agreed price', integerOption(0))
    .action(async (slug: string, opts: { expectedPriceCredits?: number }) => {
      validateSlug(slug)
      const data = await apiRequest<BrandSkillMutationResponse & { upgraded: boolean }>(
        `${BRAND_SKILLS_PATH}/community/${encodeURIComponent(slug)}/install`,
        {
          method: 'POST', workspace: true,
          body: opts.expectedPriceCredits === undefined ? undefined : { expected_price_credits: opts.expectedPriceCredits },
        },
      )
      emitSuccess(data, (result) => `${renderMutation(result)} (${result.upgraded ? 'upgraded' : 'installed'})`)
    })

  skill.command('publish <slug>')
    .description('Publish an uploaded private skill; paid versions require review before going live')
    .option('--categories <slugs>', 'Comma-separated listing categories (at most 4)')
    .option('--price-credits <credits>', '0 for free or 100-20000; omit to preserve the listing price', (raw: string) => {
      const value = integerOption(0, 20000)(raw)
      if (value > 0 && value < 100) throw new InvalidArgumentError('Price must be 0 or at least 100 credits.')
      return value
    })
    .action(async (slug: string, opts: { categories?: string; priceCredits?: number }) => {
      validateSlug(slug)
      const body: { categories?: string[]; price_credits?: number } = {}
      if (opts.categories !== undefined) {
        body.categories = [...new Set(opts.categories.split(',').map((value) => value.trim().toLowerCase()))]
        if (body.categories.length > 4 || body.categories.some((value) => !/^[a-z][a-z0-9_-]{0,63}$/.test(value))) {
          emitError('usage', 'Provide one to four lowercase category slugs.', ExitCode.USAGE)
        }
      }
      if (opts.priceCredits !== undefined) body.price_credits = opts.priceCredits
      const data = await apiRequest<{ brand_id: string; skill: CommunitySkill; version: { version: string } }>(
        `${BRAND_SKILLS_PATH}/uploaded/${encodeURIComponent(slug)}/publish`,
        { method: 'POST', workspace: true, body },
      )
      emitSuccess(data)
    })

  skill
    .command('list')
    .description('List installed catalog skills and uploaded private skills')
    .action(async () => {
      const data = await apiRequest<BrandSkillListResponse>(BRAND_SKILLS_PATH, {
        workspace: true,
      })
      emitSuccess(data, renderBrandSkillList)
    })

  skill
    .command('catalog')
    .description('List catalog skills with the active brand install state')
    .action(async () => {
      const data = await apiRequest<BrandSkillCatalogResponse>(`${BRAND_SKILLS_PATH}/catalog`, {
        workspace: true,
      })
      emitSuccess(data, renderBrandSkillCatalog)
    })

  skill
    .command('install <slug>')
    .description('Install or re-add a catalog skill to the active brand')
    .action(async (slug: string) => {
      validateSlug(slug)
      const data = await apiRequest<BrandSkillMutationResponse>(
        `${BRAND_SKILLS_PATH}/${encodeURIComponent(slug)}/install`,
        { method: 'POST', workspace: true },
      )
      emitSuccess(data, renderMutation)
    })

  skill
    .command('uninstall <slug>')
    .description('Uninstall a catalog skill from the active brand')
    .action(async (slug: string) => {
      validateSlug(slug)
      const data = await apiRequest<BrandSkillDeleteResponse>(
        `${BRAND_SKILLS_PATH}/${encodeURIComponent(slug)}`,
        { method: 'DELETE', workspace: true },
      )
      emitSuccess(data, renderDelete)
    })

  skill
    .command('reset <slug>')
    .description('Reset an installed catalog skill to the current catalog version')
    .action(async (slug: string) => {
      validateSlug(slug)
      const data = await apiRequest<BrandSkillMutationResponse>(
        `${BRAND_SKILLS_PATH}/${encodeURIComponent(slug)}/reset`,
        { method: 'POST', workspace: true },
      )
      emitSuccess(data, renderMutation)
    })

  skill
    .command('upload <zip-or-dir>')
    .description('Upload a private skill zip or directory to the active brand')
    .action(async (inputPath: string) => {
      const bundle = packageSkillPath(inputPath)
      const form = new FormData()
      form.append('file', new Blob([bundle.bytes]), bundle.filename)
      const data = await apiRequest<BrandSkillMutationResponse>(`${BRAND_SKILLS_PATH}/upload`, {
        method: 'POST',
        body: form,
        workspace: true,
      })
      emitSuccess(data, renderMutation)
    })

  skill
    .command('delete <slug>')
    .description('Delete a private uploaded skill from the active brand')
    .action(async (slug: string) => {
      validateSlug(slug)
      const data = await apiRequest<BrandSkillDeleteResponse>(
        `${BRAND_SKILLS_PATH}/uploaded/${encodeURIComponent(slug)}`,
        { method: 'DELETE', workspace: true },
      )
      emitSuccess(data, renderDelete)
    })

  skill
    .command('files <slug>')
    .description('List files in an installed or uploaded brand skill')
    .action(async (slug: string) => {
      validateSlug(slug)
      const data = await apiRequest<SkillFilesResponse>(
        `${BRAND_SKILLS_PATH}/uploaded/${encodeURIComponent(slug)}/files`,
        { workspace: true },
      )
      emitSuccess(data, renderFiles)
    })

  skill
    .command('download <slug> [targetDir]')
    .description('Download an installed or uploaded brand skill into a local directory')
    .option('--force', 'Overwrite existing local files')
    .action(async (slug: string, targetDir: string | undefined, opts: { force?: boolean }) => {
      validateSlug(slug)
      const files = await apiRequest<SkillFilesResponse>(
        `${BRAND_SKILLS_PATH}/uploaded/${encodeURIComponent(slug)}/files`,
        { workspace: true },
      )
      let targets: DownloadTarget[]
      try {
        targets = planSkillDownloadTargets(files.files, targetDir ?? slug, Boolean(opts.force))
      } catch (err) {
        emitError('usage', (err as Error).message, ExitCode.USAGE)
      }

      for (const target of targets) {
        const data = await apiRequest<SkillFileReadResponse>(checkedBrandSkillFilePath(slug, target.path), {
          workspace: true,
        })
        mkdirSync(dirname(target.outputPath), { recursive: true })
        writeFileSync(target.outputPath, data.file.content, 'utf8')
      }

      emitSuccess(
        {
          brand_id: files.brand_id,
          slug,
          target_dir: resolve(targetDir ?? slug),
          files: targets.map((target) => ({
            path: target.path,
            output_path: target.outputPath,
            byte_size: target.byteSize,
          })),
          count: targets.length,
        },
        renderDownload,
      )
    })

  skill
    .command('read <slug> <path>')
    .description('Read one UTF-8 file from an installed or uploaded brand skill')
    .action(async (slug: string, path: string) => {
      validateSlug(slug)
      const data = await apiRequest<SkillFileReadResponse>(checkedBrandSkillFilePath(slug, path), {
        workspace: true,
      })
      emitSuccess(data, renderFileRead)
    })

  skill
    .command('write <slug> <path>')
    .description('Overwrite one file in an installed or uploaded brand skill')
    .requiredOption('--file <localFile>', 'Local UTF-8 file to write')
    .action(async (slug: string, path: string, opts: { file: string }) => {
      validateSlug(slug)
      const content = readTextFile(opts.file)
      const data = await apiRequest<SkillFileMutationResponse>(checkedBrandSkillFilePath(slug, path), {
        method: 'PUT',
        body: { content },
        workspace: true,
      })
      emitSuccess(data, renderFileMutation)
    })

  skill
    .command('create-file <slug> <path>')
    .description('Create one file in an installed or uploaded brand skill')
    .requiredOption('--file <localFile>', 'Local UTF-8 file to upload')
    .action(async (slug: string, path: string, opts: { file: string }) => {
      validateSlug(slug)
      const content = readTextFile(opts.file)
      const data = await apiRequest<SkillFileMutationResponse>(checkedBrandSkillFilePath(slug, path), {
        method: 'POST',
        body: { content },
        workspace: true,
      })
      emitSuccess(data, renderFileMutation)
    })

  skill
    .command('delete-file <slug> <path>')
    .description('Delete one file from an installed or uploaded brand skill')
    .action(async (slug: string, path: string) => {
      validateSlug(slug)
      const data = await apiRequest<SkillFileMutationResponse>(checkedBrandSkillFilePath(slug, path), {
        method: 'DELETE',
        workspace: true,
      })
      emitSuccess(data, renderFileDelete)
    })

  skill.addHelpText(
    'after',
    `\n${bold('Examples')}\n  soku brand skill catalog\n  soku brand skill upload ./my-skill\n  soku brand skill read my-skill SKILL.md\n`,
  )
}
