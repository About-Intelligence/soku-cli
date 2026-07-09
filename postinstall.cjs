#!/usr/bin/env node
/*
 * Refresh previously installed bundled Soku meta-skills after a global npm
 * install. Business skills still update through `soku update skills`, because
 * that path verifies catalog zip checksums and may need network access.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const MANIFEST_FILE = '.soku-skills.json'
const SOKU_META = 'soku'

function shouldRun() {
  return process.env.npm_config_global === 'true' || process.env.npm_config_global === '1'
}

function copyDir(source, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name)
    const to = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      copyDir(from, to)
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to)
    }
  }
}

function loadManifest(baseDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(baseDir, MANIFEST_FILE), 'utf8'))
  } catch {
    return {}
  }
}

function hasSokuSkill(baseDir) {
  const manifest = loadManifest(baseDir)
  return (
    Object.keys(manifest).length > 0 ||
    fs.existsSync(path.join(baseDir, SOKU_META, 'SKILL.md'))
  )
}

function refreshMetaSkill(baseDir, bundledDir) {
  if (!hasSokuSkill(baseDir)) return

  const dest = path.join(baseDir, SOKU_META)
  fs.mkdirSync(dest, { recursive: true })
  fs.rmSync(path.join(dest, 'SKILL.md'), { force: true })
  fs.rmSync(path.join(dest, 'references'), { recursive: true, force: true })
  fs.copyFileSync(path.join(bundledDir, 'SKILL.md'), path.join(dest, 'SKILL.md'))
  const referencesDir = path.join(bundledDir, 'references')
  if (fs.existsSync(referencesDir)) {
    copyDir(referencesDir, path.join(dest, 'references'))
  }

  const manifest = loadManifest(baseDir)
  manifest[SOKU_META] = {
    sha256: '',
    installed_at: new Date().toISOString(),
    source: 'bundled',
  }
  fs.writeFileSync(path.join(baseDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`)
}

function main() {
  if (!shouldRun()) return
  const bundledDir = path.join(__dirname, 'skills', SOKU_META)
  if (!fs.existsSync(path.join(bundledDir, 'SKILL.md'))) return

  for (const agentDir of ['.claude/skills', '.codex/skills', '.cursor/skills']) {
    try {
      refreshMetaSkill(path.join(os.homedir(), agentDir), bundledDir)
    } catch {
      // Best-effort lifecycle hook: npm install must not fail because an agent
      // skill directory is missing, locked, or otherwise temporarily unreadable.
    }
  }
}

main()
