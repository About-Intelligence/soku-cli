/** Token storage: env override → OS keychain (keytar) → 0600 file fallback.
 *
 * keytar is a native, optional dependency. In headless/CI/container environments
 * (where agents typically run) it can fail to load entirely, so every keytar
 * call is guarded and we fall back to a 0600 file. Agents/CI should prefer the
 * SOKU_TOKEN env var, which bypasses storage completely.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { configDir } from '../config.js'

const SERVICE = 'soku-cli'
const ACCOUNT = 'session'

interface KeytarLike {
  getPassword(service: string, account: string): Promise<string | null>
  setPassword(service: string, account: string, password: string): Promise<void>
  deletePassword(service: string, account: string): Promise<boolean>
}

let keytarWarned = false

async function loadKeytar(): Promise<KeytarLike | null> {
  // Explicit opt-out (CI/tests/containers): skip the OS keychain entirely.
  if (process.env.SOKU_NO_KEYCHAIN) return null
  try {
    const mod = (await import('keytar')) as unknown as { default?: KeytarLike } & KeytarLike
    return mod.default ?? mod
  } catch {
    if (!keytarWarned) {
      process.stderr.write(
        'soku: OS keychain unavailable; storing token in ~/.soku/credentials.json (0600). ' +
          'Set SOKU_TOKEN to avoid on-disk storage.\n',
      )
      keytarWarned = true
    }
    return null
  }
}

function credentialsPath(): string {
  return join(configDir(), 'credentials.json')
}

export async function saveToken(token: string): Promise<void> {
  const keytar = await loadKeytar()
  if (keytar) {
    try {
      await keytar.setPassword(SERVICE, ACCOUNT, token)
      return
    } catch {
      // fall through to file
    }
  }
  const path = credentialsPath()
  mkdirSync(configDir(), { recursive: true })
  writeFileSync(path, JSON.stringify({ token }), { mode: 0o600 })
}

export async function loadToken(): Promise<string | null> {
  const fromEnv = process.env.SOKU_TOKEN?.trim()
  if (fromEnv) return fromEnv

  const keytar = await loadKeytar()
  if (keytar) {
    try {
      const token = await keytar.getPassword(SERVICE, ACCOUNT)
      if (token) return token
    } catch {
      // fall through to file
    }
  }
  try {
    const parsed = JSON.parse(readFileSync(credentialsPath(), 'utf8')) as { token?: string }
    return parsed.token ?? null
  } catch {
    return null
  }
}

export async function clearToken(): Promise<void> {
  const keytar = await loadKeytar()
  if (keytar) {
    try {
      await keytar.deletePassword(SERVICE, ACCOUNT)
    } catch {
      // ignore
    }
  }
  try {
    rmSync(credentialsPath(), { force: true })
  } catch {
    // ignore
  }
}
