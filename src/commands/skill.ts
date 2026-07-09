/** `soku skill` — discover and install Soku skills into an AI client.
 *
 * - `soku skill list`                  browse the public Soku skill catalog
 * - `soku skill install <slug...>`     download + install business skills
 * - `soku skill install --all`         install the whole catalog
 * - `soku skill install` (no slug)     install just the bundled `soku` meta-skill
 * - `soku skill status` / `remove`     manage what's installed locally
 *
 * Business skills are fetched as per-skill zips from the public Soku skill
 * catalog, already translated to CLI-native at pack time. We verify the sha256
 * from index.json, unzip safely, and drop each business skill into
 * `<skillsDir>/soku/<slug>/` with a top-level symlink
 * `<skillsDir>/soku-<slug> -> soku/<slug>`. The bundled `soku` meta-skill (how
 * to drive the CLI) ships in the npm package and is installed as a prerequisite. */

import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Command } from 'commander'

import { resolveSkillsBaseUrl } from '../config.js'
import { dim, emitError, emitSuccess, ExitCode, green, table } from '../output/envelope.js'
import { safeUnzip, UnzipError } from '../skills/unzip.js'

export const SOKU_META = 'soku'
export const MANIFEST_FILE = '.soku-skills.json'

export type Agent = 'claude' | 'codex' | 'cursor'

export const AGENTS: Agent[] = ['claude', 'codex', 'cursor']

export const PROJECT_DIRS: Record<Agent, string> = {
  claude: '.claude/skills',
  codex: '.codex/skills',
  cursor: '.cursor/skills',
}

export const GLOBAL_DIRS: Record<Agent, string> = {
  claude: join(homedir(), '.claude/skills'),
  codex: join(homedir(), '.codex/skills'),
  cursor: join(homedir(), '.cursor/skills'),
}

export interface IndexEntry {
  slug: string
  name: string
  description: string
  category?: string | null
  version?: string | null
  providers?: string[]
  tags?: string[]
  zip: string
  sha256: string
  bytes: number
}

export interface SkillIndex {
  schema: number
  generated_at: string
  source_commit: string
  base_url: string
  count: number
  skills: IndexEntry[]
}

export interface ManifestRecord {
  version?: string | null
  sha256: string
  installed_at: string
  source: 'catalog' | 'cdn' | 'bundled'
}

export type Manifest = Record<string, ManifestRecord>

/** Locate the bundled skills/soku dir relative to the compiled file. */
function bundledSkillDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(here, '..', '..', 'skills', SOKU_META),
    join(here, '..', '..', '..', 'skills', SOKU_META),
  ]
  return candidates.find((c) => existsSync(join(c, 'SKILL.md'))) ?? candidates[0]
}

export function baseDirFor(agent: Agent, global: boolean): string {
  return global ? GLOBAL_DIRS[agent] : PROJECT_DIRS[agent]
}

export function parseAgents(value: string): Agent[] {
  if (value === 'all') return AGENTS
  if (value === 'claude' || value === 'codex' || value === 'cursor') return [value]
  return emitError('usage', `Unknown agent: ${value}. Use claude | codex | cursor | all.`, ExitCode.USAGE)
}

// Slugs become path segments (`soku-<slug>/`), so they must never contain
// traversal or separators. Mirrors the server catalog's SLUG_PATTERN. We do not
// trust the slug just because it came from index.json — the catalog base url is
// overridable (SOKU_SKILLS_URL), and a poisoned index could otherwise escape the
// skills dir. `remove` validates the user-supplied slug for the same reason.
const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** A slug is safe to use as a path segment (no traversal/separators). Exported for tests. */
export function isSafeSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug)
}

function assertSafeSlug(slug: string, origin: string): void {
  if (!isSafeSlug(slug)) {
    emitError('invalid_slug', `Refusing unsafe skill slug (${origin}): ${slug}`, ExitCode.USAGE)
  }
}

export function manifestPath(baseDir: string): string {
  return join(baseDir, MANIFEST_FILE)
}

export function loadManifest(baseDir: string): Manifest {
  try {
    return JSON.parse(readFileSync(manifestPath(baseDir), 'utf8')) as Manifest
  } catch {
    return {}
  }
}

export function saveManifest(baseDir: string, manifest: Manifest): void {
  const path = manifestPath(baseDir)
  if (Object.keys(manifest).length === 0) {
    rmSync(path, { force: true })
    return
  }
  mkdirSync(baseDir, { recursive: true })
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
}

