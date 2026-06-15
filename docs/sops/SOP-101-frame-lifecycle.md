# SOP-101 Frame Lifecycle

**Owner:** Platform Team  
**Status:** Active  
**Related PROSE Expectation:** [E.1 Frame stack integrity](../specs/PROSE-platform-overview.md#e1-frame-stack-integrity)

## Objective
Ensure context frames are created, activated, and closed in a deterministic, non-circular order so that only one frame is active at a time.

## Procedure

1. **Frame creation**
   - A frame is created with a unique name, type, and optional parent frame.
   - The newly created frame becomes the active frame.

2. **Frame activation**
   - Only the most recently pushed frame may be active.
   - Previous frames remain in the stack but are inactive.

3. **Frame closure**
   - Closing a frame removes it from the top of the stack.
   - The previous frame automatically becomes active.
   - No frame may reference itself as a parent, directly or transitively.

## Verification

- Run integration test: `active frame stack remains consistent`
- Expected result: after pushing frames A → B → C and popping twice, only A remains active.

## Non-compliance

Orphaned active frames, circular parent references, or multiple simultaneous active frames are considered non-compliant and must fail validation.
