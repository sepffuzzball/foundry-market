#!/bin/sh
# Package the Foundry Market module into dist/module.zip and dist/module.json.
#
# The zip must be a valid Foundry module archive:
#   - module.json at the archive root
#   - src/ templates/ styles/ README.md docs/ (only paths that exist)
# Excluded: tests/ graphify-out/ node_modules/ .git/ dist/ (anything not listed).
#
# Requires the standard `zip` binary. Run via `npm run build`.

set -eu

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

if ! command -v zip >/dev/null 2>&1; then
  echo "error: 'zip' binary not found. Install it (e.g. 'apt-get install zip')." >&2
  exit 1
fi

# Fresh build directory.
rm -rf dist
mkdir -p dist

# Build the include list. module.json is always required; every other path is
# added only if it exists so we never emit empty or missing entries.
set -- module.json
for path in src templates styles README.md docs; do
  if [ -e "$path" ]; then
    set -- "$@" "$path"
  fi
done

# Create the archive from the repository root so module.json lands at the root
# of the zip (not inside a subdirectory).
zip -r -q dist/module.zip "$@"

# dist/module.json must be byte-for-byte identical to the source manifest so
# the release asset and the manifest stay in sync.
cp module.json dist/module.json

# Sanity checks.
if [ ! -s dist/module.zip ]; then
  echo "error: dist/module.zip is empty or missing" >&2
  exit 1
fi

if ! cmp -s module.json dist/module.json; then
  echo "error: dist/module.json differs from module.json" >&2
  exit 1
fi

echo "built dist/module.zip and dist/module.json"
