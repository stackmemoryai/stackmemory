# SOP-308 Emergency Contact Update

**Owner:** People Ops  
**Status:** Active  
**Related PROSE Expectation:** [E.8 Emergency contact completeness](../docs/specs/COMPANY-OS-PROSE.md#e8-emergency-contact-completeness)

## Objective
Maintain up-to-date emergency contacts for every employee.

## Procedure

1. **Collection**
   - New hires provide an emergency contact during onboarding.

2. **Annual verification**
   - People Ops prompts all employees annually to verify or update their emergency contact.

3. **Update**
   - Employees update their contact in the HR system within 2 weeks of the prompt.

## Verification

- Run audit: `stackmemory company-os audit emergency-contacts`
- Expected result: 100% of active employees have a non-expired emergency contact on file.

## Non-compliance

Any active employee without a current emergency contact is non-compliant.
