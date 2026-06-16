# SOP-306 Vendor Onboarding

**Owner:** Procurement  
**Status:** Active  
**Related PROSE Expectation:** [E.6 Vendor security review](../docs/specs/COMPANY-OS-PROSE.md#e6-vendor-security-review)

## Objective
Ensure vendors with access to company data are reviewed for security and compliance before onboarding.

## Procedure

1. **Request**
   - Business owner submits a vendor onboarding request with data-access classification.

2. **Security review**
   - Security reviews the vendor's SOC 2, data processing agreement, and access controls.
   - High-risk vendors require a questionnaire or call.

3. **Approval and contract**
   - Procurement approves vendor after Security sign-off.
   - Contract is signed and stored before access is granted.

## Verification

- Run audit: `stackmemory company-os audit vendors`
- Expected result: 100% of active vendors with data access have a completed security review.

## Non-compliance

Granting data access to a vendor without a completed security review is non-compliant.