function sokuDir(baseDir: string): string {
  return join(baseDir, SOKU_META)
}

function businessSkillDir(baseDir: string, slug: string): string {
  return join(sokuDir(baseDir), slug)
}

function businessSkillLink(baseDir: string, slug: string): string {
  return join(baseDir, `soku-${slug}`)
}

export function agentSkillName(slug: string): string {
  return slug === SOKU_META ? SOKU_META : `soku-${slug}`
}

function removeMetaSokuFiles(dest: string): string[] {
  const removed: string[] = []
  const skillFile = join(dest, 'SKILL.md')
  const referencesDir = join(dest, 'references')

  if (existsSync(skillFile)) {
    rmSync(skillFile, { force: true })
    removed.push(skillFile)
  }
  if (existsSync(referencesDir)) {
    rmSync(referencesDir, { recursive: true, force: true })
    removed.push(referencesDir)
  }
  return removed
}

function removeEmptySokuDir(baseDir: string): void {
  const dir = sokuDir(baseDir)
  try {
    if (readdirSync(dir).length === 0) {
      rmSync(dir, { recursive: true, force: true })
    }
  } catch {
    // Missing or unreadable directories are treated as already absent.
  }
}

function renderPathChanges(action: 'Installed' | 'Removed', paths: string[]): string {
  if (paths.length === 0) return dim('No matching Soku-managed skill files found.')
  const noun = paths.length === 1 ? 'item' : 'items'
  return [`${green('✓')} ${action} ${paths.length} ${noun}`, ...paths.map((path) => `  ${path}`)].join('\n')
}

function renderInstallResult(paths: string[], slugs: string[]): string {
  const base = renderPathChanges('Installed', paths)
  if (slugs.length === 0) return base
  const names = slugs.map(agentSkillName)
  const invocation =
    names.length <= 6
      ? ['Agent invocation:', ...names.map((name) => `  use @${name} skill`)].join('\n')
      : 'Agent invocation names are Soku-prefixed, e.g. `use @soku-ads-report skill`; inspect with `soku skill status`.'
  return `${base}\n\n${invocation}`
}

export async function fetchIndex(base: string): Promise<SkillIndex> {
  let res: Response
  try {
    res = await fetch(`${base}/index.json`)
  } catch (err) {
    return emitError(
      'network_error',
      `Could not reach skill catalog ${base}: ${(err as Error).message}`,
      ExitCode.RUNTIME,
      'Override with --skills-url or SOKU_SKILLS_URL.',
    )
  }
  if (!res.ok) {
    return emitError(
      'index_unavailable',
      `Skill index not found at ${base}/index.json (HTTP ${res.status}).`,
      ExitCode.RUNTIME,
    )
  }
  return (await res.json()) as SkillIndex
}

async function fetchZip(base: string, zip: string): Promise<Uint8Array> {
  let res: Response
  try {
    res = await fetch(`${base}/${zip}`)
  } catch (err) {
    return emitError('network_error', `Could not download ${zip}: ${(err as Error).message}`, ExitCode.RUNTIME)
  }
  if (!res.ok) {
    return emitError('download_failed', `${zip} (HTTP ${res.status})`, ExitCode.RUNTIME)
  }
  return new Uint8Array(await res.arrayBuffer())
}

/** Copy the bundled `soku` meta-skill into a client dir without deleting child skills. */
export function installMetaSoku(baseDir: string): string {
  const source = bundledSkillDir()
  if (!existsSync(join(source, 'SKILL.md'))) {
    return emitError('skill_not_bundled', `Bundled skill not found at ${source}.`, ExitCode.RUNTIME)
  }
  const dest = sokuDir(baseDir)
  mkdirSync(baseDir, { recursive: true })
  mkdirSync(dest, { recursive: true })
  removeMetaSokuFiles(dest)
  cpSync(join(source, 'SKILL.md'), join(dest, 'SKILL.md'))
  if (existsSync(join(source, 'references'))) {
    cpSync(join(source, 'references'), join(dest, 'references'), { recursive: true })
  }
  const manifest = loadManifest(baseDir)
  manifest[SOKU_META] = { sha256: '', installed_at: new Date().toISOString(), source: 'bundled' }
  saveManifest(baseDir, manifest)
  return dest
}

