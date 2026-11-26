# agent-skills

Skills for AI coding agents (Claude Code and others that read `SKILL.md`). Each skill lives in `skills/<name>/`, with a `SKILL.md` and any references, scripts and templates it uses.

| Skill | What it does |
|---|---|
| [js-to-ts-migration](skills/js-to-ts-migration/SKILL.md) | Moves a CommonJS Node/Express repo to TypeScript one file at a time with Node's type stripping (no build step), CI type checking and a migration-rules PR check. |

To use one with Claude Code, copy or symlink its folder into `~/.claude/skills/` (personal) or `.claude/skills/` (per project).
