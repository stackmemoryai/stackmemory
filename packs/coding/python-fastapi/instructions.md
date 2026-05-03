# coding/python-fastapi

## Python Conventions

- **Python 3.11+.** Use modern syntax: `match/case`, `type` aliases, `ExceptionGroup`.
- **Type hints everywhere.** All function signatures, return types, and class attributes. Use `from __future__ import annotations` for forward references.
- **Pydantic v2 for data validation.** `BaseModel` for schemas, `model_validator` for complex validation. Never use raw dicts for API I/O.
- **Async by default.** Use `async def` for route handlers and DB operations. Use `asyncio.gather` for concurrent I/O.
- **No global mutable state.** Use dependency injection via FastAPI's `Depends()`.
- **Naming.** snake_case for functions/variables. PascalCase for classes. UPPER_SNAKE for constants.

## FastAPI Patterns

- **Router per domain.** `app/routers/users.py`, `app/routers/items.py`. Mount with `app.include_router()`.
- **Pydantic schemas for I/O.** Separate `Create`, `Update`, `Response` schemas. Never expose ORM models directly.
- **Dependency injection.** DB sessions, auth, config — all via `Depends()`. Define in `app/dependencies.py`.
- **Status codes.** Use `status.HTTP_201_CREATED` for creates, `HTTP_204_NO_CONTENT` for deletes. Raise `HTTPException` with proper codes.
- **Background tasks.** Use `BackgroundTasks` for fire-and-forget. Use Celery/ARQ for durable jobs.
- **Middleware.** CORS, request logging, error handling. Define in `app/middleware.py`.

## Project Structure

```
app/
  main.py           # FastAPI app instance + startup
  core/
    config.py       # Settings via pydantic-settings
    security.py     # Auth utilities
  routers/          # APIRouter modules
  models/           # SQLAlchemy/SQLModel ORM models
  schemas/          # Pydantic request/response models
  dependencies.py   # Shared Depends() callables
  middleware.py      # Middleware stack
tests/
  conftest.py       # Fixtures (test client, DB)
  test_*.py         # Test modules
```

## Database

- **SQLAlchemy 2.0 style.** `select()` not `query()`. Mapped classes with `Mapped[]` annotations.
- **Alembic for migrations.** Auto-generate with `alembic revision --autogenerate`. Never edit the DB schema manually.
- **Session management.** Async sessions via `async_sessionmaker`. Yield in dependency.
- **Connection pooling.** Configure `pool_size`, `max_overflow` in production.

## Testing

- **pytest + httpx.** Use `AsyncClient` with `app` for integration tests.
- **Fixtures for DB.** Create test database, run migrations, yield session, rollback.
- **Factory pattern for test data.** Use `factory_boy` or simple fixture functions.
- **Test the API, not internals.** Call endpoints via client, assert response shape + status.

## Common Anti-Patterns to Catch

- Synchronous DB calls in async handlers → blocks the event loop
- Raw SQL without parameterization → SQL injection risk
- Returning ORM models from endpoints → use Pydantic response models
- Missing `async` on route handlers with I/O → blocks worker threads
- Hardcoded secrets → use environment variables via pydantic-settings
- Missing input validation → always validate via Pydantic schemas
