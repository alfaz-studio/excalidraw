# CLAUDE.md

## Critical Rules

- **NEVER add AI as a co-author** in commits or PRs. No `Co-Authored-By` lines for any AI.
- **Branch: `main`** — always work with `origin` (alfaz-studio/excalidraw), not upstream.
- **Conventional Commits** with scopes: `feat(feature-name): description`

## Project Structure

This is a **fork of Excalidraw** used as a git submodule in the [jitsi-meet](https://github.com/alfaz-studio/jitsi-meet) repo. It is a **monorepo** with a clear separation between the core library and the application:

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
