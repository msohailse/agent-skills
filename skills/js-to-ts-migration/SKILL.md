---
name: js-to-ts-migration
description: Incrementally convert a CommonJS Node.js codebase (Express, Mongoose and similar) from JavaScript to TypeScript one file at a time, with no build step, using Node 22.18+/24's built-in type stripping. Covers setting up tsc type checking in CI, converting a single file safely, keeping the .js and .ts mix working, and a PR check that enforces the migration rules. Use this whenever someone wants to move a Node/Express backend to TypeScript, write a new file in TypeScript inside a JavaScript repo, convert "just this one service" to .ts, plan a TS migration, or asks whether converting a running API to TypeScript is safe, even if they don't say "migration".
---

# JS to TS migration (Node type stripping, no build)

A one-shot conversion of a live JavaScript API almost always breaks a caller somewhere. The conversion itself changes nothing; the breakage comes from what people "fix" while satisfying the compiler, and from build and load-order changes. This skill gets a repo to TypeScript one small, revertable PR at a time, with production behaviour unchanged at every step.

The approach: new and converted files are `.ts`, and Node runs them directly by stripping the types. The repo stays CommonJS. `tsc --noEmit` type-checks the `.js` and `.ts` mix in CI. A PR check enforces the rules so parallel work doesn't collide with the migration.

## 1. Check the runtime first

Type stripping needs Node 22.18+ or 23.6+ (on by default; Node 24 is the comfortable target). Confirm the version that production actually runs, not just the local one: read the Dockerfile `FROM`, the `engines` field and the deploy config, and run `node -v` inside the production image if you can.

