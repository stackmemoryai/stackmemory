---
initialPrompt: true
description: Fix a bug from a Linear ticket
---
You are fixing {{ISSUE_ID}}: {{TITLE}}

## Description
{{DESCRIPTION}}

Labels: {{LABELS}}
Priority: {{PRIORITY}}

{{PRIOR_CONTEXT}}

## Task
1. **Reproduce**: Understand the bug from the description. Search for the failing code path.
2. **Root cause**: Identify the exact cause — don't just patch symptoms.
3. **Fix**: Apply the minimal fix.
4. **Test**: Write a regression test that would have caught this bug.
5. Run `npm run lint` and related tests.
6. Commit: `fix({{SCOPE}}): {{TITLE}} ({{ISSUE_ID}})`

## Rules
- Read before writing. Trace the bug through the call chain.
- Do NOT refactor surrounding code — fix only.
- If the bug is in a test, fix the test, not the code.
