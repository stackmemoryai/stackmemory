```markdown
# CLAUDE.md

Sol is the monorepo for **Rize**, an automatic time tracking application.

## Stack

| Dir | Description |
|-----|-------------|
| `api/` | Rails 7.1 GraphQL backend (Ruby 3.3.5) |
| `web/` | Next.js 14 React web app (Node 22) |
| `electron/` | Electron desktop app (Node 22) |
| `services/` | Bun-based TypeScript event consumers/workers |
| `voyager/` | Marketing website (Next.js) |
| `puppet/` | Puppeteer server for images/PDFs |
| `chrome/` | Chrome browser extension |
| `docs/` | Docusaurus documentation site |
| `zapier/` | Zapier integration |
| `vanity/` | Webflow scripts (deprecated) |

## Dev Commands

```bash
# All services (requires iTerm2)
./scripts/run-dev.sh

# Individual
cd api && hivemind Procfile.dev      # Rails + AnyCable + Sidekiq + Clockwork
cd web && npm run dev                # Next.js (port 3001)
cd electron && npm run dev           # Electron with hot reload
cd services && hivemind Procfile.dev # Bun services

# Docker deps (start first)
cd api && docker-compose up -d
# TimescaleDB :15432 | Redis :16379 | Kafka :9092 | MySQL :13306
```

## Testing

```bash
# API (RSpec)
cd api && bundle exec rspec
cd api && bundle exec rspec spec/path/to/file_spec.rb
cd api && bundle exec rspec spec/path/to/file_spec.rb:42

# Electron (Jest)
cd electron && npm test
cd electron && npm run test:watch
cd electron && npm run test:coverage

# Web - no active tests (exits 0)
```

## Building

```bash
cd api && bundle install && rake db:migrate
cd web && npm run build       # gql-gen + tailwind + next build
cd electron && npm run build  # Electron Forge make
cd services && bun install
```

GraphQL codegen: runs in `web && npm run build` and `electron && npm run dev`.

## Architecture

### GraphQL Endpoints
- `api/v1` — Public API (OAuth, Zapier) → `api/app/graphql/api/v1/`
- `private/v1` — Private API (web, electron) → `api/app/graphql/private/v1/`

### Infrastructure
- **WebSockets**: AnyCable (`api/config/cable.yml`, `anycable.yml`), channels in `api/app/channels/`
- **Jobs**: Sidekiq async (`api/config/sidekiq.yml`), Clockwork scheduled (`api/config/clock.rb`)
- **Events**: Kafka (`api/config/initializers/kafka.rb`), consumers in `services/consumers/`
- **Databases**: PostgreSQL (primary), TimescaleDB (time-series), MySQL (legacy), Redis (cache/cable/sidekiq)

## Style Guidelines

### JavaScript/TypeScript Tests
- Use `test()` not `it()`
- Use `toBeCalled()` not `toHaveBeenCalledWith()`

## Key Config Files

- `api/config/database.yml` — DB connections (primary + timescale)
- `api/config/cable.yml` — AnyCable WebSocket
- `api/Procfile.dev` — Dev processes
- `sol.code-workspace` — VS Code workspace
- Each project requires its own `.env` (not in repo)
```