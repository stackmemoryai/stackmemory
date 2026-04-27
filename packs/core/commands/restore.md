# /restore — Restore session context via StackMemory

Run `stackmemory restore` to load context from the last handoff and resume where you left off.

## Usage

`$ARGUMENTS` — optional flags passed directly to `stackmemory restore`.

## Behavior

1. Run `stackmemory restore $ARGUMENTS`
2. Read the restored handoff prompt
3. Use the restored context to understand current state: branch, in-progress work, blockers, next steps
4. Run `stackmemory status` to confirm project state
5. Summarize what was restored and suggest next actions

## Common flags

| Flag | Effect |
|------|--------|
| `--no-copy` | Don't copy prompt to clipboard |
| `--force` | Restore even if branch doesn't match |

## Examples

```
/restore              # Restore last handoff
/restore --force      # Restore even on different branch
```
