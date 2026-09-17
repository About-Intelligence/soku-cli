#!/usr/bin/env bash
# Build the ZIP that the OpenAI plugin directory (ChatGPT + Codex) accepts at
# platform.openai.com/plugins → Create plugin → Skills only.
#
# The upload form wants "the plugin folder compressed into a .zip" in Codex
# format: `.codex-plugin/plugin.json`, `skills/` (each skill with its
# `agents/openai.yaml`), `assets/`, LICENSE and README, nothing else. Source,
# tests and the other agents' manifests stay out so reviewers only see what the
# plugin ships. The portable root `plugin.json` is left out by default: the form
# accepts it but warns that it will convert it, and the Codex manifest already
# carries the same fields.
#
#   scripts/bundle-openai-plugin.sh              # dist/soku-plugin-<version>.zip
#   scripts/bundle-openai-plugin.sh --folder     # wrap everything in a soku/ folder
#   scripts/bundle-openai-plugin.sh --portable   # also include the root plugin.json
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -p "require('$ROOT/package.json').version")"
OUT_DIR="$ROOT/dist"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

PLUGIN_DIR="$STAGE"
WITH_PORTABLE=0
for arg in "$@"; do
  case "$arg" in
    --folder) PLUGIN_DIR="$STAGE/soku"; mkdir -p "$PLUGIN_DIR" ;;
    --portable) WITH_PORTABLE=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

cd "$ROOT"
node scripts/stamp-release.mjs --check

mkdir -p "$PLUGIN_DIR/.codex-plugin" "$PLUGIN_DIR/assets"
cp LICENSE README.md "$PLUGIN_DIR/"
cp .codex-plugin/plugin.json "$PLUGIN_DIR/.codex-plugin/"
[[ "$WITH_PORTABLE" == 1 ]] && cp plugin.json "$PLUGIN_DIR/"
cp -R skills "$PLUGIN_DIR/skills"
cp assets/*.png "$PLUGIN_DIR/assets/"

mkdir -p "$OUT_DIR"
ZIP="$OUT_DIR/soku-plugin-$VERSION.zip"
rm -f "$ZIP"
(cd "$STAGE" && zip -qr "$ZIP" . -x '.DS_Store' '*/.DS_Store')

echo "wrote $ZIP"
unzip -l "$ZIP" | awk 'NR>3 && $4 != "" {print "  " $4}'
