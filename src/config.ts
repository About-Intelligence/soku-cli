/** Persistent CLI config at ~/.soku/config.json (active workspace only). */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export interface SokuConfig {
  /** Deprecated and ignored. Endpoint overrides are environment-only. */
  apiBaseUrl?: string
  activeOrgId?: string
  activeBrandId?: string
  /** Deprecated and ignored. Skill catalog overrides are environment-only. */
  skillsBaseUrl?: string
}

const DEFAULT_API_BASE = 'https://api.soku.ai'
const DEFAULT_SKILLS_BASE = 'https://api.soku.ai/api/cli/skills'

export function configDir(): string {
  return join(homedir(), '.soku')
}

function configPath(): string {
  return join(configDir(), 'config.json')
}

export function loadConfig(): SokuConfig {
  try {
    return JSON.parse(readFileSync(configPath(), 'utf8')) as SokuConfig
  } catch {
    return {}
  }
}

export function saveConfig(config: SokuConfig): void {
  const path = configPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(config, null, 2), { mode: 0o600 })
}

export function updateConfig(patch: Partial<SokuConfig>): SokuConfig {
  const next = { ...loadConfig(), ...patch }
  saveConfig(next)
  return next
}

/** Resolution order: --api-base flag (caller passes) → env → production default. */
export function resolveApiBaseUrl(flag?: string): string {
  return (
    flag ||
    process.env.SOKU_API_BASE ||
    DEFAULT_API_BASE
  ).replace(/\/$/, '')
}

/** Resolution order: --skills-url flag → env → production skill catalog. */
export function resolveSkillsBaseUrl(flag?: string): string {
  return (
    flag ||
    process.env.SOKU_SKILLS_URL ||
    DEFAULT_SKILLS_BASE
  ).replace(/\/$/, '')
}
