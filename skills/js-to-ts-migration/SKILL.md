---
name: js-to-ts-migration
description: Incrementally convert a CommonJS Node.js codebase (Express, Mongoose and similar) from JavaScript to TypeScript one file at a time, with no build step, using Node 22.18+/24's built-in type stripping. Covers setting up tsc type checking in CI, converting a single file safely, keeping the .js and .ts mix working, and a PR check that enforces the migration rules. Use this whenever someone wants to move a Node/Express backend to TypeScript, write a new file in TypeScript inside a JavaScript repo, convert "just this one service" to .ts, plan a TS migration, or asks whether converting a running API to TypeScript is safe, even if they don't say "migration".
---

# JS to TS migration (Node type stripping, no build)

A one-shot conversion of a live JavaScript API almost always breaks a caller somewhere. The conversion itself changes nothing; the breakage comes from what people "fix" while satisfying the compiler, and from build and load-order changes. This skill gets a repo to TypeScript one small, revertable PR at a time, with production behaviour unchanged at every step.

The approach: new and converted files are `.ts`, and Node runs them directly by stripping the types. The repo stays CommonJS. `tsc --noEmit` type-checks the `.js` and `.ts` mix in CI. A PR check enforces the rules so parallel work doesn't collide with the migration.

## 1. Check the runtime first

Type stripping needs Node 22.18+ or 23.6+ (on by default; Node 24 is the comfortable target). Confirm the version that production actually runs, not just the local one: read the Dockerfile `FROM`, the `engines` field and the deploy config, and run `node -v` inside the production image if you can.

Then prove it in that runtime before converting anything: a `.ts` file using `require`/`module.exports` and a type annotation, required from a `.js` file with the explicit `.ts` extension. If that prints no warnings and works, you need no build step. If production is older Node, either upgrade Node first (as its own change) or use the `dist/` fallback in `references/break-risks.md`.

## 2. The house rules for a .ts file

These come from what Node's type stripper accepts and what keeps the mix working:

- **Erasable syntax only.** Types, interfaces, `type` aliases, `import type`, `satisfies` and `as` casts are fine. Enums, namespaces, parameter properties and `import x = require()` are not, because they need code generated. Use a const object plus a union type in place of an enum.
- **Stay CommonJS.** Use `require` and `module.exports`. Switching to ESM `import`/`export` changes load order, and that matters (dotenv and APM agents usually have to load first).
- **Require with the extension.** `require('./thing.service.ts')`. An extensionless require does not find a `.ts` file.
- **Typing a sibling module.** `require()` returns `any` in a `.ts` file. When you want a dependency typed, the dependency exports its shape (`export type Service = typeof service`), and the caller writes `import type { Service } from './service.ts'` plus `const service: Service = require('./service.ts')`.
- **No behaviour changes in a conversion PR.** Keep loose comparisons, truthiness checks and `any` where the old code relied on them. Tighten in a separate, tested PR.

Copy `assets/tsconfig.json` and adjust its `include` list to the repo's folders. It enforces these rules (`erasableSyntaxOnly`, `allowImportingTsExtensions`, `noEmit`, `allowJs` with `checkJs: false`).

## 3. Phases

Each phase is its own PR, can ship on its own and can be reverted on its own.

0. **Type checking only.** Add pinned `typescript`, `@types/node` and the framework's `@types/*` as dev dependencies, the tsconfig, an `npm run typecheck` script (`tsc -p tsconfig.json`), and a typecheck step in the existing CI test job. Nothing in runtime changes.
1. **Migration rules.** Add the PR check from step 5, the queued-files list, and agent guidance (`assets/AGENTS.md`).
2. **Leaf modules,** one file per PR: services, helpers and utilities that few files depend on. Write any new file as `.ts` from day one.
3. **Upgrade the ORM separately** before typing models if its version has weak typings or open security advisories (for example Mongoose 5 to 6+). Otherwise you type everything twice.
4. **Models.**
5. **Routes, then small controllers, then the big ones last.** Add tests for a controller's main paths before converting it.
6. **Tighten:** request validation at the HTTP boundary (zod or similar), stricter options, `checkJs` on.

## 4. Converting one file

Follow `references/conversion-checklist.md` for every file. The short version:

1. `git mv x.js x.ts`, then add types without changing logic.
2. Update every `require('./x')` to `require('./x.ts')`. Grep the source, the tests and any scripts.
3. Grep `tests/` for stubs keyed on the old path (`Module._load`, proxyquire, `jest.mock`, regexes like `x(\.js)?$`). They silently stop matching after a rename.
4. Run typecheck and the unit tests, then load the file in the production image (`node -e "require('./path/x.ts')"` with dummy env) to prove it resolves there.
5. Remove the file from the queued list in the same PR.

## 5. Migration rules PR check

`scripts/check-ts-migration.js` reads a small config (`assets/ts-migration.json`) and fails a PR that:

- adds a new `.js` file in a folder that's now TypeScript-only;
- leaves a `.js` copy next to a converted `.ts` file;
- edits a file queued for conversion, unless the PR has the migration label.

Install it with `assets/migration-rules.yml` as a GitHub Actions workflow. The messages state the rule, not a person. They also tell an AI coding agent to stop and point its user to the plan instead of working around the check. Add short guidance for agents as well (`assets/AGENTS.md`, and the same few lines in `CLAUDE.md` if the repo has one). For a hard gate, the repo admin can pair this with branch protection.

Test the check locally before opening the PR: a new `.js` file in a TypeScript-only folder, a `.js` restored next to a `.ts`, a queued-file edit with and without the label, and an unrelated change. Run it with `BASE_REF=main PR_LABELS=typescript node scripts/check-ts-migration.js`.

## 6. Before calling a step done

- `npm run typecheck` is clean and the unit-test count is unchanged.
- The changed files load in the production image.
- For a file on a hot path, run the real flow once in throwaway containers on an internal-only Docker network (no internet). Use an empty database, and point the env at mock servers rather than real services. That way a hard-coded production URL fails closed instead of reaching production. Never mount the real `.env`.

Read `references/break-risks.md` before phase 2. It lists what actually breaks in these migrations (load order, env read at module load, cache value shapes, test stubs, static asset paths, response shape drift) and how to check each one.
