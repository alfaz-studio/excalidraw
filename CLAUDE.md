# CLAUDE.md

## Critical Rules

- **NEVER add AI as a co-author** in commits or PRs. No `Co-Authored-By` lines for any AI.
- **Branch: `main`** — always work with `origin` (Sonacove's fork), not upstream.
- **Conventional Commits** with scopes: `feat(feature-name): description`

## Project Structure

This is Sonacove's **fork of [excalidraw/excalidraw](https://github.com/excalidraw/excalidraw)**: upstream `master` plus a short series of Sonacove patches. It is a git submodule of the [Sonacove monorepo](https://github.com/alfaz-studio/sonacove) at `apps/meet/excalidraw`, where the meet app builds it with `build-jitsi.sh` and consumes only the package's public exports. Collaboration, storage and live-ink transport live in the host (`apps/meet/react/features/board/`), not here. The patch list and the upstream-sync steps are in the monorepo's `docs/meet/excalidraw-fork-patches.md`.

It is a **monorepo** with a clear separation between the core library and the application:

- **`packages/excalidraw/`** - Main React component library published to npm as `@excalidraw/excalidraw`
- **`excalidraw-app/`** - Full-featured web application (excalidraw.com) that uses the library
- **`packages/`** - Core packages: `@excalidraw/common`, `@excalidraw/element`, `@excalidraw/math`, `@excalidraw/utils`
- **`examples/`** - Integration examples (NextJS, browser script)

## Development Commands

```bash
yarn test:typecheck  # TypeScript type checking
yarn test:code       # ESLint (must pass with 0 warnings)
yarn test:other      # Prettier formatting check
yarn fix             # Auto-fix formatting and linting issues
yarn test:update     # Run all tests (with snapshot updates)
yarn build:packages  # Build all packages
```

## CI Checks

All checks run on PRs via GitHub Actions (`.github/workflows/ci.yml`):

- **TypeScript** — `yarn test:typecheck`
- **ESLint** — `yarn test:code` (0 warnings enforced)
- **Prettier** — `yarn test:other`
- **Build** — `yarn build:packages`

## Architecture Notes

### Package System

- Uses Yarn workspaces for monorepo management
- Internal packages use path aliases (see `vitest.config.mts`)
- Build system uses esbuild for packages, Vite for the app
- TypeScript throughout with strict configuration
