---
name: esbuild-esm
version: 2025.12.1
domain: build
expires: 2026-12-01
activates_on: [esbuild, build, bundle, esm, import, export, module, cjs, commonjs, dist, entry]
sources:
  - https://esbuild.github.io/api/
  - https://nodejs.org/api/esm.html
context7: evanw/esbuild
---

# esbuild + ESM

## esbuild Config
- Entry: `esbuild.build({ entryPoints, bundle, platform, format, outdir })`
- Platform: `'node'` for CLI tools (excludes node builtins from bundle)
- Format: `'esm'` — this project is ESM-first (`"type": "module"` in package.json)
- External: mark `better-sqlite3`, native addons as external (can't bundle .node files)
- Sourcemaps: `sourcemap: true` for debugging

## ESM Rules (Node.js)
- **Always** add `.js` extension to relative imports: `import { foo } from './bar.js'`
- `__dirname` / `__filename` not available — use `import.meta.url` + `fileURLToPath()`
- `require()` not available — use `createRequire(import.meta.url)` for CJS interop
- Top-level `await` works in ESM
- JSON imports: `import data from './file.json' with { type: 'json' }` (or createRequire)

## CJS Interop
- Import CJS from ESM: default import works (`import pkg from 'cjs-pkg'`)
- Named exports: may need `import pkg from 'pkg'; const { named } = pkg;`
- `better-sqlite3`: CJS native addon — import as default, mark external in esbuild

## Package.json
- `"type": "module"` — all .js files are ESM
- `"exports"` field for package entry points (not just "main")
- `"bin"` field for CLI executables — ensure shebang `#!/usr/bin/env node`

## Gotchas
- Missing `.js` extension → `ERR_MODULE_NOT_FOUND` (most common error)
- esbuild `bundle: true` inlines deps — use `external` for native modules
- `--packages=external` excludes all node_modules (useful for dev builds)
- Watch mode: `esbuild.context().then(ctx => ctx.watch())` — not `--watch` flag in API
