# coding/typescript-react

## TypeScript Conventions

- **Strict mode always.** `"strict": true` in tsconfig.json. No `any` unless genuinely unavoidable — use `unknown` and narrow.
- **ESM imports.** Always add `.js` extension to relative imports in ESM projects. Use `type` imports for type-only references.
- **Prefer interfaces** for object shapes. Use `type` for unions, intersections, and mapped types.
- **No enums.** Use `as const` objects or union types instead. Enums have runtime cost and poor tree-shaking.
- **Error handling.** Return `undefined` over throwing. If you must throw, use typed error classes. Never `catch (e: any)`.
- **Naming.** PascalCase for types/interfaces/components. camelCase for variables/functions. UPPER_SNAKE for constants.

## React Patterns

- **Functional components only.** No class components.
- **Custom hooks for data fetching.** Extract `useQuery`/`useMutation` patterns into `use*` hooks. Never fetch in component body.
- **State management.** useState for local, useReducer for complex local, Context for cross-tree, Zustand/Jotai for global.
- **Memoization.** Don't prematurely memo. Use `React.memo` only when profiler shows re-render cost. `useMemo`/`useCallback` for referential stability when passed to children.
- **Keys.** Never use array index as key. Use stable IDs from data.
- **Error boundaries.** Wrap route-level components. Use `react-error-boundary` library.

## File Structure

```
src/
  components/     # Shared UI components
  features/       # Feature-scoped modules (components + hooks + types)
  hooks/          # Shared custom hooks
  lib/            # Non-React utilities
  types/          # Shared type definitions
  routes/         # Route components (if not using file-based routing)
```

## Testing

- **Vitest or Jest** for unit tests. React Testing Library for component tests.
- **Test behavior, not implementation.** Query by role/text, not test-id.
- **No snapshot tests** unless testing serialized output.
- **Mock at boundaries.** Mock API calls (MSW), not internal modules.

## Common Anti-Patterns to Catch

- `useEffect` with missing dependencies → use ESLint exhaustive-deps rule
- Prop drilling > 2 levels → extract to Context or composition
- Giant components > 200 lines → split into smaller components
- Inline styles → use CSS modules, Tailwind, or styled-components
- `any` type assertions → narrow with type guards
- Non-null assertions (`!`) → handle the null case explicitly
