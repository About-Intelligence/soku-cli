import { Command } from 'commander'

import { cyan, dim, emitError, emitSuccess, ExitCode } from './output/envelope.js'
import { CLI_PACKAGE_NAME, CLI_VERSION } from './version.js'

const DEFAULT_REGISTRY_URL = 'https://registry.npmjs.org'
const INSTALL_COMMAND = `npm i -g ${CLI_PACKAGE_NAME}`
const REQUEST_TIMEOUT_MS = 2500

export interface UpdateCheckResult {
  packageName: string
  currentVersion: string
  latestVersion: string | null
  published: boolean
  updateAvailable: boolean
  installCommand: string
  checkedAt: string
  registryUrl: string
}

interface CheckOptions {
  currentVersion?: string
  registryUrl?: string
  fetchImpl?: typeof fetch
  now?: Date
}

function parseVersionParts(version: string): number[] {
  const core = version.split('-', 1)[0] ?? ''
  return core.split('.').map((part) => {
    const n = Number(part)
    return Number.isFinite(n) ? n : 0
  })
}

function prereleaseParts(version: string): string[] {
  const idx = version.indexOf('-')
  if (idx === -1) return []
  return version.slice(idx + 1).split(/[.+]/).filter(Boolean)
}

function comparePrerelease(a: string, b: string): number {
  const aa = prereleaseParts(a)
  const bb = prereleaseParts(b)
  if (aa.length === 0 && bb.length === 0) return 0
  if (aa.length === 0) return 1
  if (bb.length === 0) return -1
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    const left = aa[i]
    const right = bb[i]
    if (left === undefined) return -1
    if (right === undefined) return 1
    const leftNum = /^\d+$/.test(left) ? Number(left) : null
    const rightNum = /^\d+$/.test(right) ? Number(right) : null
    if (leftNum !== null && rightNum !== null) {
      const diff = leftNum - rightNum
      if (diff !== 0) return diff
      continue
    }
    if (leftNum !== null) return -1
    if (rightNum !== null) return 1
    const diff = left.localeCompare(right)
    if (diff !== 0) return diff
  }
  return 0
}

export function compareSemverish(a: string, b: string): number {
  const aa = parseVersionParts(a)
  const bb = parseVersionParts(b)
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    const diff = (aa[i] ?? 0) - (bb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return comparePrerelease(a, b)
}

async function fetchLatestVersion(registryUrl: string, fetchImpl: typeof fetch): Promise<string | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const packagePath = encodeURIComponent(CLI_PACKAGE_NAME)
    const res = await fetchImpl(`${registryUrl.replace(/\/$/, '')}/${packagePath}/latest`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    })
    if (res.status === 404) return null
    if (!res.ok) {
      throw new Error(`npm registry returned HTTP ${res.status}`)
    }
    const data = (await res.json()) as { version?: unknown }
    if (typeof data.version !== 'string' || data.version.length === 0) {
      throw new Error('npm registry response did not include a version')
    }
    return data.version
  } finally {
    clearTimeout(timeout)
  }
}

export async function checkForUpdate(opts: CheckOptions = {}): Promise<UpdateCheckResult> {
  const currentVersion = opts.currentVersion ?? CLI_VERSION
  const registryUrl = (opts.registryUrl ?? DEFAULT_REGISTRY_URL).replace(/\/$/, '')
  const now = opts.now ?? new Date()

  const latestVersion = await fetchLatestVersion(registryUrl, opts.fetchImpl ?? fetch)
  const checkedAt = now.toISOString()

  return {
    packageName: CLI_PACKAGE_NAME,
    currentVersion,
    latestVersion,
    published: latestVersion !== null,
    updateAvailable: latestVersion !== null && compareSemverish(latestVersion, currentVersion) > 0,
    installCommand: INSTALL_COMMAND,
    checkedAt,
    registryUrl,
  }
}

function shouldSkipNotice(): boolean {
  if (process.env.CI) return true
  if (process.env.SOKU_NO_UPDATE_CHECK === '1') return true
  return false
}

export async function maybeNotifyUpdate(): Promise<void> {
  if (shouldSkipNotice()) return
  try {
    const result = await checkForUpdate()
    if (!result.updateAvailable || !result.latestVersion) return
    process.stderr.write(
      `${dim('Update available:')} ${CLI_PACKAGE_NAME} ${result.currentVersion} -> ${result.latestVersion}\n` +
        `${dim('Run')} ${cyan('soku update cli')}\n`,
    )
  } catch {
    // Update checks are advisory. Never fail the user command because npm is
    // unreachable, private, or temporarily returning a malformed response.
  }
}

export function registerUpdateCheckCommand(program: Command): void {
  program
    .command('update-check', { hidden: true })
    .description('Legacy alias for `soku update status`')
    .option('--registry-url <url>', 'Override the npm registry URL')
    .action(async (opts: { registryUrl?: string }) => {
      try {
        const result = await checkForUpdate({
          registryUrl: opts.registryUrl,
        })
        emitSuccess(result, (d) => {
          if (!d.published) {
            return `${CLI_PACKAGE_NAME} is not published on npm yet.\n${dim('Use a local linked build for development.')}`
          }
          if (!d.latestVersion) return `${CLI_PACKAGE_NAME}: no published version found.`
          if (!d.updateAvailable) return `${CLI_PACKAGE_NAME} is up to date (${d.currentVersion}).`
          return [
            `${CLI_PACKAGE_NAME} ${d.currentVersion} -> ${d.latestVersion}`,
            `${dim('Run')} ${cyan('soku update cli')}`,
          ].join('\n')
        })
      } catch (err) {
        emitError(
          'update_check_failed',
          err instanceof Error ? err.message : String(err),
          ExitCode.RUNTIME,
          'Set SOKU_NO_UPDATE_CHECK=1 to disable background checks.',
        )
      }
    })
}
