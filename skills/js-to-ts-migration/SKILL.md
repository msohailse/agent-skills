---
name: js-to-ts-migration
description: Incrementally convert a CommonJS Node.js codebase (Express, Mongoose and similar) from JavaScript to TypeScript one file at a time, with no build step, using Node 22.18+/24's built-in type stripping. Covers setting up tsc type checking in CI, converting a single file safely, keeping the .js and .ts mix working, and a PR check that enforces the migration rules. Use this whenever someone wants to move a Node/Express backend to TypeScript, write a new file in TypeScript inside a JavaScript repo, convert "just this one service" to .ts, plan a TS migration, or asks whether converting a running API to TypeScript is safe, even if they don't say "migration". Also use it to audit or review a TypeScript migration that someone or an AI agent already did, such as hand-written library types, unchecked typed requires, `!`/`as` added to silence the compiler, or "strict mode passes, so is it fine?".
category: development
risk: safe
source: https://github.com/msohailse/agent-skills
source_repo: msohailse/agent-skills
source_type: community
date_added: '2026-11-26'
license: MIT
license_source: https://github.com/msohailse/agent-skills/blob/main/LICENSE
compatibility: Node.js 22.18+ or 23.6+ (Node 24 recommended) for built-in type stripping; CommonJS codebases.
metadata:
  author: Muhammad Sohail
  version: '1.3.1'
---

# JS to TS migration (Node type stripping, no build)

A one-shot conversion of a live JavaScript API almost always breaks a caller somewhere. The conversion itself changes nothing; the breakage comes from what people "fix" while satisfying the compiler, and from build and load-order changes. This skill gets a repo to TypeScript in small, revertable PRs, several open at once where they don't depend on each other, with production behaviour unchanged at every step.

The approach: new and converted files are `.ts`, and Node runs them directly by stripping the types. The repo stays CommonJS. `tsc --noEmit` type-checks the `.js` and `.ts` mix in CI. A PR check enforces the rules so parallel work doesn't collide with the migration.

## 1. Check the runtime first

Type stripping needs Node 22.18+ or 23.6+ (on by default; Node 24 is the comfortable target). Confirm the version that production actually runs, not just the local one: read the Dockerfile `FROM`, the `engines` field and the deploy config, and run `node -v` inside the production image if you can.

