#!/usr/bin/env bash
# Build the ZIP that the OpenAI plugin directory (ChatGPT + Codex) accepts at
# platform.openai.com/plugins → Create plugin → Skills only.
#
# The directory wants "the plugin folder compressed into a .zip": the portable
# root `plugin.json`, `skills/`, `assets/` and the legacy `.codex-plugin/`
# manifest, nothing else. Source, tests and the other agents' manifests stay
# out so reviewers only see what the plugin ships.
#
#   scripts/bundle-openai-plugin.sh            # writes dist/soku-plugin-<version>.zip
#   scripts/bundle-openai-plugin.sh --folder   # wraps everything in a soku/ folder first
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -p "require('$ROOT/package.json').version")"
OUT_DIR="$ROOT/dist"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

PLUGIN_DIR="$STAGE"
if [[ "${1:-}" == "--folder" ]]; then
  PLUGIN_DIR="$STAGE/soku"
  mkdir -p "$PLUGIN_DIR"
fi

cd "$ROOT"
node scripts/stamp-release.mjs --check

mkdir -p "$PLUGIN_DIR/.codex-plugin" "$PLUGIN_DIR/assets"
cp plugin.json LICENSE README.md "$PLUGIN_DIR/"
cp .codex-plugin/plugin.json "$PLUGIN_DIR/.codex-plugin/"
cp -R skills "$PLUGIN_DIR/skills"
cp assets/*.png "$PLUGIN_DIR/assets/"

mkdir -p "$OUT_DIR"
ZIP="$OUT_DIR/soku-plugin-$VERSION.zip"
rm -f "$ZIP"
(cd "$STAGE" && zip -qr "$ZIP" . -x '.DS_Store' '*/.DS_Store')

echo "wrote $ZIP"
unzip -l "$ZIP" | awk 'NR>3 && $4 != "" {print "  " $4}'
