#!/usr/bin/env node
/**
 * Stamp a release version across every file that has to agree on it.
 *
 *   node scripts/stamp-release.mjs 0.1.0-alpha.18
 *
 * Four places carry the version and they drift independently if a human edits
 * them one at a time. The publish workflow already refuses to publish when
 * `package.json` and `src/version.ts` disagree; the other two fail quietly,
 * which is worse — a stale `unreleased` changelog entry makes `soku changelog`
 * report a published release as unpublished, and a stale `cliVersion` in the
 * meta skill points agents at the wrong baseline.
 *
 * Pass --check to verify without writing (used by CI).
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE = join(ROOT, 'package.json')
const VERSION_TS = join(ROOT, 'src/version.ts')
const CHANGELOG = join(ROOT, 'src/generated/changelog.json')
const SKILL = join(ROOT, 'skills/soku/SKILL.md')

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

export function stampPackage(text, version) {
  return text.replace(/("version"\s*:\s*)"[^"]+"/, `$1"${version}"`)
}

export function stampVersionTs(text, version) {
  return text.replace(/(CLI_VERSION = ')[^']+(')/, `$1${version}$2`)
}

export function stampSkill(text, version) {
  return text.replace(/(cliVersion:\s*)"[^"]*"/, `$1"${version}"`)
}

/** Rename the `unreleased` entry to this version and date it.
 *
 * A release with nothing recorded under `unreleased` is refused rather than
 * silently producing an empty entry: either the changelog was already stamped,
 * or a release is going out with no record of what changed in it. */
export function stampChangelog(changelog, version, today) {
  const entry = changelog.entries.find((e) => e.version === 'unreleased')
  if (!entry) {
    throw new Error(
      `no "unreleased" entry to stamp — was ${version} already stamped, or did nothing get recorded?`,
    )
  }
  if (changelog.entries.some((e) => e.version === version)) {
    throw new Error(`changelog already has an entry for ${version}`)
  }
  return {
    ...changelog,
    entries: changelog.entries.map((e) =>
      e === entry ? { ...e, version, date: today } : e,
    ),
  }
}

function currentVersions() {
  const pkg = JSON.parse(readFileSync(PACKAGE, 'utf8')).version
  const src = readFileSync(VERSION_TS, 'utf8').match(/CLI_VERSION = '([^']+)'/)?.[1]
  const skill = readFileSync(SKILL, 'utf8').match(/cliVersion:\s*"([^"]*)"/)?.[1]
  const changelog = JSON.parse(readFileSync(CHANGELOG, 'utf8'))
  return { pkg, src, skill, changelog }
}

function check() {
  const { pkg, src, skill, changelog } = currentVersions()
  const problems = []
  if (pkg !== src) problems.push(`package.json ${pkg} != src/version.ts ${src}`)
  if (skill !== pkg) {
    problems.push(`skills/soku/SKILL.md cliVersion ${skill} != package.json ${pkg}`)
  }
  const stamped = changelog.entries.some((e) => e.version === pkg)
  if (!stamped) {
    problems.push(`changelog has no entry for the current version ${pkg}`)
  }
  if (problems.length > 0) {
    for (const p of problems) process.stderr.write(`  ${p}\n`)
    process.stderr.write('Run: node scripts/stamp-release.mjs <version>\n')
    process.exit(1)
  }
  process.stdout.write(`version ${pkg} is consistent across all four files\n`)
}

function main() {
  const arg = process.argv[2]
  if (arg === '--check') return check()
  if (!arg || !VERSION_RE.test(arg)) {
    process.stderr.write('usage: stamp-release.mjs <semver> | --check\n')
    process.exit(2)
  }
  const today = new Date().toISOString().slice(0, 10)

  writeFileSync(PACKAGE, stampPackage(readFileSync(PACKAGE, 'utf8'), arg))
  writeFileSync(VERSION_TS, stampVersionTs(readFileSync(VERSION_TS, 'utf8'), arg))
  writeFileSync(SKILL, stampSkill(readFileSync(SKILL, 'utf8'), arg))
  const changelog = JSON.parse(readFileSync(CHANGELOG, 'utf8'))
  writeFileSync(CHANGELOG, `${JSON.stringify(stampChangelog(changelog, arg, today), null, 2)}\n`)

  process.stdout.write(`stamped ${arg} (${today}) into package.json, src/version.ts, changelog.json, SKILL.md\n`)
  process.stdout.write(`next: commit as "chore: release ${arg}", then tag soku-ai-cli-v${arg}\n`)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
