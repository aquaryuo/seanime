#!/bin/sh
# Pre-release check: what CI runs, stopping at the first failure.
set -e
cd "$(dirname "$0")/.."
[ -d node_modules/typescript ] && [ -d node_modules/esbuild ] || npm install --no-save typescript@7 esbuild@0.28
for cfg in extensions/*/tsconfig.json; do
    echo "--- $cfg"
    npx tsc --noEmit --project "$cfg"
done
for f in extensions/*/provider.ts; do
    echo "--- $f"
    npx esbuild --loader=ts --target=es2018 --minify-whitespace --minify-syntax < "$f" > /dev/null
done
node tools/gen-marketplace.mjs --check
node tools/pure.test.mjs
