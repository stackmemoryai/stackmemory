AGENTS.md

Purpose
- A minimal, agent-friendly reference so code-generation agents (Codex, Claude Code, etc.) can work effectively in this repository.
- Explains key docs, the /designs/ folder, agent responsibilities, and quick operational notes (how to run tests, what to update, and commit expectations).

Repo doc descriptions
- prompt_plan.md
  - The agent-driven plan that sequences work into small, testable prompts and steps.
  - Contains per-step prompts, expected artifacts, tests, rollback/idempotency notes, and a TODO checklist using Markdown checkboxes.
  - This is the canonical agent workflow driver — update it as you make progress (see Agent responsibility rules below).

- spec.md
  - The minimal functional & technical specification that defines APIs, data models, and acceptance criteria.
  - Includes the concise Definition of Done that must be satisfied for each plan step before marking it complete.

- idea.md
  - Free-form brainstorming, assumptions, notes, research links, and open questions.
  - Useful for context but not authoritative — always follow spec.md and prompt_plan.md for implementation decisions.

- idea_one_pager.md
  - A short summary / one‑pager capturing Problem, Audience, Platform, Core Flow, and MVP Features (and optional Non‑Goals).
  - Good for quick alignment and to confirm that work stays within scope.

What lives in /designs/
- UI/UX artifacts and visual assets that inform implementation:
  - wireframes (PNG/SVG), Figma exports (.fig, .pdf), sequence diagrams, architecture diagrams (PNG/PDF/SVG), and annotated screenshots.
  - Naming conventions: keep filenames short, include version/date and owner, e.g., dashboard_v1_2025-11-01.png or seq_query_flow_v2.pdf.
  - Large source Figma files may live externally; include an export + a small README describing where the canonical design is stored and any viewing permissions required.

How agents should interact (summary)
- Treat prompt_plan.md as the authoritative workflow: follow the listed prompts in order and mark checklist items as you finish them.
- Always follow TDD: write tests first, make the minimal change to pass tests, then refactor while keeping tests green.
- After any code/test change, update the matching TODO checkbox in prompt_plan.md using the same Markdown checkbox format ('- [x]') and commit the change alongside code and tests.
- Make the smallest change that passes tests and improves code. Do not introduce new public APIs without updating spec.md and tests.
- Don't duplicate templates/files to work around errors — fix the original.
- Suggest a clear manual test path for every change (even when tests cover it).
- If you cannot open a file or content is missing, say so explicitly and stop. Do not guess.

Quick operational commands (expect these to exist; if not, ask)
- npm run dev — start local dev server
- npm test — run unit + integration test suite
- npm run lint — run linting
- npm run build — build TypeScript
- npm run migrate:up / migrate:down — database migrations

Commit & PR expectations
- Each prompt/plan step should result in a single, focused commit/PR with:
  - Code + tests + prompt_plan.md checklist update.
  - A short, copy-pasteable commit summary in the prompt_plan.md step completion entry.
  - Clear CHANGELOG or Release notes entry if user-facing behavior changed (or explicitly state "No user-facing changes").
- Use atomic commits. Include test run results in PR description.

Include this governance / workflow block verbatim (do not modify)
## Repository docs
- 'ONE_PAGER.md' - Captures Problem, Audience, Platform, Core Flow, MVP Features; Non-Goals optional.
- 'DEV_SPEC.md' - Minimal functional and technical specification consistent with prior docs, including a concise **Definition of Done**.
- 'PROMPT_PLAN.md' - Agent-Ready Planner with per-step prompts, expected artifacts, tests, rollback notes, idempotency notes, and a TODO checklist using Markdown checkboxes. This file drives the agent workflow.
- 'docs/STYLE.md' - Unified design system reference. Typography, layout, color tokens, component patterns. Inspired by Hatchet (structural layout, inset panels) and Outliner (clean hierarchy, whitespace). **All dashboard UI changes must follow this guide.**
- 'AGENTS.md' - This file.

### Agent responsibility
- After completing any coding, refactor, or test step, **immediately update the corresponding TODO checklist item in 'prompt_plan.md'**.
- Use the same Markdown checkbox format ('- [x]') to mark completion.
- When creating new tasks or subtasks, add them directly under the appropriate section anchor in 'prompt_plan.md'.
- Always commit changes to 'prompt_plan.md' alongside the code and tests that fulfill them.
- Do not consider work "done" until the matching checklist item is checked and all related tests are green.
- When a stage (plan step) is complete with green tests, update the README "Release notes" section with any user-facing impact (or explicitly state "No user-facing changes" if applicable).
- Even when automated coverage exists, always suggest a feasible manual test path so the human can exercise the feature end-to-end.
- After a plan step is finished, document its completion state with a short checklist. Include: step name & number, test results, 'prompt_plan.md' status, manual checks performed (mark as complete only after the human confirms they ran to their satisfaction), release notes status, and an inline commit summary string the human can copy & paste.