/** Download, verify, unzip, and install one business skill. */
export async function installBusinessSkill(baseDir: string, entry: IndexEntry, base: string): Promise<string> {
  assertSafeSlug(entry.slug, 'catalog index')
  const data = await fetchZip(base, entry.zip)
  const sha = createHash('sha256').update(data).digest('hex')
  if (sha !== entry.sha256) {
    return emitError(
      'checksum_mismatch',
      `${entry.slug}: sha256 mismatch (expected ${entry.sha256.slice(0, 12)}…, got ${sha.slice(0, 12)}…)`,
      ExitCode.RUNTIME,
    )
  }

  let files: Map<string, Uint8Array>
  try {
    files = safeUnzip(data)
  } catch (err) {
    if (err instanceof UnzipError) {
      return emitError('unsafe_bundle', `${entry.slug}: ${err.message}`, ExitCode.RUNTIME)
    }
    throw err
  }

  const dest = businessSkillDir(baseDir, entry.slug)
  const link = businessSkillLink(baseDir, entry.slug)
  rmSync(link, { recursive: true, force: true })
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  for (const [rel, bytes] of files) {
    const target = join(dest, rel)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, bytes)
  }
  symlinkSync(`${SOKU_META}/${entry.slug}`, link, 'dir')

  const manifest = loadManifest(baseDir)
  manifest[entry.slug] = {
    version: entry.version ?? null,
    sha256: entry.sha256,
    installed_at: new Date().toISOString(),
    source: 'catalog',
  }
  saveManifest(baseDir, manifest)
  return link
}

function inCategory(entry: IndexEntry, category?: string): boolean {
  if (!category) return true
  return (entry.category ?? '').toLowerCase() === category.toLowerCase()
}

function resolveTargets(index: SkillIndex, slugs: string[], all: boolean, category?: string): IndexEntry[] {
  if (all) return index.skills.filter((e) => inCategory(e, category))
  return slugs.map((slug) => {
    const entry = index.skills.find((e) => e.slug === slug)
    if (!entry) {
      return emitError('skill_not_found', `No skill named ${slug} in the catalog.`, ExitCode.NOT_FOUND, 'List with `soku skill list`.')
    }
    return entry
  })
}

interface InstallOpts {
  agent: string
  global?: boolean
  all?: boolean
  category?: string
  skillsUrl?: string
}

interface InstalledOpts {
  agent: string
  global?: boolean
}

function listInstalledSkills(opts: InstalledOpts): void {
  const [agent] = parseAgents(opts.agent === 'all' ? 'claude' : opts.agent)
  const baseDir = baseDirFor(agent, Boolean(opts.global))
  const manifest = loadManifest(baseDir)
  const rows = Object.entries(manifest).map(([slug, rec]) => ({
    slug,
    agent_name: agentSkillName(slug),
    version: rec.version ?? '',
    source: rec.source,
    installed_at: rec.installed_at,
  }))
  emitSuccess({ baseDir, skills: rows, count: rows.length }, (d) =>
    rows.length === 0
      ? dim(`(no Soku skills in ${d.baseDir})`)
      : table(d.skills, [
          { key: 'slug', header: 'SLUG' },
          { key: 'agent_name', header: 'AGENT NAME' },
          { key: 'version', header: 'VERSION' },
          { key: 'source', header: 'SOURCE' },
          { key: 'installed_at', header: 'INSTALLED' },
        ]),
  )
}

