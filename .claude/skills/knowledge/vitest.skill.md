---
name: vitest
version: 2025.12.1
domain: testing
expires: 2026-12-01
activates_on: [vitest, test, spec, mock, spy, describe, it, expect, vi, beforeEach, coverage]
sources:
  - https://vitest.dev/api/
  - https://vitest.dev/guide/mocking
context7: vitest-dev/vitest
---

# Vitest

## Config (this project)
- Projects: unit, integration, live (API), bench
- Coverage: v8 provider, thresholds: 25% statements, 20% branches, 30% functions
- ESM native — no transform needed (unlike Jest + SWC)

## API (differs from Jest)
- Mock function: `vi.fn()` (not `jest.fn()`)
- Mock module: `vi.mock('./module')` — hoisted like Jest
- Spy: `vi.spyOn(obj, 'method')`
- Timers: `vi.useFakeTimers()` / `vi.advanceTimersByTime(ms)`
- Clear: `vi.clearAllMocks()` / `vi.resetAllMocks()` / `vi.restoreAllMocks()`
- Snapshot: `expect(val).toMatchSnapshot()` — same as Jest

## Mock Patterns
```ts
vi.mock('./dep.js', () => ({
  myFn: vi.fn().mockReturnValue('mocked'),
}));

// Reset per test
beforeEach(() => {
  vi.clearAllMocks();
  // re-set implementations after clear
});
```

## Inline vs Config Mocks
- `vi.mock()` in test file — hoisted, file-scoped
- `__mocks__/` directory — auto-mock (same as Jest convention)
- `vi.hoisted()` — declare variables used in `vi.mock()` factory

## Key Differences from Jest
- `vi` namespace instead of `jest` global
- Native ESM — no `.js` extension issues in tests
- `vi.stubEnv('KEY', 'val')` for env vars (cleaner than `process.env` mutation)
- `--reporter=verbose` for detailed output
- `vitest bench` for benchmarks (built-in, not separate tool)

## Gotchas
- `vi.mock()` factory can't reference outer variables unless via `vi.hoisted()`
- `vi.clearAllMocks()` resets calls + implementations (same gotcha as Jest)
- `--pool=forks` vs `--pool=threads` — forks for better isolation, threads for speed
- SQLite tests: use `:memory:` or temp file, not shared DB (parallel execution)
