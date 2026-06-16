# Company OS PROSE Overview

> PROSE = **P**urpose, **R**ules & Constraints, **O**bservables, **S**cenarios, **E**xpectations
>
> Expectations are grounded in **SOPs** stored in the Company OS wiki.

This document describes StackMemory's Company OS behavior in plain English. Each section is intentionally testable and maps directly to integration tests in `src/__tests__/integration/company-os.test.ts`.

The contract layer of PROSE is derived from SOPs: every Expectation below corresponds to a procedural guarantee that QA can validate and that can be turned into executable scripts.

---

## P — Purpose

Company OS is a lightweight operating system for a small team. It turns recurring company processes into documented, auditable, and testable procedures so the team can delegate, onboard, and scale without losing context.

### P.1 Process discoverability
Any team member can find the current version of any company process in the `wiki/` directory.

### P.2 Cross-session continuity
Decisions and audit records written during one session must be retrievable in subsequent sessions.

---

## R — Rules & Constraints

### R.1 SOP schema
Every SOP in the Company OS wiki must contain Objective, Procedure, Verification, and Non-compliance sections.

### R.2 PROSE reference
Every SOP must reference a valid PROSE Expectation ID.

### R.3 Idempotent audits
Running an audit command must not mutate process state.

---

## O — Observables

### O.1 SOP list
`stackmemory company-os list` must list all SOPs in `wiki/` with their IDs and statuses.

### O.2 Audit status
`stackmemory company-os audit <process>` must report the compliance status for the process.

### O.3 Decision retrieval
Decisions recorded against a company process must be retrievable by process name.

---

## S — Scenarios

### S.1 SOP creation
Adding a SOP to `wiki/` makes it discoverable and subject to validation.

### S.2 Audit run
Running an audit evaluates the process against its SOP and records the result.

### S.3 Decision record
Recording a decision against a process persists it with rationale and timestamp.

---

## E — Expectations

### E.1 Onboarding completeness
Every new hire has documented accounts, hardware, and access before their start date.

**SOP basis:** `SOP-301 New Hire Onboarding` — onboarding must be complete before day one.

### E.2 Expense policy compliance
All reimbursed expenses have manager and finance approval.

**SOP basis:** `SOP-302 Expense Approval` — reimbursement requires documented approval.

### E.3 Offboarding access removal
Departing employees lose access to company systems within 24 hours of termination.

**SOP basis:** `SOP-303 Access Revocation` — access must be revoked within the SLA window.

### E.4 Security incident response SLA
Security incidents are contained within the severity-based SLA.

**SOP basis:** `SOP-304 Security Incident Response` — Severity 1 incidents within 2 hours, Severity 2 within 24 hours.

### E.5 PTO request approval workflow
All paid time off is requested, approved, and recorded before it begins.

**SOP basis:** `SOP-305 PTO Request` — reimbursement requires documented approval.

### E.6 Vendor security review
Vendors with data access complete a security review before onboarding.

**SOP basis:** `SOP-306 Vendor Onboarding` — no data access without Security sign-off.

### E.7 Data retention enforcement
Data is retained, archived, or deleted according to policy.

**SOP basis:** `SOP-307 Data Retention` — no data kept past retention without exception.

### E.8 Emergency contact completeness
Every active employee has a current emergency contact on file.

**SOP basis:** `SOP-308 Emergency Contact Update` — contacts verified annually.

### E.9 Decision-derived process documentation
Recurring decisions captured in frames are reflected in derived SOPs so the team does not re-debate them.

**SOP basis:** `SOP-401 Decision-derived Process` — derived from DECISION anchors in the wiki compiler.

### E.10 Constraint-derived process documentation
Recurring constraints captured in frames are reflected in derived SOPs so the team respects known boundaries.

**SOP basis:** `SOP-402 Constraint-derived Process` — derived from CONSTRAINT anchors in the wiki compiler.

### E.11 Risk-derived process documentation
Recurring risks captured in frames are reflected in derived SOPs so the team mitigates them consistently.

**SOP basis:** `SOP-403 Risk-derived Process` — derived from RISK anchors in the wiki compiler.

### E.12 Fact-derived process documentation
Recurring facts captured in frames are reflected in derived SOPs so the team operates from shared knowledge.

**SOP basis:** `SOP-404 Fact-derived Process` — derived from FACT anchors in the wiki compiler.

---

## SOP → PROSE → Tests workflow

```
SOP (company process)
   │
   ▼
PROSE Expectation (plain-English contract)
   │
   ▼
Integration test (executable validation)
   │
   ▼
Provenant decision log (audit trail)
```

For example, `SOP-301 New Hire Onboarding` becomes PROSE `E.1`, which becomes the test `onboarding records are complete`. QA can run the same test suite to verify SOP compliance, and the test can be used to generate or validate automation scripts.

---

## Test mapping

| PROSE ID | SOP basis | Test case |
|----------|-----------|-----------|
| P.1 | — | `lists SOPs in the company OS wiki` |
| P.2 | — | `retrieves company-os decisions across sessions` |
| R.1 | — | `rejects SOPs missing required sections` |
| R.2 | — | `rejects SOPs with invalid PROSE references` |
| R.3 | — | `audit commands do not mutate state` |
| O.1 | — | `lists SOPs with IDs and statuses` |
| O.2 | — | `reports audit status for a process` |
| O.3 | — | `retrieves decisions by process name` |
| S.1 | — | `adding a SOP makes it discoverable` |
| S.2 | — | `running an audit records the result` |
| S.3 | — | `recording a decision persists rationale` |
| E.1 | `SOP-301 New Hire Onboarding` | `onboarding records are complete` |
| E.2 | `SOP-302 Expense Approval` | `expenses have required approvals` |
| E.3 | `SOP-303 Access Revocation` | `access is revoked within SLA` |
| E.4 | `SOP-304 Security Incident Response` | `incidents are contained within SLA` |
| E.5 | `SOP-305 PTO Request` | `PTO is approved before it begins` |
| E.6 | `SOP-306 Vendor Onboarding` | `vendors have security review` |
| E.7 | `SOP-307 Data Retention` | `data retention is enforced` |
| E.8 | `SOP-308 Emergency Contact Update` | `emergency contacts are current` |
| E.9 | `SOP-401 Decision-derived Process` | `decision-derived SOP is generated` |
| E.10 | `SOP-402 Constraint-derived Process` | `constraint-derived SOP is generated` |
| E.11 | `SOP-403 Risk-derived Process` | `risk-derived SOP is generated` |
| E.12 | `SOP-404 Fact-derived Process` | `fact-derived SOP is generated` |
