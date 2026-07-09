/** Safe in-memory unzip for skill bundles downloaded from the public catalog.
 *
 * Mirrors the server's `packages/services/marketplace/zip_safety.py` rules so a
 * bundle the packer produces is one the CLI will accept: strip a single top
 * folder, reject path traversal / absolute / backslash / symlink-ish paths,
 * enforce an extension whitelist + count/size caps, and require SKILL.md at the
 * (stripped) root. Pure — returns a relpath→bytes map without touching disk, so
 * it is unit-testable and the caller decides where to write. */

import { unzipSync } from 'fflate'

const ALLOWED_EXTENSIONS = new Set(['.md', '.json', '.txt', '.yaml', '.yml', '.csv'])
const MAX_FILE_COUNT = 100
const MAX_SINGLE_FILE_BYTES = 10 * 1024 * 1024
const MAX_TOTAL_BYTES = 50 * 1024 * 1024
const SKILL_MANIFEST = 'SKILL.md'

export class UnzipError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnzipError'
  }
}

function isMacMetadata(name: string): boolean {
  if (name.startsWith('__MACOSX/') || name.includes('/__MACOSX/')) return true
  const base = name.split('/').pop() ?? ''
  return base === '.DS_Store' || base.startsWith('._')
}

/** If every entry sits under the same top-level dir, return that dir; else null. */
function singleTopFolder(names: string[]): string | null {
  const first = names[0].split('/', 1)[0]
  if (!first || first === names[0]) return null // already flat
  const ok = names.every((n) => n.startsWith(`${first}/`) && n !== `${first}/`)
  return ok ? first : null
}

function checkPath(rel: string): void {
  if (!rel || rel.startsWith('/') || rel.includes('\\')) {
    throw new UnzipError(`unsafe path: ${rel}`)
  }
  if (rel.split('/').some((seg) => seg === '..' || seg === '.')) {
    throw new UnzipError(`path traversal: ${rel}`)
  }
}

function extOf(rel: string): string {
  const base = rel.split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot >= 0 ? base.slice(dot).toLowerCase() : ''
}

/** Unzip + validate; returns a stripped relpath → bytes map. Throws UnzipError. */
export function safeUnzip(data: Uint8Array): Map<string, Uint8Array> {
  let raw: Record<string, Uint8Array>
  try {
    raw = unzipSync(data)
  } catch (err) {
    throw new UnzipError(`corrupt zip: ${(err as Error).message}`)
  }

  const names = Object.keys(raw).filter((n) => !n.endsWith('/') && !isMacMetadata(n))
  if (names.length === 0) throw new UnzipError('empty zip')
  if (names.length > MAX_FILE_COUNT) {
    throw new UnzipError(`too many files: ${names.length} > ${MAX_FILE_COUNT}`)
  }

  const top = singleTopFolder(names)
  const out = new Map<string, Uint8Array>()
  let total = 0
  for (const name of names) {
    const rel = top ? name.slice(top.length + 1) : name
    checkPath(rel)
    if (!ALLOWED_EXTENSIONS.has(extOf(rel))) {
      throw new UnzipError(`disallowed extension: ${rel}`)
    }
    const bytes = raw[name]
    if (bytes.length > MAX_SINGLE_FILE_BYTES) {
      throw new UnzipError(`file too large: ${rel} (${bytes.length}B)`)
    }
    total += bytes.length
    if (total > MAX_TOTAL_BYTES) throw new UnzipError(`bundle too large: ${total}B`)
    out.set(rel, bytes)
  }

  if (!out.has(SKILL_MANIFEST)) {
    throw new UnzipError(`${SKILL_MANIFEST} required at bundle root`)
  }
  return out
}