#### Guardrails for agents
- Make the smallest change that passes tests and improves the code.
- Do not introduce new public APIs without updating 'spec.md' and relevant tests.
- Do not duplicate templates or files to work around issues. Fix the original.
- If a file cannot be opened or content is missing, say so explicitly and stop. Do not guess.
- Respect privacy and logging policy: do not log secrets, prompts, completions, or PII.

#### Deferred-work notation
- When a task is intentionally paused, keep its checkbox unchecked and prepend '(Deferred)' to the TODO label in 'prompt_plan.md', followed by a short reason.
- Apply the same '(Deferred)' tag to every downstream checklist item that depends on the paused work.
- Remove the tag only after the work resumes; this keeps the outstanding scope visible without implying completion.



#### When the prompt plan is fully satisfied
- Once every Definition of Done task in 'prompt_plan.md' is either checked off or explicitly marked '(Deferred)', the plan is considered **complete**.
- After that point, you no longer need to update prompt-plan TODOs or reference 'prompt_plan.md', 'spec.md', 'idea_one_pager.md', or other upstream docs to justify changes.
- All other guardrails, testing requirements, and agent responsibilities in this file continue to apply unchanged.


---

## Testing policy (non-negotiable)
- Tests **MUST** cover the functionality being implemented.
- **NEVER** ignore the output of the system or the tests - logs and messages often contain **CRITICAL** information.
- **TEST OUTPUT MUST BE PRISTINE TO PASS.**
- If logs are **supposed** to contain errors, capture and test it.
- **NO EXCEPTIONS POLICY:** Under no circumstances should you mark any test type as "not applicable". Every project, regardless of size or complexity, **MUST** have unit tests, integration tests, **AND** end-to-end tests. If you believe a test type doesn't apply, you need the human to say exactly **"I AUTHORIZE YOU TO SKIP WRITING TESTS THIS TIME"**.

### TDD (how we work)
- Write tests **before** implementation.
- Only write enough code to make the failing test pass.
- Refactor continuously while keeping tests green.

**TDD cycle**
1. Write a failing test that defines a desired function or improvement.
2. Run the test to confirm it fails as expected.
3. Write minimal code to make the test pass.
4. Run the test to confirm success.
5. Refactor while keeping tests green.
6. Repeat for each new feature or bugfix.

---

## Important checks
- **NEVER** disable functionality to hide a failure. Fix root cause.
- **NEVER** create duplicate templates or files. Fix the original.
- **NEVER** claim something is "working" when any functionality is disabled or broken.
- If you can't open a file or access something requested, say so. Do not assume contents.
- **ALWAYS** identify and fix the root cause of template or compilation errors.
- If git is initialized, ensure a '.gitignore' exists and contains at least:

  .env
  .env.local
  .env.*

  Ask the human whether additional patterns should be added, and suggest any that you think are important given the project.

## When to ask for human input
Ask the human if any of the following is true:
- A test type appears "not applicable". Use the exact phrase request: **"I AUTHORIZE YOU TO SKIP WRITING TESTS THIS TIME"**.
- Required anchors conflict or are missing from upstream docs.
- You need new environment variables or secrets.
- An external dependency or major architectural change is required.
- Design files are missing, unsupported or oversized

(End of verbatim block)

Minimal examples for checklist updates (copy/pasteable)
- After completing a prompt step, add an entry under that step in prompt_plan.md similar to:
  - [x] Step 5 — Implement POST /api/v1/query — tests green — manual checks: cURL example tested — README Release Notes updated — commit: "query: add /api/v1/query route, adapter integration, tests"
- If pausing work:
  - - [ ] (Deferred) Step 7.3 — Implement real Pinecone adapter — blocked on PINECONE_API_KEY (reason: waiting for dev key from infra)

If anything is missing
- If you cannot open prompt_plan.md, spec.md, idea.md, idea_one_pager.md, or any design file, stop and report exactly which file and why (permission/absent/parse error).
- Ask for required secrets or permissions rather than guessing. Use the "When to ask for human input" rules above.

Contact & escalation
- When blocked on infra/secrets/design files, create a short note in prompt_plan.md under the current step and ping the human with:
  - What I need: (e.g., PINECONE_API_KEY, AWS dev creds)
  - Why I need it: (which step/blocker)
  - Recommended minimal next action & fallback

Notes
- Keep AGENTS.md and the rest of the repo docs in sync. Update this file if workflow expectations change.

End.
