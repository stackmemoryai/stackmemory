# SOP-304 Security Incident Response

**Owner:** Security  
**Status:** Active  
**Related PROSE Expectation:** [E.4 Security incident response SLA](../docs/specs/COMPANY-OS-PROSE.md#e4-security-incident-response-sla)

## Objective
Respond to and contain security incidents within a defined SLA.

## Procedure

1. **Detection and reporting**
   - Any employee who suspects an incident reports it to Security within 1 hour.
   - Security opens an incident ticket and assigns a severity level.

2. **Containment (Severity 1: 2 hours; Severity 2: 24 hours)**
   - Security isolates affected accounts or systems.
   - Relevant stakeholders are notified via the incident channel.

3. **Resolution and review**
   - Security resolves the incident and documents root cause.
   - A post-incident review is scheduled within 5 business days.

## Verification

- Run audit: `stackmemory company-os audit incidents`
- Expected result: 100% of Severity 1 and 2 incidents in the last 90 days were contained within SLA.

## Non-compliance

Any Severity 1 incident not contained within 2 hours, or Severity 2 incident not contained within 24 hours, is non-compliant.
