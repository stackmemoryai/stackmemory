---
initialPrompt: true
description: Add test coverage for existing code
---
You are adding tests for {{ISSUE_ID}}: {{TITLE}}

## Description
{{DESCRIPTION}}

Labels: {{LABELS}}
Priority: {{PRIORITY}}

{{PRIOR_CONTEXT}}

## Task
1. **Read**: Understand the module under test — read the source file completely.
2. **Identify**: List all public functions, branches, and edge cases.
3. **Write tests**: Cover happy path, error cases, and edge cases.
4. **Verify**: Run `npx jest {test_file} --no-coverage` and ensure all pass.
5. Commit: `test({{SCOPE}}): add coverage for {{TITLE}} ({{ISSUE_ID}})`

## Rules
- Use the project's existing test patterns (Jest + SWC, mock via DI).
- Use global `jest` — do NOT import from `@jest/globals`.
- `jest.clearAllMocks()` resets mocks — re-set in `beforeEach`.
- ESLint: use `catch {}` not `catch (_err) {}`.
- Tests should assert behavior, not just that functions exist.
