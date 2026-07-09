/** `soku update` — keep the CLI and locally installed Soku skills fresh. */

import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { Command } from 'commander'

import { configDir, resolveSkillsBaseUrl } from '../config.js'
import { bold, cyan, dim, emitError, emitSuccess, ExitCode, green, table } from '../output/envelope.js'
import { checkForUpdate, type UpdateCheckResult } from '../update-check.js'
import {
  AGENTS,
  agentSkillName,
  baseDirFor,
  fetchIndex,
  installBusinessSkill,
  installMetaSoku,
  loadManifest,
  manifestPath,
  parseAgents,
  SOKU_META,
  type Agent,
  type IndexEntry,
  type SkillIndex,
} from './skill.js'

const DEFAULT_AUTO_UPDATE_INTERVAL_HOURS = 24
const AUTO_UPDATE_LOCK_TTL_MS = 10 * 60 * 1000

export interface SkillTarget {
  agent: Agent
  global: boolean
  baseDir: string
}

export interface SkillUpdateResult {
  agent: Agent
  global: boolean
  baseDir: string
  metaUpdated: boolean
  updated: string[]
  unchanged: string[]
  missing: string[]
}

interface UpdateState {
  lastSkillAutoUpdateAt?: string
  lastCliAutoUpdateAt?: string
}

interface SkillStatusRow {
  agent: string
  location: string
  slug: string
  current: string
  latest: string
  status: 'current' | 'update_available' | 'missing_from_catalog' | 'bundled'
}

interface UpdateStatus {
  cli: UpdateCheckResult
  skills: SkillStatusRow[]
}

function statePath(): string {
  return join(configDir(), 'update-state.json')
}

function lockPath(): string {
  return join(configDir(), 'update.lock')
}

function readUpdateState(): UpdateState {
  try {
    return JSON.parse(readFileSync(statePath(), 'utf8')) as UpdateState
  } catch {
    return {}
  }
}

function writeUpdateState(state: UpdateState): void {
  const path = statePath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
}

function parseIntervalHours(value: string | undefined): number {
  if (!value) return DEFAULT_AUTO_UPDATE_INTERVAL_HOURS
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_AUTO_UPDATE_INTERVAL_HOURS
}

export function isAutoUpdateDue(lastRunAt: string | undefined, now: Date, intervalHours: number): boolean {
  if (!lastRunAt) return true
  const last = Date.parse(lastRunAt)
  if (!Number.isFinite(last)) return true
  return now.getTime() - last >= intervalHours * 60 * 60 * 1000
}

async function withUpdateLock<T>(fn: () => Promise<T> | T): Promise<T | null> {
  const path = lockPath()
  mkdirSync(dirname(path), { recursive: true })
  try {
    if (existsSync(path)) {
      const createdAt = Number(readFileSync(path, 'utf8').split('\n', 1)[0])
      if (Number.isFinite(createdAt) && Date.now() - createdAt > AUTO_UPDATE_LOCK_TTL_MS) {
        rmSync(path, { force: true })
      }
    }
  } catch {
    // Ignore malformed stale-lock probes; the exclusive open below decides.
  }

  let fd: number
  try {
    fd = openSync(path, 'wx', 0o600)
  } catch {
    return null
  }

  try {
    writeFileSync(fd, `${Date.now()}\n${process.pid}\n`)
    return await fn()
  } finally {
    closeSync(fd)
    rmSync(path, { force: true })
  }
}

function targetLocation(global: boolean): string {
  return global ? 'global' : 'project'
}

function hasSokuManagedInstall(baseDir: string): boolean {
  return existsSync(manifestPath(baseDir)) || existsSync(join(baseDir, SOKU_META, 'SKILL.md'))
}

export function discoverInstalledTargets(agentOpt = 'all', scope: 'all' | 'global' | 'project' = 'all'): SkillTarget[] {
  const agents = parseAgents(agentOpt)
  const targets: SkillTarget[] = []
  for (const agent of agents) {
    for (const global of [false, true]) {
      if (scope === 'global' && !global) continue
      if (scope === 'project' && global) continue
      const baseDir = baseDirFor(agent, global)
      if (hasSokuManagedInstall(baseDir)) {
        targets.push({ agent, global, baseDir })
      }
    }
  }
  return targets
}

