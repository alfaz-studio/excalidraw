#!/bin/bash
# Build script for Excalidraw integration with Jitsi Meet

set -e

echo "Building Excalidraw for Jitsi Meet..."

# Rebuild when the SOURCES have moved, not merely when a dist is absent.
#
# This used to skip on `[ -f dist/prod/index.js ]` alone, which meant any edit to
# the fork was silently ignored on every machine that had already built once: the
# script printed "build complete" and copied a stale bundle forward with a fresh
# timestamp. A missing export then failed at runtime as an `undefined` the caller
# guarded away, so nothing surfaced until someone traced it from the symptom.
#
# The stamp is the submodule's HEAD plus a digest of the tracked working tree, so
# both a pin change and an uncommitted edit invalidate it.
STAMP_FILE="packages/excalidraw/dist/prod/.source-stamp"
SOURCE_STAMP="$(git rev-parse HEAD 2>/dev/null || echo nogit)-$(git status --porcelain 2>/dev/null | sha1sum | cut -c1-12)"

if [ ! -f "packages/excalidraw/dist/prod/index.js" ] || [ "$(cat "$STAMP_FILE" 2>/dev/null)" != "$SOURCE_STAMP" ]; then
    echo "Package dist missing or stale. Building packages (esbuild only, skipping type generation)..."

    # Build each package using esbuild directly (skip gen:types which has
    # upstream TS2717 duplicate-declaration errors we don't need to fix).
    echo "  Building @excalidraw/common..."
    (cd packages/common && rm -rf dist && node ../../scripts/buildBase.js)

    echo "  Building @excalidraw/math..."
    (cd packages/math && rm -rf dist && node ../../scripts/buildBase.js)

    echo "  Building @excalidraw/element..."
    (cd packages/element && rm -rf dist && node ../../scripts/buildBase.js)

    echo "  Building @excalidraw/excalidraw..."
    (cd packages/excalidraw && rm -rf dist && node ../../scripts/buildPackage.js)

    # Written only after every package succeeds, so an interrupted build is
    # retried rather than remembered as current.
    echo "$SOURCE_STAMP" > "$STAMP_FILE"
else
    echo "Using existing package build from packages/excalidraw/dist/prod/ (sources unchanged)"
fi

# Create dist directory structure
echo "Step 1: Creating dist directory structure..."
rm -rf dist
mkdir -p dist

# Copy the main package bundle, CSS, and chunks (all in same dir for relative imports)
echo "Step 2: Copying package bundle, chunks, and CSS..."
cp packages/excalidraw/dist/prod/index.js dist/excalidraw.production.min.js
cp packages/excalidraw/dist/prod/index.css dist/excalidraw.production.css
cp packages/excalidraw/dist/prod/chunk-*.js dist/ 2>/dev/null || true
cp packages/excalidraw/dist/prod/*.chunk.js dist/ 2>/dev/null || true

# Copy assets (fonts, locales, data)
echo "Step 3: Copying assets..."
cp -r packages/excalidraw/dist/prod/fonts dist/excalidraw-assets
cp -r packages/excalidraw/dist/prod/fonts dist/excalidraw-assets-dev
cp -r packages/excalidraw/dist/prod/locales dist/excalidraw-assets/ 2>/dev/null || true
cp -r packages/excalidraw/dist/prod/locales dist/excalidraw-assets-dev/ 2>/dev/null || true
cp -r packages/excalidraw/dist/prod/data dist/excalidraw-assets/ 2>/dev/null || true
cp -r packages/excalidraw/dist/prod/data dist/excalidraw-assets-dev/ 2>/dev/null || true

echo "✓ Excalidraw build complete!"
echo "  Main bundle: dist/excalidraw.production.min.js ($(du -h dist/excalidraw.production.min.js | cut -f1))"
echo "  CSS: dist/excalidraw.production.css ($(du -h dist/excalidraw.production.css | cut -f1))"
echo "  Chunks: $(ls -1 dist/chunk-*.js 2>/dev/null | wc -l | tr -d ' ') files"
echo "  Assets: dist/excalidraw-assets/"
