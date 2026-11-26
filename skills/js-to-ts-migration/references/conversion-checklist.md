# Converting one file

Use this for every file. One file per PR keeps review small and makes a revert trivial.

1. **Pick the file.** Prefer leaves: files that require little and are required by few. `grep -rn "require('.*/name')"` shows who depends on it.
2. **Rename** with `git mv name.js name.ts`, so history follows the file.
3. **Add types, not changes.**
   - Annotate parameters, return types and the shapes you read. Interfaces for documents and payloads are worth it; `any` is acceptable where the old code was loose.
   - Keep the logic identical: the same comparisons (`==` stays `==` if it was there), the same truthiness checks, the same mutation of objects.
   - Keep `require` / `module.exports`. Keep the order of top-level requires.
   - If the compiler forces a real change (a genuine bug), make it a separate commit with its own test, or a separate PR.
4. **Update callers.** Every `require('./name')` becomes `require('./name.ts')`. Search source, tests, scripts, seeders and anything that loads modules by path.
5. **Update test stubs.** Search `tests/` for the old filename in `Module._load` hooks, proxyquire paths, `jest.mock` calls, or regexes like `name(\.js)?$`. A stub that stops matching doesn't fail; it quietly loads the real module.
6. **Verify.**
   - `npm run typecheck`: clean.
   - Unit tests: the same passing count as before.
   - Production image: `docker run --rm -e <dummy env> <image> node -e "require('./path/name.ts')"` loads with no warnings.
   - For hot paths, one end-to-end run in throwaway containers (see SKILL.md step 6).
7. **Bookkeeping.** Remove the file from `inProgress` in the migration config, and label the PR with the migration label.
8. **PR description.** One line up top saying it's a TypeScript conversion with no behaviour change, then what you verified.
