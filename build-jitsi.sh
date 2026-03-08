#!/bin/bash
# Build script for Excalidraw integration with Jitsi Meet

set -e

echo "Building Excalidraw for Jitsi Meet..."

# Build sub-packages if any are missing (needed as external deps by the main bundle)
if [ ! -f "packages/common/dist/prod/index.js" ] || \
   [ ! -f "packages/math/dist/prod/index.js" ] || \
   [ ! -f "packages/element/dist/prod/index.js" ]; then
    echo "Building sub-packages (esbuild only, skipping type generation)..."

    # Build each package using esbuild directly (skip gen:types which has
    # upstream TS2717 duplicate-declaration errors we don't need to fix).
    if [ ! -f "packages/common/dist/prod/index.js" ]; then
        echo "  Building @excalidraw/common..."
        (cd packages/common && rm -rf dist && node ../../scripts/buildBase.js)
    fi

    if [ ! -f "packages/math/dist/prod/index.js" ]; then
        echo "  Building @excalidraw/math..."
        (cd packages/math && rm -rf dist && node ../../scripts/buildBase.js)
    fi

    if [ ! -f "packages/element/dist/prod/index.js" ]; then
        echo "  Building @excalidraw/element..."
        (cd packages/element && rm -rf dist && node ../../scripts/buildBase.js)
    fi
else
    echo "Sub-packages already built."
fi

# Build main excalidraw package if missing
if [ ! -f "packages/excalidraw/dist/prod/index.js" ]; then
    echo "Building @excalidraw/excalidraw..."
    (cd packages/excalidraw && rm -rf dist && node ../../scripts/buildPackage.js)
else
    echo "Using existing package build from packages/excalidraw/dist/prod/"
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
