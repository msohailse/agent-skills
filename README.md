# agent-skills

Skills for AI coding agents (Claude Code and others that read `SKILL.md`). Each skill is a single `SKILL.md` in `skills/<name>/`, with any scripts or config it needs inlined.

| Skill | What it does |
|---|---|
| [js-to-ts-migration](skills/js-to-ts-migration/SKILL.md) | Moves a CommonJS Node/Express repo to TypeScript one file at a time with Node's type stripping (no build step), CI type checking and a migration-rules PR check. |

To use one with Claude Code, copy its folder into `~/.claude/skills/` (personal) or `.claude/skills/` (per project).
