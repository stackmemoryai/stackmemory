# /capture — Save session context via StackMemory

Run `stackmemory capture` to commit current work and generate a handoff prompt for the next session.

## Usage

`$ARGUMENTS` — optional flags passed directly to `stackmemory capture`.

## Behavior

1. Run `stackmemory capture $ARGUMENTS`
2. Display the generated handoff prompt
3. If `--copy` flag is present, confirm the prompt was copied to clipboard

## Common flags

| Flag | Effect |
|------|--------|
| `-m "message"` | Custom commit message |
| `--no-commit` | Skip git commit, just generate handoff |
| `--copy` | Copy handoff prompt to clipboard |
| `--format ultra` | Ultra-compact pipe-delimited format |
| `--format verbose` | Full markdown format |

## Examples

```
/capture                          # Default capture with auto-format
/capture -m "privacy policy PR"   # With custom message
/capture --copy                   # Capture and copy to clipboard
/capture --no-commit --copy       # Just generate handoff, no commit
```
