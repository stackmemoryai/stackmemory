# SOP-201 CLI Exit-Code Compliance

**Owner:** CLI Team  
**Status:** Active  
**Related PROSE Expectation:** [E.4 CLI contract](../specs/PROSE-platform-overview.md#e4-cli-contract)

## Objective
Provide deterministic exit codes so that scripts, CI pipelines, and automation tools can rely on CLI outcomes.

## Procedure

1. **Success**
   - Return exit code `0` when a command completes its intended function.

2. **Failure**
   - Return a non-zero exit code when a command cannot complete its intended function.
   - Include a human-readable error message on stderr or stdout.

3. **Documentation**
   - Document exit-code behavior for commands used in automation.

## Verification

- Run integration test: `CLI commands return correct exit codes`
- Expected result: successful commands exit `0`; invalid commands exit non-zero.

## Non-compliance

Returning `0` on failure or a non-zero code on success is non-compliant.