function fallbackTargets(agentOpt = 'claude', scope: 'all' | 'global' | 'project' = 'global'): SkillTarget[] {
  const agents = parseAgents(agentOpt)
  const global = scope !== 'project'
  return agents.map((agent) => ({ agent, global, baseDir: baseDirFor(agent, global) }))
}

function targetsForUpdate(agentOpt: string, scope: 'all' | 'global' | 'project'): SkillTarget[] {
  const installed = discoverInstalledTargets(agentOpt, scope)
  return installed.length > 0 ? installed : fallbackTargets(agentOpt, scope)
}

function indexBySlug(index: SkillIndex): Map<string, IndexEntry> {
  return new Map(index.skills.map((entry) => [entry.slug, entry]))
}

export async function updateSkillTarget(target: SkillTarget, base: string, index?: SkillIndex): Promise<SkillUpdateResult> {
  const before = loadManifest(target.baseDir)
  const slugs = Object.keys(before).filter((slug) => slug !== SOKU_META)
  const metaUpdated = SOKU_META in before || slugs.length > 0 || existsSync(join(target.baseDir, SOKU_META, 'SKILL.md'))
  if (metaUpdated) installMetaSoku(target.baseDir)

  const updated: string[] = []
  const unchanged: string[] = []
  const missing: string[] = []
  if (slugs.length > 0) {
    const catalog = indexBySlug(index ?? (await fetchIndex(base)))
    for (const slug of slugs) {
      const entry = catalog.get(slug)
      if (!entry) {
        missing.push(slug)
        continue
      }
      const current = before[slug]
      if (current?.sha256 === entry.sha256 && current.version === (entry.version ?? null) && current.source === 'catalog') {
        unchanged.push(slug)
        continue
      }
      await installBusinessSkill(target.baseDir, entry, base)
      updated.push(slug)
    }
  }

  return {
    agent: target.agent,
    global: target.global,
    baseDir: target.baseDir,
    metaUpdated,
    updated,
    unchanged,
    missing,
  }
}

async function updateSkills(opts: {
  agent: string
  scope: 'all' | 'global' | 'project'
  skillsUrl?: string
}): Promise<SkillUpdateResult[]> {
  const targets = targetsForUpdate(opts.agent, opts.scope)
  const base = resolveSkillsBaseUrl(opts.skillsUrl)
  const needsCatalog = targets.some((target) => Object.keys(loadManifest(target.baseDir)).some((slug) => slug !== SOKU_META))
  const index = needsCatalog ? await fetchIndex(base) : undefined
  const results: SkillUpdateResult[] = []
  for (const target of targets) {
    results.push(await updateSkillTarget(target, base, index))
  }
  return results
}

function skillStatusRows(targets: SkillTarget[], index: SkillIndex): SkillStatusRow[] {
  const catalog = indexBySlug(index)
  const rows: SkillStatusRow[] = []
  for (const target of targets) {
    const manifest = loadManifest(target.baseDir)
    const hasLegacyMetaOnly = !(SOKU_META in manifest) && existsSync(join(target.baseDir, SOKU_META, 'SKILL.md'))
    if (hasLegacyMetaOnly) {
      rows.push({
        agent: target.agent,
        location: targetLocation(target.global),
        slug: agentSkillName(SOKU_META),
        current: 'legacy',
        latest: 'bundled',
        status: 'bundled',
      })
    }
    for (const [slug, current] of Object.entries(manifest)) {
      if (slug === SOKU_META) {
        rows.push({
          agent: target.agent,
          location: targetLocation(target.global),
          slug: agentSkillName(slug),
          current: 'bundled',
          latest: 'bundled',
          status: 'bundled',
        })
        continue
      }
      const entry = catalog.get(slug)
      rows.push({
        agent: target.agent,
        location: targetLocation(target.global),
        slug: agentSkillName(slug),
        current: current.version || current.sha256.slice(0, 12),
        latest: entry?.version || entry?.sha256.slice(0, 12) || '',
        status: !entry
          ? 'missing_from_catalog'
          : current.sha256 === entry.sha256 && current.version === (entry.version ?? null) && current.source === 'catalog'
            ? 'current'
            : 'update_available',
      })
    }
  }
  return rows
}

