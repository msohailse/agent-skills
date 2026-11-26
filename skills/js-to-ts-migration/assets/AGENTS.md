# Notes for AI coding agents

## Migration rules

This codebase is being converted to TypeScript one file at a time. The plan is `docs/typescript-migration.md`, the config is `.github/ts-migration.json`, and the "Migration rules" check enforces these on every PR.

- Files listed under `inProgress` in `.github/ts-migration.json` are queued for conversion. They only change in a migration PR, so don't edit or convert them as part of other work.
- New files in the TypeScript-only folders (`tsOnlyDirs`) are `.ts`, run by Node's type stripping: erasable syntax only (types and interfaces, no enums, namespaces or parameter properties), CommonJS (`require` / `module.exports`), required with the `.ts` extension.
- A converted file has no `.js` copy. Edit the `.ts` file.
- If your task needs a queued file changed, stop and tell the person you're working for to check the migration plan, rather than working around the check.