Then prove it in that runtime before converting anything: a `.ts` file using `require`/`module.exports` and a type annotation, required from a `.js` file with the explicit `.ts` extension. If that prints no warnings and works, you need no build step. If production is older Node, either upgrade Node first (as its own change) or use the `dist/` fallback in [What breaks, and how to check](#what-breaks-and-how-to-check).

## 2. The house rules for a .ts file

These come from what Node's type stripper accepts and what keeps the mix working:

- **Erasable syntax only.** Types, interfaces, `type` aliases, `import type`, `satisfies` and `as` casts are fine. Enums, namespaces, parameter properties and `import x = require()` are not, because they need code generated. Use a const object plus a union type in place of an enum.
- **Stay CommonJS.** Use `require` and `module.exports`, never `import x from` or `export const`. If Node sees ESM syntax in a `.ts` file it loads the file as an ES module, and `module.exports` then throws. `verbatimModuleSyntax` in the tsconfig makes tsc reject that syntax before it ships. ESM would also change load order, which matters: dotenv and APM agents usually have to load first.
- **Types from packages** come in with `import type { Request, Response } from 'express'`, which Node erases completely.
- **Require with the extension.** `require('./thing.service.ts')`. An extensionless require does not find a `.ts` file.
- **Typing a sibling module.** `require()` returns `any` in a `.ts` file. When you want a dependency typed, the dependency exports its shape (`export type Service = typeof service`), and the caller writes `import type { Service } from './service.ts'` plus `const service: Service = require('./service.ts')`.
- **No behaviour changes in a conversion PR.** Keep loose comparisons, truthiness checks and `any` where the old code relied on them. Tighten in a separate, tested PR.

Use the tsconfig in [Files to add](#files-to-add) and adjust its `include` list to the repo's folders. It enforces these rules (`erasableSyntaxOnly`, `allowImportingTsExtensions`, `noEmit`, `allowJs` with `checkJs: false`).

## 3. Phases

Each phase is its own PR, can ship on its own and can be reverted on its own.

0. **Type checking only.** Add `typescript`, `@types/node` (matching the production Node major) and the framework's `@types/*` as dev dependencies, the tsconfig, an `npm run typecheck` script (`tsc -p tsconfig.json`), and a typecheck step in the existing CI test job. Nothing in runtime changes.
   - Pin exact versions, and skip anything published in the last few days. Choose the TypeScript major on purpose: a new major can change how JS files are checked, so move to it in its own PR later.
   - Keep the compiler out of the production image. If the Dockerfile runs a plain `npm install`, typescript ships with it as dead weight; install with `npm ci --omit=dev` there.
   - Read the lockfile diff. A newer `@types/node` can move a hoisted copy that other packages' types depend on, which is harmless but worth saying in the PR.
   - Optionally turn on `// @ts-check` for a couple of tiny JS files. Under `strict`, a bare `@ts-check` fails on untyped `req`/`res`/`next` parameters, so add JSDoc types (comments only) rather than code changes.
1. **Guardrails.** Add the migration-rules PR check from step 5, the queued-files list and the agent guidance. Also add the require-resolution check (both are in [Files to add](#files-to-add)). With `checkJs` off, tsc won't report a `.js` file that still requires a renamed module, and a missed rename crashes the app at boot. Don't count on a deploy healthcheck to catch that. If the repo uses nodemon, set its `ext` to `js,ts,json` so dev restarts on `.ts` changes.
2. **Leaf modules,** one file per PR. Start with files that require no other app modules, then work inward: services, helpers, utilities. Write any new file as `.ts` from day one. Beyond typecheck and tests, deploy each one to staging and hit `/health` plus a few read-only endpoints of the module you changed.
3. **Upgrade the ORM on its own,** before typing models, if its version has weak typings or open security advisories (for example Mongoose 5 to a supported major). Otherwise you type everything twice. Keep this PR in plain JS with no type work mixed in. Watch for removed callback APIs (code and tests that still pass a callback to `findOneAndUpdate`), changed `strictQuery` defaults, and changed return values from `lean()` and `findOneAndUpdate`. Verify on staging with read-only traffic, and remember that staging and production sometimes share a database cluster.
4. **Models.** One interface per schema. Schemas with `strict: false` hold open-ended documents, so type them loosely: known fields plus an index signature. Don't change schema options or indexes in these PRs.
5. **Routes, then small controllers, then the big ones last.** A shared CRUD factory becomes a generic. Split the largest controllers before converting them. Before converting a controller, add a test that pins its response shape.
6. **Tighten.** Turn `checkJs` on folder by folder for whatever JS is left, add request validation at the HTTP boundary (zod or similar), and leave the entry files (`app.js`, the APM and env bootstrap, `bin/www`) as plain JS.

## 4. Converting a file, in short

Follow [Converting one file](#converting-one-file) for every file. The short version:

1. `git mv x.js x.ts`, then add types without changing logic.
2. Update every `require('./x')` to `require('./x.ts')`. Grep the source, the tests and any scripts.
3. Grep `tests/` for stubs keyed on the old path (`Module._load`, proxyquire, `jest.mock`, regexes like `x(\.js)?$`). They silently stop matching after a rename.
4. Run typecheck and the unit tests, then load the file in the production image (`node -e "require('./path/x.ts')"` with dummy env) to prove it resolves there.
5. Remove the file from the queued list in the same PR.

## 5. Migration rules PR check

`scripts/check-ts-migration.js` (in [Files to add](#files-to-add)) reads a small config, `.github/ts-migration.json`, and fails a PR that:

- adds a new `.js` file in a folder that's now TypeScript-only;
- leaves a `.js` copy next to a converted `.ts` file;
- edits a file queued for conversion, unless the PR has the migration label.

Install it with the GitHub Actions workflow in [Files to add](#files-to-add). The messages state the rule, not a person. They also tell an AI coding agent to stop and point its user to the plan instead of working around the check. Add the short agent guidance as `AGENTS.md`, and the same few lines in `CLAUDE.md` if the repo has one. For a hard gate, the repo admin can pair this with branch protection.

Test the check locally before opening the PR: a new `.js` file in a TypeScript-only folder, a `.js` restored next to a `.ts`, a queued-file edit with and without the label, and an unrelated change. Run it with `BASE_REF=main PR_LABELS=typescript node scripts/check-ts-migration.js`.

## 6. Before calling a step done

- `npm run typecheck` is clean and the unit-test count is unchanged.
- The changed files load in the production image.
- For a file on a hot path, run the real flow once in throwaway containers on an internal-only Docker network (no internet). Use an empty database, and point the env at mock servers rather than real services. That way a hard-coded production URL fails closed instead of reaching production. Never mount the real `.env`.

Read [What breaks, and how to check](#what-breaks-and-how-to-check) before phase 2. It lists what actually breaks in these migrations (load order, env read at module load, cache value shapes, test stubs, static asset paths, response shape drift) and how to check each one.

## Converting one file

Use this for every file. One file per PR keeps review small and makes a revert trivial.

1. **Pick the file.** Prefer leaves: files that require little and are required by few. `grep -rn "require('.*/name')"` shows who depends on it.
2. **Rename** with `git mv name.js name.ts`, so history follows the file.
3. **Add types, not changes.**
   - Annotate parameters, return types and the shapes you read. Interfaces for documents and payloads are worth it; `any` is acceptable where the old code was loose.
   - Keep the logic identical: the same comparisons (`==` stays `==` if it was there), the same truthiness checks, the same mutation of objects.
   - Keep `require` / `module.exports`. Keep the order of top-level requires.
   - If the compiler forces a real change (a genuine bug), make it a separate commit with its own test, or a separate PR.
4. **Update callers.** Every `require('./name')` becomes `require('./name.ts')`. Search source, tests, scripts, seeders and anything that loads modules by path.
5. **Update test stubs.** Search `tests/` for the old filename in `Module._load` hooks, proxyquire paths, `jest.mock` calls, or regexes like `name(\.js)?$`. A stub that stops matching doesn't fail; it quietly loads the real module. Keep test files `.js` if the test runner's glob only picks up `*.js`. For a module that writes to a cache or queue, add a test that pins the key names and encoding before converting it.
6. **Verify.**
   - `npm run typecheck`: clean.
   - Unit tests: the same passing count as before.
   - Production image: `docker run --rm -e <dummy env> <image> node -e "require('./path/name.ts')"` loads with no warnings.
   - For hot paths, one end-to-end run in throwaway containers (see SKILL.md step 6).
7. **Bookkeeping.** Remove the file from `inProgress` in the migration config, and label the PR with the migration label.
8. **PR description.** One line up top saying it's a TypeScript conversion with no behaviour change, then what you verified.

## What breaks, and how to check

### Load order
Apps often do `require('dotenv').config()` and start an APM agent before anything else. ESM `import` statements are hoisted, so converting the entry file to `import` makes every module load before dotenv runs. Modules then read empty env, and the APM agent misses early modules. Stay CommonJS. If you ever move to ESM, keep env and APM setup in a separate entry file that loads first (`node -r ./preload.js`).
*Check:* the first lines of the entry file and `bin/` scripts are unchanged.

### Env read at module load
Top-level `const x = process.env.Y` is evaluated once, when the module loads. Reordering requires or lazy-loading changes the value it sees.
*Check:* `grep -rn "^\(const\|let\|var\) .*process\.env"` and keep those modules' load order.

### Cache and queue value shapes
Values in Memcached, Redis or a queue are read by other processes, sometimes other services. Changing a key name, a field name or the serialization (for example JSON vs gzip+JSON) while "cleaning up types" breaks the readers.
*Check:* list every cache and queue key and keep their names and payloads byte-compatible.

### Response shape drift
Other services depend on the exact JSON your routes return. Typing a response and dropping a field the type didn't declare, or turning a missing field into `null`, breaks them silently.
*Check:* before and after a controller conversion, diff real responses for its main routes against a test database.

### Test stubs keyed on paths
Hooks such as `Module._load`, proxyquire and `jest.mock('./x')` match on the resolved path. After a rename they stop matching and the real module loads, which can mean real network or database calls in tests.
*Check:* grep tests for the old filename in every conversion PR.

### Static assets and file reads
`fs.readFileSync(path.join(__dirname, 'spec.json'))` and `express.static(__dirname + '/public')` keep working with type stripping, because files stay where they are. They break with a `dist/` build unless you copy the assets.

### Circular requires
CommonJS cycles give a partially filled `module.exports` object. Destructuring at require time (`const { fn } = require('./a')`) captures `undefined` in a cycle.
*Check:* run a cycle detector (madge, or a small DFS over relative requires) before converting the files involved.

### Broken require paths in .js files
With `checkJs` off, tsc doesn't report a `require('./x')` in a `.js` file that no longer resolves, for example after `x.js` became `x.ts`. The first sign is a MODULE_NOT_FOUND crash at boot.
*Check:* add a small CI step that resolves every relative `require` in the repo (walk the files, `require.resolve` each path from its file's folder, fail on any miss), and boot-load changed files in the production image.

### ORM typings
Old ORM versions have weak or wrong types (Mongoose 5, for example). Typing models on them, then upgrading, is double work, and these versions often have security advisories anyway. Upgrade first, as its own tested PR.

### Monitoring
Type stripping replaces types with whitespace, so line and column numbers stay the same. Stack traces in APM, error trackers and chat alerts point at the real source with no source maps. With a `dist/` build you need source maps.

### Node version and base images
Type stripping needs Node 22.18+ or 23.6+, and every image that might run the app has to qualify. A private-registry base image tagged like the public one can lag behind it, so check `node -v` inside each image before it's deployed. Files under `node_modules` are never stripped, so dependencies still have to ship JavaScript.

### Fallback: a dist/ build
Only use this if type stripping blocks something: old Node in production, or a dependency or feature that needs enums or decorators.
- Compile with `tsc` (`allowJs`, CommonJS output) to `dist/`.
- Copy the static assets and any JSON read by path next to the output.
- Keep dotenv and APM in a plain JS entry that loads first.
- Turn source maps on for APM.
- Keep the path-matching tests running against the source, not `dist/`.
- Update the Dockerfile and start command, and prove the build with zero `.ts` files first.

It changes how the app deploys, which is why it isn't the default.

## Files to add

Write these into the target repo, adjusting paths and folder names to fit it.

### `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "es2024",
    "lib": ["es2024"],
    "module": "node20",
    "moduleResolution": "node16",
    "moduleDetection": "force",
    "types": ["node"],

    "noEmit": true,
    "allowJs": true,
    "checkJs": false,
    "allowImportingTsExtensions": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "resolveJsonModule": true,

    "strict": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["*.js", "*.ts", "src/**/*.js", "src/**/*.ts", "tests/**/*.js", "tests/**/*.ts"],
  "exclude": ["node_modules", "dist", "public", "coverage"]
}
```

### `.github/ts-migration.json`

`tsOnlyDirs` lists the folders where new files must be `.ts`. `inProgress` lists the files queued for conversion. Remove a file from it in the PR that converts it, and add folders to `tsOnlyDirs` as each phase starts.

```json
{
  "doc": "docs/typescript-migration.md",
  "label": "typescript",
  "tsOnlyDirs": ["src/services/"],
  "inProgress": [
    "src/services/example.service.js"
  ]
}
```

### `scripts/check-ts-migration.js`

```js
'use strict';

// Migration rules for moving a CommonJS repo to TypeScript, checked on every PR.
// Config (default .github/ts-migration.json, override with MIGRATION_CONFIG):
//   { "doc": "...", "label": "typescript", "tsOnlyDirs": ["src/services/"], "inProgress": ["src/a.js"] }
// Rules:
//  - no new .js files in a tsOnlyDirs folder
//  - a converted file has no .js copy next to its .ts
//  - files in inProgress only change in a PR that carries the migration label
// Env: BASE_REF (PR base branch, default main), PR_LABELS (comma separated).
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const configPath = process.env.MIGRATION_CONFIG || '.github/ts-migration.json';
const config = JSON.parse(fs.readFileSync(path.join(root, configPath), 'utf8'));
const tsOnlyDirs = config.tsOnlyDirs || [];
const inProgress = config.inProgress || [];
const label = config.label || 'typescript';
const doc = config.doc || configPath;
const base = 'origin/' + (process.env.BASE_REF || 'main');
const labels = (process.env.PR_LABELS || '').split(',').map((l) => l.trim()).filter(Boolean);
const hasMigrationLabel = labels.indexOf(label) > -1;

function git(args) {
  return execSync('git ' + args, { cwd: root }).toString().split('\n').filter(Boolean);
}

function changedFiles() {
  return git('diff --name-status --find-renames ' + base + '...HEAD').map((line) => {
    const parts = line.split('\t');
    const status = parts[0].charAt(0);
    return { status, file: parts[parts.length - 1], from: status === 'R' ? parts[1] : null };
  });
}

const problems = [];

changedFiles().forEach((c) => {
  const inTsOnlyDir = tsOnlyDirs.some((dir) => c.file.startsWith(dir));
  if (c.file.endsWith('.js') && inTsOnlyDir && (c.status === 'A' || c.status === 'R')) {
    problems.push(c.file + ': migration rule: new files in ' + tsOnlyDirs.join(', ') + ' are .ts, not .js.');
  }
  [c.file, c.from].filter(Boolean).forEach((file) => {
    if (inProgress.indexOf(file) > -1 && !hasMigrationLabel) {
      problems.push(file + ': migration rule: this file is queued for conversion to .ts, so it only changes in a migration PR (label "' + label + '").');
    }
  });
});

const tracked = new Set(git('ls-files'));
tracked.forEach((file) => {
  if (file.endsWith('.ts') && tracked.has(file.slice(0, -3) + '.js')) {
    problems.push(file.slice(0, -3) + '.js: migration rule: ' + file + ' is already converted, so there is no .js copy; edit the .ts file.');
  }
});

if (problems.length) {
  console.log('Migration rules not met (' + doc + '):');
  problems.forEach((p) => console.log('  - ' + p));
  console.log('If an AI coding agent made this change, it should stop here and tell the person using it to read ' + doc + '.');
  process.exit(1);
}
console.log('Migration rules met.');
```

### `scripts/check-requires.js`

Fails when a relative `require()` in a tracked `.js` or `.ts` file no longer resolves under Node's own rules, for example a caller still requiring `./x` after `x.js` became `x.ts`. Run it in the same workflow as the rules check.

```js
'use strict';

// Fails when a relative require() in any tracked .js or .ts file no longer resolves,
// e.g. a caller still requiring './x' after x.js became x.ts. Resolution uses Node's
// own rules (createRequire), so it matches what happens at boot. Commented-out code is skipped.
const { execSync } = require('child_process');
const { createRequire } = require('module');
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const files = execSync('git ls-files "*.js" "*.ts" "*.cjs"', { cwd: root }).toString().split('\n')
  .filter((f) => f && !f.startsWith('node_modules/') && !f.endsWith('.d.ts'));

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

const misses = [];
files.forEach((file) => {
  const abs = path.join(root, file);
  const src = stripComments(fs.readFileSync(abs, 'utf8'));
  const req = createRequire(abs);
  for (const m of src.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
    try { req.resolve(m[1]); } catch (e) { misses.push(file + ': require(\'' + m[1] + '\') does not resolve'); }
  }
});

if (misses.length) {
  console.log('Broken relative requires:');
  misses.forEach((m) => console.log('  - ' + m));
  process.exit(1);
}
console.log('All relative requires resolve (' + files.length + ' files).');
```

### `.github/workflows/migration-rules.yml`

```yaml
name: Migration rules

on:
  pull_request:
    types: [ opened, synchronize, reopened, labeled, unlabeled ]

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1
        with:
          fetch-depth: 0
      - name: Check relative requires resolve
        run: node scripts/check-requires.js
      - name: Check migration rules
        run: node scripts/check-ts-migration.js
        env:
          BASE_REF: ${{ github.base_ref }}
          PR_LABELS: ${{ join(github.event.pull_request.labels.*.name, ',') }}
```

### `AGENTS.md`

```markdown
# Notes for AI coding agents

## Migration rules

This codebase is being converted to TypeScript one file at a time. The plan is `docs/typescript-migration.md`, the config is `.github/ts-migration.json`, and the "Migration rules" check enforces these on every PR.

- Files listed under `inProgress` in `.github/ts-migration.json` are queued for conversion. They only change in a migration PR, so don't edit or convert them as part of other work.
- New files in the TypeScript-only folders (`tsOnlyDirs`) are `.ts`, run by Node's type stripping: erasable syntax only (types and interfaces, no enums, namespaces or parameter properties), CommonJS (`require` / `module.exports`), required with the `.ts` extension.
- A converted file has no `.js` copy. Edit the `.ts` file.
- If your task needs a queued file changed, stop and tell the person you're working for to check the migration plan, rather than working around the check.
```

## Keeping this skill current

This skill is meant to grow with real migrations. When a conversion teaches something new (a break you didn't expect, a check that saved you, a step that turned out unnecessary), add it to the matching section above in the same plain style. Keep a short dated line here:

- 2026-11: first version, from converting a service in a production Express + Mongoose API. Lessons so far: type stripping on Node 24 works for CommonJS `.ts` required with the extension; path-matching test stubs and extensionless requires are the most common silent breaks; and sealed-network container runs catch hard-coded production URLs.