function renderSkillUpdateResults(results: SkillUpdateResult[]): string {
  const rows = results.map((result) => ({
    agent: result.agent,
    location: targetLocation(result.global),
    updated: result.updated.length,
    unchanged: result.unchanged.length,
    missing: result.missing.length,
    meta: result.metaUpdated ? 'yes' : 'no',
    dir: result.baseDir,
  }))
  return [
    `${green('✓')} Soku skills updated`,
    table(rows, [
      { key: 'agent', header: 'AGENT' },
      { key: 'location', header: 'LOCATION' },
      { key: 'updated', header: 'UPDATED' },
      { key: 'unchanged', header: 'UNCHANGED' },
      { key: 'missing', header: 'MISSING' },
      { key: 'meta', header: 'META' },
      { key: 'dir', header: 'DIR' },
    ]),
  ].join('\n')
}

function runNpmCliInstall(): number | null {
  const result = spawnSync('npm', ['i', '-g', '@soku-ai/cli'], { stdio: 'inherit' })
  if (typeof result.status === 'number') return result.status
  return 1
}

/** Narrow `targets` down to the meta-skill `SKILL.md` paths that actually exist
 * on disk. Exported separately from the `discoverInstalledTargets('all',
 * 'global')` call site so it is testable against arbitrary directories
 * instead of the real home dir the global scope always resolves to. */
export function targetsWithMetaSkill(targets: SkillTarget[]): string[] {
  return targets
    .map((target) => join(target.baseDir, SOKU_META, 'SKILL.md'))
    .filter((path) => existsSync(path))
}

/** Global meta-skill `SKILL.md` paths that `npm i -g @soku-ai/cli`'s own
 * `postinstall.cjs` refreshes as a side effect (it overwrites `SKILL.md` for
 * any agent dir that already had a Soku skill installed). Callers use this
 * right after `runNpmCliInstall` to tell the caller which files now hold new
 * content, since the npm lifecycle script runs silently and reports nothing
 * back to this process. */
function refreshedMetaSkillPaths(): string[] {
  return targetsWithMetaSkill(discoverInstalledTargets('all', 'global'))
}

function spawnSkillAutoUpdate(entrypoint: string): void {
  const child = spawn(process.execPath, [entrypoint, 'update', 'skills', '--quiet'], {
    env: {
      ...process.env,
      SOKU_NO_UPDATE_CHECK: '1',
      SOKU_NO_SKILL_AUTO_UPDATE: '1',
    },
    stdio: 'ignore',
    detached: true,
  })
  child.on('error', () => {
    // Background update is best-effort and must never break the foreground command.
  })
  child.unref()
}

export async function maybeAutoUpdateSkills(): Promise<void> {
  if (process.env.CI) return
  if (process.env.SOKU_NO_UPDATE_CHECK === '1') return
  if (process.env.SOKU_NO_SKILL_AUTO_UPDATE === '1') return
  if (!process.argv[1]) return

  const state = readUpdateState()
  const now = new Date()
  const interval = parseIntervalHours(process.env.SOKU_UPDATE_INTERVAL_HOURS)
  if (!isAutoUpdateDue(state.lastSkillAutoUpdateAt, now, interval)) return

  await withUpdateLock(() => {
    writeUpdateState({ ...readUpdateState(), lastSkillAutoUpdateAt: now.toISOString() })
    spawnSkillAutoUpdate(process.argv[1]!)
  })
}

export async function maybeAutoUpdateCli(): Promise<void> {
  if (process.env.CI) return
  if (process.env.SOKU_NO_UPDATE_CHECK === '1') return
  if (process.env.SOKU_AUTO_UPDATE_CLI !== '1') return

  const state = readUpdateState()
  const now = new Date()
  const interval = parseIntervalHours(process.env.SOKU_UPDATE_INTERVAL_HOURS)
  if (!isAutoUpdateDue(state.lastCliAutoUpdateAt, now, interval)) return

  await withUpdateLock(async () => {
    try {
      const check = await checkForUpdate()
      if (check.updateAvailable) {
        const status = runNpmCliInstall()
        if (status === 0) {
          process.stderr.write(`${dim('Soku CLI auto-updated. Restart your shell or agent session to use the new version.')}\n`)
        }
      }
    } catch {
      // Advisory only; never block the user's command.
    } finally {
      writeUpdateState({ ...readUpdateState(), lastCliAutoUpdateAt: now.toISOString() })
    }
  })
}