Then prove it in that runtime before converting anything: a `.ts` file using `require`/`module.exports` and a type annotation, required from a `.js` file with the explicit `.ts` extension. If that prints no warnings and works, you need no build step. If production is older Node, either upgrade Node first (as its own change) or use the `dist/` fallback in [What breaks, and how to check](#what-breaks-and-how-to-check).

## 2. The house rules for a .ts file

These come from what Node's type stripper accepts and what keeps the mix working:

- **Erasable syntax only.** Types, interfaces, `type` aliases, `import type` and `satisfies` are fine. Enums, namespaces, parameter properties and `import x = require()` are not, because they need code generated. Use a const object plus a union type in place of an enum.
- **Stay CommonJS.** Use `require` and `module.exports`, never `import x from` or `export const`. If Node sees ESM syntax in a `.ts` file it loads the file as an ES module, and `module.exports` then throws. `verbatimModuleSyntax` in the tsconfig makes tsc reject that syntax before it ships. ESM would also change load order, which matters: dotenv and APM agents usually have to load first.
- **Require with the extension.** `require('./thing.service.ts')`. An extensionless require does not find a `.ts` file.
- **A hand-written type for an official package is always wrong.** If a package ships types or has an `@types` package, import those. Don't describe it yourself, in any form: not an interface on a `require`, not an `as` cast, not `declare module 'pkg' { ... }`. This holds even when the official types fail to compile; that is what [Library types](#library-types-one-library-at-a-time) is for.
- **Types come from the real code, never from a hand-written copy.** `require()` returns `any` in a `.ts` file, so a type written on the left of it is never checked against anything: the compiler just believes it. First try importing the real TypeScript interfaces the library or module already provides, and always derive from them:
  - From a package: types with `import type { Request, Response } from 'express'`, and a required value with `const mongoose: typeof import('mongoose') = require('mongoose')`. Node erases both annotations.
  - From a sibling module: the module exports its own shape (`export type Service = typeof service`), and the caller writes `import type { Service } from './service.ts'` plus `const service: Service = require('./service.ts')`.

  Never write `const x: SomeInterface = require(...)` with an interface you wrote to describe that library or module. It compiles, it looks typed, and nothing ever compares it with the real thing, so it is wrong the moment it doesn't match and stays wrong as the real code changes. It's worse than `any`: `any` tells the next reader nothing is checked, and a hand-written type tells them something is. Just dropping the annotation isn't a fix either: that leaves `any`.
- **Don't silence the compiler.** Don't add `!` non-null assertions or `as` casts to make an error go away (`as const` is fine). If the compiler found a real problem, the bug was already there: keep what it does at runtime and fix the bug in its own tested PR. To get it compiling, narrow first if that behaves identically (for a missing row that already ended in a caught 500, `if (!row) throw ...` keeps the 500 and keeps the types) and add a test that shows it. Use `any` only when narrowing would change behaviour. The PR check flags new `!` and `as`. A justified one carries a `// ts-migration: <reason>` comment on the same line.
- **`strict` only, during the migration.** Extra flags such as `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` on loosely typed code produce hundreds of `!`, `?.` and `?? ''` edits. Those either hide the warnings the flags exist for, or change what callers receive. Turn them on in phase 6, one at a time, once the types are real.
- **No behaviour changes in a conversion PR.** Keep loose comparisons, truthiness checks and `any` where the old code relied on them. Tighten in a separate, tested PR.

#### Examples

Typing a library:

```ts
// Wrong: a hand-written copy of the library. Compiles, never checked against Mongoose.
interface MyMongoose {
  Types: { ObjectId(value: string): string };   // really returns an object
  model(name: string): { findByName(n: string): Promise<unknown> };   // no such method
}
const mongoose: MyMongoose = require('mongoose');

// Right: the library's own types, derived. Node erases the annotation.
const mongoose: typeof import('mongoose') = require('mongoose');
```

With the wrong version, strict `tsc` exits 0, and at runtime `ObjectId()` returns an object and `findByName` doesn't exist. With the right one, both mistakes are compile errors.

Typing a model, and the shared CRUD factory built on it:

```ts
// user.model.ts
const mongoose: typeof import('mongoose') = require('mongoose');
interface User { email?: string; isActive?: boolean }          // describes the document only
const User = mongoose.model<User & import('mongoose').Document>('User', new mongoose.Schema<User>({ email: String, isActive: Boolean }));
module.exports = User;
export type UserModel = typeof User;

// crud.ts: generic over the real model type, no hand-written find/lean/populate
import type { Model } from 'mongoose';
function crud<T>(Model: Model<T>) { /* same body as before */ }
```

Typing a sibling module:

```ts
// cache.service.ts
const service = { get, set, del };
module.exports = service;
export type CacheService = typeof service;      // the module describes itself

// caller.ts
// Wrong: each caller invents its own idea of the module.
const cache: { get<T>(k: string): Promise<T | null> } = require('./cache.service.ts');
// Right: derived from the module, so it changes when the module changes.
import type { CacheService } from './cache.service.ts';
const cache: CacheService = require('./cache.service.ts');
```

Silencing the compiler:

```ts
// The compiler says persons[1] may be undefined.
payload.persons![1]!.phones!.push(phone);       // Wrong: same crash as before, now hidden
payload.persons[1].phones.push(phone);          // Right in a conversion PR: unchanged, payload typed loosely (any)
// Then, in its own PR with a test: guard the second person, since the bug was always there.
```

Use the tsconfig in [Files to add](#files-to-add) and adjust its `include` list to the repo's folders. It enforces these rules (`erasableSyntaxOnly`, `allowImportingTsExtensions`, `noEmit`, `allowJs` with `checkJs: false`).

### Library types, one library at a time

Every library the converted code touches gets its types from the best real source available. The first move is always to import its own interfaces (`import type { Model, Document, Types } from 'mongoose'`) and compile. `skipLibCheck` is not a first step. Decide per library, in this order:

1. **The package ships its own types** (a `types` field in its `package.json`, or an `index.d.ts`). Use them.
2. **Otherwise, the official `@types/<name>` package,** pinned to the version that matches the library's major.
3. **If those types fail to compile,** the errors point at files inside `node_modules`. Fix the versions first: a newer library major that ships working types, an `@types` version that matches the library, or the TypeScript major the types were written for. To find which library is failing, compile a probe file that imports just that library's types, with `skipLibCheck` off.
4. **Only then, turn on `skipLibCheck`.** It stops tsc from checking every `.d.ts` file, your own included, but your code is still checked against those types. Record which library forced it in `.github/ts-migration.json` (`skipLibCheckBecause`), so someone can turn it off later. Run `tsc --skipLibCheck false` now and then to see what it hides. Keep your own types in `.ts` files, never `.d.ts`, so they're still checked.
5. **No types exist at all:** leave the value honestly untyped (`any`), or put the library behind one small wrapper module whose functions you type and test. Never write an interface that describes the library's API.

#### Fix as much as you can before `skipLibCheck`

Don't turn it on at the first complaint.

1. Count the errors with `npx tsc -p tsconfig.json --skipLibCheck false` and write the number down.
2. Fix every error in your own code, or leave that value honestly untyped. `skipLibCheck` never hides errors in `.ts` files, so it is no help with them.
3. Take the library errors one library at a time until you reach the end of the list: its own interfaces, `@types`, matching versions, and a package-manager `overrides` entry for a types package pulled in by another package. Don't stop at the first library that can't be fixed.
4. Partial success counts. If 18 of 30 go away and 12 have no clean fix, keep the 18 fixes and turn on `skipLibCheck` for the rest.
5. `skipLibCheck` is all or nothing, so write down what it now hides: `"skipLibCheckBecause": ["30 errors, 18 fixed, 12 left in <library>: <why>"]`. In later PRs, run with it off again. The number should not go up.

A fix only counts if the types still describe the library you actually run:
- **Fewer errors can mean fewer types.** Count again, then check where the module resolves (`npx tsc --traceResolution`). If it now resolves to a `.js` file, or to types for another major, you removed the types and everything from that library is `any`. Revert it.
- **A runtime version change is not a type fix.** Upgrading or downgrading the library itself goes in its own tested PR.

Old ORM versions are the usual trigger. Mongoose 5's bundled types, for example, fail under current TypeScript with errors that are all inside `node_modules`. Upgrading the ORM (phase 3) fixes it properly. `skipLibCheck` is the fallback, and hand-writing the ORM's types is never the answer.

Example, working through the steps for one library:

```ts
// probe.ts: only this library's types
const mongoose: typeof import('mongoose') = require('mongoose');
export {};
```

```json
// tsconfig.probe.json: compile with `npx tsc -p tsconfig.probe.json`
{ "extends": "./tsconfig.json", "compilerOptions": { "skipLibCheck": false }, "include": [], "files": ["probe.ts"] }
```

(TypeScript 6 refuses `tsc probe.ts` when a tsconfig is present, so use a probe config.)

```text
node_modules/@types/mongodb/index.d.ts(1010,45): error TS2344: Type 'TSchema' does not satisfy the constraint ...
node_modules/mongoose/index.d.ts(332,116):     error TS2344: Type 'T' does not satisfy the constraint ...
```

Every error is inside `node_modules`, so the library's types are failing, not your code. Step 1 (its own types) is what's failing. Step 2 doesn't apply, because Mongoose ships its own. Step 3, measured on Mongoose 5.13.23 with TypeScript 6.0.3, starting from 23 errors (16 in `@types/mongodb`, 7 in `mongoose`):

| Tried | Errors | Counts as a fix? |
|---|---|---|
| `overrides` to `@types/mongodb` 3.5.34 | 23 | No change |
| `overrides` to `@types/mongodb` 3.1.0 | 36 | Worse |
| `overrides` to `@types/mongodb` 4.0.7 | 3 | No: it is an empty stub, so `mongodb` resolved to untyped JavaScript |
| Mongoose 5.11.20 | 19 | No: a runtime change for 4 errors |

So here nothing counts, and the honest record is 23 errors, 0 fixed. These are one setup's results, not yours: run your own count and trials before you record anything. Is a newer major an option now? If not, step 4:

```json
// .github/ts-migration.json
"skipLibCheckBecause": ["mongoose@5.13: 23 errors, 0 fixed, 23 left (16 in @types/mongodb, 7 in mongoose/index.d.ts). No clean version fix. Remove after the Mongoose upgrade."]
```

Then set `"skipLibCheck": true` in the tsconfig, and keep using `typeof import('mongoose')` everywhere. Your code is still checked against Mongoose's real types; only the library's internal errors are skipped.

## 3. Phases

Each phase ships in its own PRs, and every PR can be reverted on its own.

### Several PRs at once

- **One PR is one safe, complete change:** usually one module with its exported type, the updated `require` paths, its test stubs and a test that pins its behaviour. If one interface goes in cleanly, stop there. Add a second file only when the two can't be separated safely. There is no target count.
- **Every PR is finished on its own:** typecheck, tests, the runtime diff (`strip.js` in [Auditing a migration](#auditing-a-migration-thats-already-done)), the migration check, and a short description of what you verified.
- **Every PR branches from the base branch and targets it.** Never stack one on another. If a module needs the exported type of a module whose PR is still open, it waits for that merge.
- **The setup PR merges first** (tsconfig, check scripts, config). It also settles the libraries: probe every typed library the app requires, run the [library steps](#library-types-one-library-at-a-time) to the end, and include any `skipLibCheck` record. Nothing later should be waiting on a library error.
- **Don't stop at a library error to ask.** An upgrade that would fix it is a recommendation in the PR description, not a blocker. Finish the steps, turn on `skipLibCheck` for what is left, and carry on.
- **PRs open at the same time must merge cleanly in any order.** Before starting, list the files each planned PR will change, callers and tests included.
- **Modules required by the same file go in one PR.** Their `require` lines sit together, so separate PRs would conflict, and queueing them one by one wastes a review round each. Together they are one safe unit. Other overlapping PRs run one after the other. Confirm with a trial merge of the planned branches.
- **Open every PR that is ready now.** After the list, say what each pending module is waiting for, so the next batch can start as soon as that merges.
- **Leave the `inProgress` list alone in parallel PRs.** Removing neighbouring lines in two branches conflicts. An entry for a file that is already converted does no harm, so clear them together in a later PR.
- **Ask before publishing.** Show the person the list of planned PRs and get one yes before pushing or opening them. Never merge them yourself.

0. **Type checking only.** Add `typescript`, `@types/node` (matching the production Node major) and the framework's `@types/*` as dev dependencies, the tsconfig, an `npm run typecheck` script (`tsc -p tsconfig.json`), and a typecheck step in the existing CI test job. Nothing in runtime changes.
   - Pin exact versions, and skip anything published in the last few days. Choose the TypeScript major on purpose: a new major can change how JS files are checked, so move to it in its own PR later.
   - Keep the compiler out of the production image. If the Dockerfile runs a plain `npm install`, typescript ships with it as dead weight; install with `npm ci --omit=dev` there.
   - Read the lockfile diff. A newer `@types/node` can move a hoisted copy that other packages' types depend on, which is harmless but worth saying in the PR.
   - Run the first typecheck with `skipLibCheck` off. Handle any errors inside `node_modules` library by library ([Library types](#library-types-one-library-at-a-time)), never by hand-writing types to get past them.
   - Optionally turn on `// @ts-check` for a couple of tiny JS files. Under `strict`, a bare `@ts-check` fails on untyped `req`/`res`/`next` parameters, so add JSDoc types (comments only) rather than code changes.
1. **Guardrails.** Add the migration-rules PR check from step 5, the queued-files list and the agent guidance. Also add the require-resolution check (both are in [Files to add](#files-to-add)). With `checkJs` off, tsc won't report a `.js` file that still requires a renamed module, and a missed rename crashes the app at boot. Don't count on a deploy healthcheck to catch that. If the repo uses nodemon, set its `ext` to `js,ts,json` so dev restarts on `.ts` changes.
2. **Leaf modules,** one safe unit per PR. Start with files that require no other app modules, then work inward: services, helpers, utilities. Write any new file as `.ts` from day one. Beyond typecheck and tests, deploy each one to staging and hit `/health` plus a few read-only endpoints of the module you changed.
3. **Upgrade the ORM on its own,** if its version has weak typings or open security advisories (for example Mongoose 5 to a supported major) and the person wants it now. Doing it before typing models avoids typing things twice, but it doesn't block the migration: if it isn't happening yet, type the models with `skipLibCheck` and note the upgrade as follow-up work. Keep this PR in plain JS with no type work mixed in. Watch for removed callback APIs (code and tests that still pass a callback to `findOneAndUpdate`), changed `strictQuery` defaults, and changed return values from `lean()` and `findOneAndUpdate`. Verify on staging with read-only traffic, and remember that staging and production sometimes share a database cluster.
4. **Models.** One interface per schema, passed to the ORM's own generics (`new Schema<T>()`, `model<T>()`), so every query is checked against the real ORM types. The interface describes the document, never the ORM's methods. It is still a second description of the same fields: on Mongoose 5 `new Schema<T>()` does not compare the schema with `T` (swapped, missing and extra fields all compile), so review the two side by side and change them in the same PR. Schemas with `strict: false` hold open-ended documents, so type them loosely: known fields plus an index signature. Don't change schema options or indexes in these PRs.
5. **Routes, then small controllers, then the big ones last.** A shared CRUD factory becomes a generic over the ORM's model type (`Model<T>`), not a hand-written interface of the methods it calls. Split the largest controllers before converting them. Before converting a controller or changing a shared API, map its callers and write down what they depend on (see [Response shape drift](#response-shape-drift)), then add a test that pins it.
6. **Tighten.** Turn on the extra strict flags one at a time, turn `checkJs` on folder by folder for whatever JS is left, add request validation at the HTTP boundary (zod or similar), and leave the entry files (`app.js`, the APM and env bootstrap, `bin/www`) as plain JS.

### Working in rounds

A migration takes several rounds, because a module can only be converted after what it requires has merged. Don't rely on memory between sessions: the repo says where you are. The setup PR lists every `.js` file to be converted in `inProgress`.

Every time you are started, or told to continue, do one round:

1. Pull the base branch.
2. Look at the open migration PRs. Fix their failed checks and review comments before starting anything new.
3. Run `node scripts/migration-status.js`. It prints what is ready, what is waiting and on which files, and which ready files belong in one PR.
4. Open PRs for everything ready that doesn't already have one. If the script's "One PR" groups share files, don't chain them into one large PR: open the smallest safe group now, and the others in a later round.
5. Report the PRs, what each waiting file needs merged, and that the next step is theirs: merge, then say "continue". Stop there.

The migration is finished only when the script prints `Nothing left to convert`, typecheck and tests pass, and you have run the [audit](#auditing-a-migration-thats-already-done) and reported its three counts in the last PR. The script's message is a prompt to audit, not the finish line. Until then, don't call it done. In the last PR, clear `inProgress`.

## 4. Converting a file, in short

Follow [Converting one file](#converting-one-file) for every file. The short version:

1. `git mv x.js x.ts`, then add types without changing logic.
2. Update every `require('./x')` to `require('./x.ts')`. Grep the source, the tests and any scripts.
3. Grep `tests/` for stubs keyed on the old path (`Module._load`, proxyquire, `jest.mock`, regexes like `x(\.js)?$`). They silently stop matching after a rename.
4. Run typecheck and the unit tests, then load the file in the production image (`node -e "require('./path/x.ts')"` with dummy env) to prove it resolves there.
5. Remove the file from the queued list in the same PR, unless other conversion PRs are open (see [Several PRs at once](#several-prs-at-once)).

## 5. Migration rules PR check

`scripts/check-ts-migration.js` (in [Files to add](#files-to-add)) reads a small config, `.github/ts-migration.json`, and fails a PR that:

- adds a new `.js` file in a folder that's now TypeScript-only;
- leaves a `.js` copy next to a converted `.ts` file;
- edits a file queued for conversion, unless the PR has the migration label;
- types a `require()` by hand in a `.ts` file (`const x: Foo = require('./foo.ts')` where `Foo` is neither `typeof …` nor imported with `import type` from that same module);
- adds `!` non-null assertions or `as` casts (other than `as const` and `require('x') as typeof import('x')`) in `.ts` lines, unless the line carries a `// ts-migration: <reason>` comment;
- adds a `declare module 'pkg' { ... }` block for a package, which replaces or rewrites its official types (a real augmentation, such as adding a field to Express's `Request`, carries the `// ts-migration:` comment);
- turns on `skipLibCheck` without naming, in the config's `skipLibCheckBecause`, the library that forced it.

The last four exist because an agent under pressure to make the compiler happy reaches for exactly those shortcuts. Each one compiles, and each one hides the check it was meant to pass. A prose rule can be argued with; a failing check can't.

Install it with the GitHub Actions workflow in [Files to add](#files-to-add). The messages state the rule, not a person. They also tell an AI coding agent to stop and point its user to the plan instead of working around the check. Add the short agent guidance as `AGENTS.md`, and the same few lines in `CLAUDE.md` if the repo has one. For a hard gate, the repo admin can pair this with branch protection.

Test the check locally before opening the PR: a new `.js` file in a TypeScript-only folder, a `.js` restored next to a `.ts`, a queued-file edit with and without the label, and an unrelated change. Run it with `BASE_REF=main PR_LABELS=typescript node scripts/check-ts-migration.js`.

## 6. Before calling a step done

- `npm run typecheck` is clean and the unit-test count is unchanged.
- The migration-rules check is green: no hand-typed requires, no new `!` or `as`, and no unexplained `skipLibCheck`.
- The changed files load in the production image.
- For a file on a hot path, run the real flow once in throwaway containers on an internal-only Docker network (no internet). Use an empty database, and point the env at mock servers rather than real services. That way a hard-coded production URL fails closed instead of reaching production. Never mount the real `.env`.

Read [What breaks, and how to check](#what-breaks-and-how-to-check) before phase 2. It lists what actually breaks in these migrations (load order, env read at module load, cache value shapes, test stubs, static asset paths, response shape drift) and how to check each one.

## Converting one file

Use this for every file. A small PR (see [Several PRs at once](#several-prs-at-once)) keeps review small and makes a revert trivial.

1. **Pick the file.** Prefer leaves: files that require little and are required by few. `grep -rn "require('.*/name')"` shows who depends on it.
2. **Rename** with `git mv name.js name.ts`, so history follows the file.
3. **Add types, not changes.**
   - Annotate parameters, return types and the shapes you read. Interfaces for documents and payloads are worth it; `any` is acceptable where the old code was loose.
   - Keep the logic identical: the same comparisons (`==` stays `==` if it was there), the same truthiness checks, the same mutation of objects.
   - Keep `require` / `module.exports`. Keep the order of top-level requires.
   - Derive the type of everything you require: `typeof import('pkg')` for a package, or the sibling's exported `typeof` type. Never write an interface that describes a library or another module.
   - Don't add `!` or `as` to get past an error. Narrow before reaching for `any`, when the behaviour stays identical. If the compiler forces a real change (a genuine bug), make it a separate commit with its own test, or a separate PR.
   - If this is the first file of its kind (the first model, the first controller), review it twice as hard. Every later conversion will copy whatever it does, shortcuts included.
4. **Update callers.** Every `require('./name')` becomes `require('./name.ts')`. Search source, tests, scripts, seeders and anything that loads modules by path.
5. **Update test stubs.** Search `tests/` for the old filename in `Module._load` hooks, proxyquire paths, `jest.mock` calls, or regexes like `name(\.js)?$`. A stub that stops matching doesn't fail; it quietly loads the real module. Keep test files `.js` if the test runner's glob only picks up `*.js`. For a module that writes to a cache or queue, add a test that pins the key names and encoding before converting it.
6. **Verify.**
   - `npm run typecheck`: clean.
   - Unit tests: the same passing count as before.
   - Production image: `docker run --rm -e <dummy env> <image> node -e "require('./path/name.ts')"` loads with no warnings.
   - For hot paths, one end-to-end run in throwaway containers (see SKILL.md step 6).
7. **Bookkeeping.** Label the PR with the migration label. Remove the file from `inProgress` in the migration config, unless other conversion PRs are open.
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
Old ORM versions have weak or broken types (Mongoose 5, for example). Typing models on them, then upgrading, is double work, and these versions often have security advisories anyway. Upgrade first if you can, as its own tested PR. If you can't upgrade yet, follow [Library types](#library-types-one-library-at-a-time): `skipLibCheck` with the reason recorded, and the ORM's real types underneath.

### Hand-written boundary types
This is the most expensive mistake in an agent-run migration, and nothing in CI catches it on its own. The pattern:
1. One library's type files fail to compile.
2. Instead of fixing versions or turning on `skipLibCheck`, the converted file describes the library by hand: `const mongoose: MyMongoose = require('mongoose')`.
3. Now every model needs a hand-written interface too, the shared CRUD factory needs its own copy, and the two don't match, so casts appear.
4. Next, callers of already-converted modules describe them by hand as well. Each module's types reach no other file.
5. Strict-only flags on top produce hundreds of `!` that silence the warnings they exist for.

Strict mode passes the whole time, and the runtime code barely changes, so behaviour reviews pass too. The cost is that the types protect nothing at any boundary between files.
*Check:* the migration-rules check rejects the pattern in new PRs. For a branch that's already done, see [Auditing a migration](#auditing-a-migration-thats-already-done).

### Monitoring
Type stripping replaces types with whitespace, so line and column numbers stay the same. Stack traces in APM, error trackers and chat alerts point at the real source with no source maps. With a `dist/` build you need source maps.

### Node version and base images
Type stripping needs Node 22.18+ or 23.6+, and every image that might run the app has to qualify. A private-registry base image tagged like the public one can lag behind it, so check `node -v` inside each image before it's deployed. Files under `node_modules` are never stripped, so dependencies still have to ship JavaScript.

### Fallback: a dist/ build
Only use this if type stripping blocks something: old Node in production, or a dependency or feature that needs enums or decorators.
- Compile with `tsc` (`allowJs`, CommonJS output) to `dist/`.
- Here the way to get real types is `import mongoose = require('mongoose')` (and `export =`). Type stripping rejects that syntax, but a build compiles it. The rest of the type rules still apply, including `skipLibCheck` only after the library steps. A plain `require` with no annotation is still `any`.
- Copy the static assets and any JSON read by path next to the output.
- Keep dotenv and APM in a plain JS entry that loads first.
- Turn source maps on for APM.
- Keep the path-matching tests running against the source, not `dist/`.
- Update the Dockerfile and start command, and prove the build with zero `.ts` files first.

It changes how the app deploys, which is why it isn't the default. "Node's type stripping doesn't type-check" is not a reason to build: type checking is `tsc --noEmit` in CI either way.

## Auditing a migration that's already done

Green CI doesn't tell you a migration is right. It tells you the compiler is satisfied. Use this section when you inherit a converted codebase, review a branch an agent produced, or someone asks "is this migration actually OK?". Each check is mechanical. Run all three before giving an answer.

**1. Did runtime behaviour change?** Strip the types from each converted file and diff the JavaScript against the original. Pass both sides through the same printer so formatting doesn't count:

```js
// strip.js: node strip.js <in> <out>. Uses Node's built-in stripper (22.13+, experimental).
const { stripTypeScriptTypes } = require('node:module');
const fs = require('fs');
const [, , input, output] = process.argv;
fs.writeFileSync(output, stripTypeScriptTypes(fs.readFileSync(input, 'utf8'), { mode: 'transform' }));
```

Copy the old `.js` to a `.ts` name and run it through `strip.js`. Do the same for the new `.ts`. Then run `git diff --no-index -w --ignore-blank-lines old.js new.js`. Swaps between `var`, `let` and `const` are noise. Whatever else is left is the real runtime change. `transform` mode also accepts `import x = require()` and `export =`, so this works on code written for a `dist/` build too. For a build, also look at tsc's emitted module format (default imports, `esModuleInterop`).

**2. Do hand-written types match the real thing?** For each interface that describes a library or another module, assign the real value to it in a scratch file and compile:

```ts
import type { HandWrittenMongoose } from './db.types.ts';   // hand-written types under audit
import type { CacheLike } from './cache.types.ts';
import type { CacheService } from './cache.service.ts';     // derived: typeof the real export
const realMongoose: typeof import('mongoose') = require('mongoose');
declare const realCache: CacheService;

export const a: HandWrittenMongoose = realMongoose;  // an error here = the hand-written type is wrong
export const b: CacheLike = realCache;
```

Each compile error is a type that promises something the real code doesn't do. A classic is a cache typed `get<T>(key): Promise<T | null>` when the real one returns `Promise<unknown>`: every caller can then claim any shape for whatever is in the cache. Don't call a mismatch a bug until you've checked what runtime really does. Sometimes the hand-written type is right and the library's own types are incomplete.

**3. How much is unchecked?** Count the shortcuts:
- hand-typed requires: `grep -rnE "(const|let|var) \w+: [^=]+= require\(" --include=*.ts . | grep -v ": typeof"`;
- `!` assertions and `as` casts;
- lines in `*.types.ts` files that describe libraries or modules rather than data.

High counts with a clean runtime diff mean the migration is safe to run, but it bought little type safety.

Then read the first conversion of each kind and question its shortcuts. Later files copy the first one, so a shortcut in file one becomes the pattern for the rest.

Review the types, not just the behaviour. A review that confirms responses, cache keys and status codes are unchanged is necessary. It says nothing about whether the types are real. Do both, and say which one you did.

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
    "forceConsistentCasingInFileNames": true
  },
  "include": ["*.js", "*.ts", "src/**/*.js", "src/**/*.ts", "tests/**/*.js", "tests/**/*.ts"],
  "exclude": ["node_modules", "dist", "public", "coverage"]
}
```

`skipLibCheck` is left out on purpose. Add it only through the steps in [Library types](#library-types-one-library-at-a-time), with the reason recorded in the config.

### `.github/ts-migration.json`

`tsOnlyDirs` lists the folders where new files must be `.ts`. `inProgress` lists the files queued for conversion. Remove a file from it in the PR that converts it, and add folders to `tsOnlyDirs` as each phase starts. `skipLibCheckBecause` stays empty until a library forces `skipLibCheck` on; then it names the library and why.

```json
{
  "doc": "docs/typescript-migration.md",
  "label": "typescript",
  "tsOnlyDirs": ["src/services/"],
  "inProgress": [
    "src/services/example.service.js"
  ],
  "skipLibCheckBecause": []
}
```

### `scripts/check-ts-migration.js`

```js
'use strict';

// Migration rules for moving a CommonJS repo to TypeScript, checked on every PR.
// Config (default .github/ts-migration.json, override with MIGRATION_CONFIG):
//   { "doc": "...", "label": "typescript", "tsOnlyDirs": ["src/services/"], "inProgress": ["src/a.js"],
//     "skipLibCheckBecause": [] }
// Rules:
//  - no new .js files in a tsOnlyDirs folder
//  - a converted file has no .js copy next to its .ts
//  - files in inProgress only change in a PR that carries the migration label
//  - a require() in a changed .ts file is never typed by hand: the type is `typeof ...`
//    or comes from `import type` of that same module
//  - no new `!` non-null assertions or `as` casts (except `as const`) in .ts lines the PR adds,
//    unless the line has a `// ts-migration: <reason>` comment. `require('x') as typeof import('x')`
//    is allowed: the type comes from the same module that is required
//  - no `declare module 'pkg' {` for a package, in .ts or .d.ts, without the same comment
//  - skipLibCheck is only on when skipLibCheckBecause names the library that forced it
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

const ALLOW = /\/\/\s*ts-migration:/;
const isTs = (f) => f.endsWith('.ts') && !f.endsWith('.d.ts');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Code only: string contents and trailing comments removed, so they can't trigger a rule.
const codeOf = (text) => text.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""').replace(/\/\/.*$/, '');

// Hand-typed requires, anywhere in a .ts file the PR touches.
const TYPED_REQUIRE = /^\s*(?:const|let|var)\s+([\w$]+)\s*:\s*([^=]+?)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/;
changedFiles().filter((c) => c.status !== 'D' && isTs(c.file) && fs.existsSync(path.join(root, c.file))).forEach((c) => {
  const src = fs.readFileSync(path.join(root, c.file), 'utf8');
  src.split('\n').forEach((text, i) => {
    const m = text.match(TYPED_REQUIRE);
    if (!m || ALLOW.test(text)) return;
    const type = m[2].trim();
    const spec = m[3];
    if (/^typeof\s/.test(type)) return;
    if (/^(any|unknown)$/.test(type)) return; // honestly unchecked: no claim is made about the module
    const ident = (type.match(/^[A-Za-z_$][\w$]*/) || [''])[0];
    const importedFromSameModule = ident && new RegExp(
      'import\\s+type\\s*\\{[^}]*\\b' + escapeRe(ident) + '\\b[^}]*\\}\\s*from\\s*[\'"]' + escapeRe(spec) + '[\'"]'
    ).test(src);
    if (importedFromSameModule) return;
    const fix = spec.startsWith('.')
      ? 'have ' + spec + ' export `type X = typeof <its export>`, then `import type { X } from \'' + spec + '\'`'
      : 'use `typeof import(\'' + spec + '\')`';
    problems.push(c.file + ':' + (i + 1) + ': migration rule: `' + m[1] + '` is typed by hand as `' + type +
      '`. require() returns any, so that type is never checked against ' + spec + '. Derive it: ' + fix + '.');
  });
});

// New `!` and `as` in the .ts lines this PR adds.
const NON_NULL = /[\w\])]!(?=[.[)\],;:\s]|$)/;
const AS_CAST = /\bas\s+(?!const\b)[\w{[(]/;
// require('x') as typeof import('x'): the same module on both sides, so nothing is hand-written.
const DERIVED_REQUIRE = /require\(\s*(['"])([^'"]+)\1\s*\)\s+as\s+typeof\s+import\(\s*(['"])\2\3\s*\)/g;
let file = null;
let lineNo = 0;
git('diff -U0 ' + base + '...HEAD -- "*.ts"').forEach((l) => {
  if (l.startsWith('+++ ')) { file = l.slice(4).replace(/^b\//, ''); return; }
  const hunk = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  if (hunk) { lineNo = Number(hunk[1]); return; }
  if (!l.startsWith('+') || !file || !file.endsWith('.ts')) return;
  const text = l.slice(1);
  const at = file + ':' + lineNo;
  lineNo += 1;
  if (ALLOW.test(text)) return;
  const declared = text.match(/^\s*declare\s+module\s+['"]([^.'"][^'"]*)['"]\s*\{/);
  if (declared) {
    problems.push(at + ': migration rule: hand-written types for the package ' + declared[1] +
      '. Import its official types. If this only adds to them, add `// ts-migration: <reason>`.');
  }
  if (!isTs(file)) return;
  if (/^\s*(\/\*|\*)/.test(text)) return; // comment text, e.g. "same as before"
  if (/^\s*(type\s+)?[\w$]+\s+as\s+[\w$]+\s*,?\s*$/.test(text)) return; // `a as b,` inside a multi-line import
  const code = codeOf(text.replace(DERIVED_REQUIRE, 'require()'));
  if (/^\s*(import|export)\s/.test(code)) return; // `import { a as b }` renames, not casts
  if (NON_NULL.test(code)) {
    problems.push(at + ': migration rule: a new `!` non-null assertion hides what the compiler found. Keep the old behaviour without it, or add `// ts-migration: <reason>`.');
  }
  if (AS_CAST.test(code)) {
    problems.push(at + ': migration rule: a new `as` cast tells the compiler to stop checking. Derive the real type instead, or add `// ts-migration: <reason>`.');
  }
});

// skipLibCheck only with a recorded reason.
const tsconfigPath = path.join(root, 'tsconfig.json');
const tsconfigText = fs.existsSync(tsconfigPath)
  ? fs.readFileSync(tsconfigPath, 'utf8').replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '') // tsconfig allows comments
  : '';
if (/"skipLibCheck"\s*:\s*true/.test(tsconfigText)) {
  const reasons = config.skipLibCheckBecause || [];
  if (!reasons.length) {
    problems.push('tsconfig.json: migration rule: skipLibCheck is on, but skipLibCheckBecause in ' + configPath +
      ' names no library. Try the library\'s own types, then @types, then matching versions; record the library that still fails.');
  }
}

if (problems.length) {
  console.log('Migration rules not met (' + doc + '):');
  problems.forEach((p) => console.log('  - ' + p));
  console.log('If an AI coding agent made this change, it should stop here and tell the person using it to read ' + doc + '.');
  process.exit(1);
}
console.log('Migration rules met.');
```

### `scripts/migration-status.js`

Says where the migration stands, from the files themselves. A queued file is done once its `.js` no longer exists, or once it has been removed from the list. It is ready when none of its relative requires points at a queued `.js` file.

```js
'use strict';

// Where the migration stands. Reads inProgress from .github/ts-migration.json (override with
// MIGRATION_CONFIG). Done = the queued .js no longer exists. Ready = requires no queued .js file.
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const root = process.cwd();
const config = JSON.parse(fs.readFileSync(path.join(root, process.env.MIGRATION_CONFIG || '.github/ts-migration.json'), 'utf8'));
const queued = config.inProgress || [];
const left = queued.filter((f) => fs.existsSync(path.join(root, f)));

function deps(file) {
  const abs = path.join(root, file);
  const src = fs.readFileSync(abs, 'utf8').replace(/^\s*\/\/.*$/gm, '');
  const req = createRequire(abs);
  const found = [];
  for (const m of src.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
    try { found.push(path.relative(fs.realpathSync(root), req.resolve(m[1])).split(path.sep).join('/')); } catch (e) { /* check-requires reports it */ }
  }
  return found;
}

console.log('Left to convert: ' + left.length);
if (!left.length) {
  console.log('Nothing left to convert. This is not "done": run the audit now (hand-typed requires, ! and as, and how many errors skipLibCheck hides) and report all three counts.');
  process.exit(0);
}
const waiting = new Map(left.map((f) => [f, deps(f).filter((d) => left.indexOf(d) > -1)]));
const ready = left.filter((f) => !waiting.get(f).length);
console.log('Ready now:');
ready.forEach((f) => console.log('  - ' + f));
left.filter((f) => ready.indexOf(f) === -1).forEach((f) => console.log('Waiting: ' + f + ' (needs ' + waiting.get(f).join(', ') + ')'));
// Ready files required by the same file go in one PR: their require lines sit together.
left.forEach((f) => {
  const together = waiting.get(f).filter((d) => ready.indexOf(d) > -1);
  if (together.length > 1) console.log('One PR: ' + together.join(', ') + ' (all required by ' + f + ')');
});
if (!ready.length) console.log('Nothing is ready: the files left require each other. Convert that cycle in one PR.');
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
  // Strings and escapes are matched first and kept, so '/*' or '//' inside them isn't read as a comment.
  const token = /(\\.|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/.*$/gm;
  return src.replace(token, (match, keep) => keep || '');
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
- Import the library's or module's own TypeScript interfaces first (`import type { Model, Types } from 'mongoose'`). Types for a package or another module are derived: `typeof import('pkg')`, or `import type` of the type the module exports as `typeof` itself. Never write an interface that describes a library's or another module's API, and never write `const x: SomeInterface = require(...)`.
- A hand-written type for an official package is always wrong, including `declare module 'pkg' { ... }`. Import the package's own types or its `@types`.
- Don't add `!` or `as` to make a type error go away. Narrow if that behaves identically, otherwise `any`. If the compiler found a real problem, say so and leave the fix for its own PR.
- One safe change per PR, branched from the base branch, never stacked. Ask before pushing or opening PRs, and never merge them.
- If a library's own type files fail to compile, don't work around it in code. Follow the library-types order in the plan: the package's own types, then `@types`, then matching versions. Work through every library before turning on `skipLibCheck`, record how many errors you fixed and how many are left, and never count a change that just removes a library's types.
- Keep `strict` as it is. Don't add stricter compiler flags during the migration.
- To continue the migration, do one round: update open migration PRs, run `node scripts/migration-status.js`, open PRs for what is ready, report, and stop. It isn't done until that script prints `Nothing left to convert`.
- If your task needs a queued file changed, stop and tell the person you're working for to check the migration plan, rather than working around the check.
```

## Keeping this skill current

This skill is meant to grow with real migrations. When a conversion teaches something new (a break you didn't expect, a check that saved you, a step that turned out unnecessary), add it to the matching section above in the same plain style. Keep a short dated line here:

- 2026-11: first version, from converting a service in a production Express + Mongoose API. Lessons so far: type stripping on Node 24 works for CommonJS `.ts` required with the extension; path-matching test stubs and extensionless requires are the most common silent breaks; and sealed-network container runs catch hard-coded production URLs.
- 2026-11: lessons from auditing an agent-run migration of a similar API.
  - What happened: one library type error (old ORM types under a newer TypeScript) led to hand-written library and module types behind `const x: T = require()`, which the compiler never checks. Of 8 tested against the real APIs, 5 didn't match. Strict-only flags were silenced with `!`. Reviews confirmed behaviour was unchanged, which was true, but never checked the types.
  - Added here: derive every type; the library-types order, with `skipLibCheck` last; no silencing; extra strict flags only at the end; the audit section; PR-check rules for all of it.
- 2026-11: PRs can run in parallel off the base branch when they touch different files. Exhaust library fixes before `skipLibCheck`, and beware of fixes that lower the error count by removing types. Narrow before using `any`.
- 2026-11: the migration runs in rounds, with `scripts/migration-status.js` saying what is ready next, and callers are mapped before a shared API changes.
