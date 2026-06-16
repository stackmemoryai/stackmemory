# SOP-305 PTO Request

**Owner:** People Ops  
**Status:** Active  
**Related PROSE Expectation:** [E.5 PTO request approval workflow](../docs/specs/COMPANY-OS-PROSE.md#e5-pto-request-approval-workflow)

## Objective
Ensure paid time-off requests are tracked, approved, and communicated before time off begins.

## Procedure

1. **Submission**
   - Employee submits a PTO request at least 3 business days before the requested time off.
   - Request includes start date, end date, and coverage plan.

2. **Manager approval**
   - Direct manager approves or declines the request within 2 business days.
   - Manager confirms coverage plan is adequate.

3. **Calendar update**
   - Upon approval, the employee adds the time off to the shared team calendar.

## Verification

- Run audit: `stackmemory company-os audit pto`
- Expected result: 100% of PTO taken in the last 30 days has an approved request on record.

## Non-compliance

Unrecorded or unapproved time off is non-compliant.
