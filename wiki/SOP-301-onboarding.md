# SOP-301 New Hire Onboarding

**Owner:** People Ops  
**Status:** Active  
**Related PROSE Expectation:** [E.1 Onboarding completeness](../docs/specs/COMPANY-OS-PROSE.md#e1-onboarding-completeness)

## Objective
Ensure every new hire has accounts, hardware, and access documented before their start date.

## Procedure

1. **Pre-start checklist (5 days before)**
   - Hiring manager opens an onboarding ticket in the task system.
   - People Ops confirms laptop requirement and shipping address.

2. **Account provisioning (3 days before)**
   - IT creates SSO account and adds the hire to the default groups.
   - People Ops sends a welcome email with first-week schedule.

3. **Access verification (1 day before)**
   - Hiring manager verifies the hire can log in to the primary systems.
   - A record of the verification is stored in the company OS.

## Verification

- Run audit: `stackmemory company-os audit onboarding`
- Expected result: 100% of hires in the last 30 days have completed all checklist items.

## Non-compliance

Any onboarding missing SSO access or hardware assignment on the hire's start date is non-compliant.