export function registerUpdateCommand(program: Command): void {
  const update = program.command('update').description('Update the Soku CLI and installed Soku skills')

  update
    .command('status')
    .description('Show CLI and installed skill update status')
    .option('--agent <agent>', 'claude | codex | cursor | all', 'all')
    .option('--global', 'Only inspect user-level (~) skills directories')
    .option('--project', 'Only inspect project-level skills directories')
    .option('--skills-url <url>', 'Override the skill catalog base url')
    .action(async (opts: { agent: string; global?: boolean; project?: boolean; skillsUrl?: string }) => {
      const scope = opts.global ? 'global' : opts.project ? 'project' : 'all'
      const targets = discoverInstalledTargets(opts.agent, scope)
      const [cli, index] = await Promise.all([checkForUpdate(), fetchIndex(resolveSkillsBaseUrl(opts.skillsUrl))])
      const payload: UpdateStatus = { cli, skills: skillStatusRows(targets, index) }
      emitSuccess(payload, (d) => {
        const cliLine = d.cli.updateAvailable
          ? `${d.cli.packageName} ${d.cli.currentVersion} -> ${d.cli.latestVersion}`
          : `${d.cli.packageName} is current (${d.cli.currentVersion})`
        const skillLines =
          d.skills.length === 0
            ? dim('(no Soku-managed skills installed)')
            : table(
                d.skills.map((row) => ({ ...row })),
                [
                  { key: 'agent', header: 'AGENT' },
                  { key: 'location', header: 'LOCATION' },
                  { key: 'slug', header: 'SKILL' },
                  { key: 'current', header: 'CURRENT' },
                  { key: 'latest', header: 'LATEST' },
                  { key: 'status', header: 'STATUS' },
                ],
              )
        return [`CLI: ${cliLine}`, '', 'Skills:', skillLines].join('\n')
      })
    })

  update
    .command('skills')
    .description('Update installed Soku meta-skill and business skills')
    .option('--agent <agent>', 'claude | codex | cursor | all', 'all')
    .option('--global', 'Only update user-level (~) skills directories')
    .option('--project', 'Only update project-level skills directories')
    .option('--skills-url <url>', 'Override the skill catalog base url')
    .option('--quiet', 'Suppress output except errors')
    .action(async (opts: { agent: string; global?: boolean; project?: boolean; skillsUrl?: string; quiet?: boolean }) => {
      const scope = opts.global ? 'global' : opts.project ? 'project' : 'all'
      const results = await updateSkills({ agent: opts.agent, scope, skillsUrl: opts.skillsUrl })
      if (opts.quiet) process.exit(ExitCode.OK)
      emitSuccess({ results }, (d) => renderSkillUpdateResults(d.results))
    })

  update
    .command('cli')
    .description('Install the latest @soku-ai/cli from npm')
    .option('--dry-run', 'Only report what would be installed')
    .action(async (opts: { dryRun?: boolean }) => {
      const result = await checkForUpdate()
      if (!result.updateAvailable || !result.latestVersion) {
        emitSuccess(result, (d) => `${d.packageName} is up to date (${d.currentVersion}).`)
      }
      if (opts.dryRun) {
        emitSuccess(result, (d) => `${d.packageName} ${d.currentVersion} -> ${d.latestVersion}\n${dim('Run')} ${cyan(d.installCommand)}`)
      }
      const status = runNpmCliInstall()
      if (status !== 0) {
        emitError('update_failed', `npm install exited with status ${status}`, ExitCode.RUNTIME, result.installCommand)
      }
      // npm's own postinstall.cjs already overwrote these files as a side
      // effect of the install above; report them so the caller — an agent
      // reading only the JSON `data` in non-TTY mode — knows to re-read them
      // instead of continuing on this session's now-stale cached guidance.
      const metaSkillPaths = refreshedMetaSkillPaths()
      emitSuccess(
        { ...result, installed: true, metaSkillRefreshed: metaSkillPaths, mustRereadMetaSkill: metaSkillPaths.length > 0 },
        (d) =>
          [
            `${green('✓')} Installed ${d.packageName} ${d.latestVersion}`,
            dim('Restart your shell or agent session to use it.'),
            ...(d.mustRereadMetaSkill
              ? [
                  bold(
                    "The Soku meta skill was refreshed by this install. Re-read it now before continuing — do not rely on this session's previously cached Soku CLI instructions:",
                  ),
                  ...d.metaSkillRefreshed.map((p) => `  ${p}`),
                ]
              : []),
          ].join('\n'),
      )
    })
}
