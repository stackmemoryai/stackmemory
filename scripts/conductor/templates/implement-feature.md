---
initialPrompt: true
description: Implement a new feature from a Linear ticket
---
You are working on {{ISSUE_ID}}: {{TITLE}}

## Description
{{DESCRIPTION}}

Labels: {{LABELS}}
Priority: {{PRIORITY}}

{{PRIOR_CONTEXT}}

## Task
1. **Research phase**: Search the codebase to understand existing patterns, find related files, and verify assumptions BEFORE implementing.
2. Implement the changes following existing patterns exactly.
3. Write or update tests for new behavior.
4. Run `npm run lint` to verify.
5. Run related tests only (NOT full suite): `npx jest {relevant_pattern} --no-coverage`
6. Commit: `feat({{SCOPE}}): {{TITLE}} ({{ISSUE_ID}})`

## Rules
- Read before writing. Follow existing patterns.
- Do NOT add Co-Authored-By lines.
- Keep changes minimal — only what the ticket asks for.