export function registerSkillCommand(program: Command): void {
  const skill = program.command('skill').description('Discover and install Soku skills into your AI client')

  skill
    .command('list')
    .description('Browse the public Soku skill catalog')
    .option('--category <category>', 'Filter by category')
    .option('--skills-url <url>', 'Override the skill catalog base url')
    .action(async (opts: { category?: string; skillsUrl?: string }) => {
      const base = resolveSkillsBaseUrl(opts.skillsUrl)
      const index = await fetchIndex(base)
      const rows = index.skills.filter((e) => inCategory(e, opts.category))
      emitSuccess({ skills: rows, count: rows.length }, (d) =>
        table(
          d.skills.map((s) => ({
            slug: s.slug,
            agent_name: s.name,
            category: s.category ?? '',
            description: s.description.length > 70 ? `${s.description.slice(0, 67)}…` : s.description,
          })),
          [
            { key: 'slug', header: 'SLUG' },
            { key: 'agent_name', header: 'AGENT NAME' },
            { key: 'category', header: 'CATEGORY' },
            { key: 'description', header: 'DESCRIPTION' },
          ],
        ),
      )
    })

  skill
    .command('install [slugs...]')
    .description('Install business skills (or the bundled soku meta-skill when no slug is given)')
    .option('--agent <agent>', 'claude | codex | cursor | all', 'all')
    .option('--global', 'Install into the user-level (~) skills directory')
    .option('--all', 'Install the entire catalog')
    .option('--category <category>', 'With --all, limit to one category')
    .option('--skills-url <url>', 'Override the skill catalog base url')
    .action(async (slugs: string[], opts: InstallOpts) => {
      const agents = parseAgents(opts.agent)
      const installed: string[] = []

      // No slugs and no --all → legacy behaviour: install just the meta-skill.
      if (slugs.length === 0 && !opts.all) {
        for (const agent of agents) installed.push(installMetaSoku(baseDirFor(agent, Boolean(opts.global))))
        emitSuccess({ installed }, (d) => renderPathChanges('Installed', d.installed))
      }

      const base = resolveSkillsBaseUrl(opts.skillsUrl)
      const index = await fetchIndex(base)
      const targets = resolveTargets(index, slugs, Boolean(opts.all), opts.category)

      for (const agent of agents) {
        const baseDir = baseDirFor(agent, Boolean(opts.global))
        // The soku meta-skill teaches `soku call`/`egress`/`auth` — a prerequisite
        // for running any business skill. Install it if absent.
        if (!existsSync(join(baseDir, SOKU_META, 'SKILL.md'))) installMetaSoku(baseDir)
        for (const entry of targets) {
          installed.push(await installBusinessSkill(baseDir, entry, base))
        }
      }
      const installedSlugs = targets.map((entry) => entry.slug)
      emitSuccess({ installed, count: installed.length, agent_skill_names: installedSlugs.map(agentSkillName) }, (d) =>
        renderInstallResult(d.installed, installedSlugs),
      )
    })

  skill
    .command('status')
    .description('List skills installed locally')
    .option('--agent <agent>', 'claude | codex | cursor', 'claude')
    .option('--global', 'Inspect the user-level (~) skills directory')
    .action((opts: InstalledOpts) => listInstalledSkills(opts))

  skill
    .command('list-installed')
    .description('List skills installed locally')
    .option('--agent <agent>', 'claude | codex | cursor', 'claude')
    .option('--global', 'Inspect the user-level (~) skills directory')
    .action((opts: InstalledOpts) => listInstalledSkills(opts))

  skill
    .command('installed', { hidden: true })
    .description('Legacy alias for `soku skill status`')
    .option('--agent <agent>', 'claude | codex | cursor', 'claude')
    .option('--global', 'Inspect the user-level (~) skills directory')
    .action((opts: InstalledOpts) => listInstalledSkills(opts))

  skill
    .command('remove <slug>')
    .description('Remove an installed skill')
    .option('--agent <agent>', 'claude | codex | cursor | all', 'all')
    .option('--global', 'Remove from the user-level (~) skills directory')
    .action((slug: string, opts: { agent: string; global?: boolean }) => {
      assertSafeSlug(slug, 'argument')
      const agents = parseAgents(opts.agent)
      const removed: string[] = []
      for (const agent of agents) {
        const baseDir = baseDirFor(agent, Boolean(opts.global))
        if (slug === SOKU_META) {
          const dir = sokuDir(baseDir)
          if (existsSync(dir)) {
            removed.push(...removeMetaSokuFiles(dir))
          }
        } else {
          const link = businessSkillLink(baseDir, slug)
          const dir = businessSkillDir(baseDir, slug)
          if (existsSync(link)) {
            rmSync(link, { recursive: true, force: true })
            removed.push(link)
          }
          if (existsSync(dir)) {
            rmSync(dir, { recursive: true, force: true })
            removed.push(dir)
          }
        }
        const manifest = loadManifest(baseDir)
        if (slug in manifest) {
          delete manifest[slug]
          saveManifest(baseDir, manifest)
        }
        removeEmptySokuDir(baseDir)
      }
      emitSuccess({ removed, count: removed.length }, (d) => renderPathChanges('Removed', d.removed))
    })
}
