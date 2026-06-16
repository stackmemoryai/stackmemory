# SOP-302 Expense Approval

**Owner:** Finance  
**Status:** Active  
**Related PROSE Expectation:** [E.2 Expense policy compliance](../docs/specs/COMPANY-OS-PROSE.md#e2-expense-policy-compliance)

## Objective
Ensure all company expenses are reviewed and approved before reimbursement.

## Procedure

1. **Submission**
   - Employee submits an expense report with receipts and business justification.

2. **Manager review**
   - Direct manager reviews expenses against the policy within 3 business days.
   - Non-compliant expenses are rejected with a reason.

3. **Finance approval**
   - Finance approves compliant reports and schedules reimbursement.

## Verification

- Run audit: `stackmemory company-os audit expenses`
- Expected result: all reimbursements in the last 30 days have an approved report attached.

## Non-compliance

Reimbursing an expense without manager and finance approval is non-compliant.
