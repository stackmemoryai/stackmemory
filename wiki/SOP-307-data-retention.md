# SOP-307 Data Retention

**Owner:** Legal / Engineering  
**Status:** Active  
**Related PROSE Expectation:** [E.7 Data retention enforcement](../docs/specs/COMPANY-OS-PROSE.md#e7-data-retention-enforcement)

## Objective
Retain, archive, or delete data according to legal and policy requirements.

## Procedure

1. **Classification**
   - Data is classified by retention tier: operational, archive, or delete-after-period.

2. **Scheduled review**
   - Engineering runs a quarterly retention report.
   - Legal reviews exceptions and litigation holds.

3. **Action**
   - Data past retention period is deleted or archived based on classification.
   - Deletion is logged with timestamp and reason.

## Verification

- Run audit: `stackmemory company-os audit retention`
- Expected result: no data older than its retention period remains in active storage without an approved exception.

## Non-compliance

Keeping data in active storage beyond its retention period without an exception is non-compliant.
