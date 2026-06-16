# SOP-303 Access Revocation

**Owner:** Security  
**Status:** Active  
**Related PROSE Expectation:** [E.3 Offboarding access removal](../docs/specs/COMPANY-OS-PROSE.md#e3-offboarding-access-removal)

## Objective
Remove access for departing employees within 24 hours of termination.

## Procedure

1. **Termination notification**
   - People Ops notifies Security and IT of the termination date.

2. **Access removal**
   - IT disables SSO, VPN, and cloud accounts within 24 hours.
   - Security confirms no active sessions remain.

3. **Audit record**
   - A timestamped revocation record is stored in the company OS.

## Verification

- Run audit: `stackmemory company-os audit offboarding`
- Expected result: 100% of departures in the last 30 days have a revocation record within 24 hours.

## Non-compliance

Active access persisting more than 24 hours after termination is non-compliant.
