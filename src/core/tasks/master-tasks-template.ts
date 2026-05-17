/**
 * Default template for master-tasks.md scaffold.
 */

export const MASTER_TASKS_TEMPLATE = `# Master Tasks

> Single source of truth for what to build. Local-first, optionally syncs to Linear/GitHub.
> Powers \\\`/next\\\` task selection. Referenced by CLAUDE.md and AGENTS.md.

## Rules

1. **Local-first**: This file is canonical. Linear/GH are downstream mirrors, not sources.
2. **One owner**: Every task has exactly one owner. \\\`@me\\\` = you, \\\`@agent\\\` = dispatch to sub-agent, \\\`@defer\\\` = not assigned.
3. **Priority tiers**: \\\`P0\\\` now (blocking), \\\`P1\\\` this week, \\\`P2\\\` next sprint, \\\`P3\\\` someday.
4. **Status flow**: \\\`todo\\\` → \\\`active\\\` → \\\`done\\\` | \\\`blocked\\\` | \\\`cut\\\`.
5. **Sync targets**: \\\`local\\\` (stays here), \\\`linear\\\` (create/update Linear issue), \\\`gh\\\` (GitHub issue/PR).
6. **Agent /next reads P0 first, then P1**: Skip blocked, done, cut. Prefer @agent tasks unless @me explicitly set.
7. **Keep it scannable**: One line per task in the table. Details go in notes column or linked doc.
8. **Update on completion**: Mark done with date. Don't delete — move to Done section monthly.

## Active Tasks

| id | P | status | owner | sync | task | branch/PR | notes |
|----|---|--------|-------|------|------|-----------|-------|

## Done (archive monthly)

_Move completed tasks here at end of month._

<!-- Template row:
| Txx | Px | todo | @me/@agent/@defer | local/linear/gh | description | branch/PR | notes |
-->
`;

export const TASKS_CONFIG_TEMPLATE = {
  linear: { team: '', project: '' },
  github: { repo: '' },
  defaultSync: 'local',
  defaultOwner: '@me',
};
