```markdown
# CLAUDE.md

Sol is the monorepo for **Rize**, an automatic time tracking application.

## Stack
- **api/** - Rails 7.1 GraphQL backend (Ruby 3.3.5)
- **web/** - Next.js 14 React web app (Node 22)
- **electron/** - Electron desktop app (Node 22)
- **services/** - Bun-based TypeScript event consumers/workers
- **voyager/** - Marketing website (Next.js)
- **puppet/** - Puppeteer server for images/PDFs
- **chrome/** - Chrome browser extension
- **docs/** - Docusaurus documentation site
- **zapier/** - Zapier integration
- **vanity/** - Webflow scripts (deprecated)

## Development Commands

```bash
# Start all (requires iTerm2)
./scripts/run-dev.sh

# Individual services
cd api && hivemind Procfile.dev      # Rails + AnyCable + Sidekiq + Clockwork
cd web && npm run dev                # Next.js (port 3001)
cd electron && npm run dev           # Electron + gql codegen
cd services && hivemind Procfile.dev # Bun consumers

# Docker deps (TimescaleDB:15432, Redis:16379, Kafka:9092, MySQL:13306)
cd api && docker-compose up -d
```

## Testing & Building

```bash
# API (RSpec)
cd api && bundle exec rspec
cd api && bundle exec rspec spec/path/to/file_spec.rb:42

# Electron (Jest)
cd electron && npm test

# Web - no active tests (exits 0)

# Build
cd api && bundle install && rake db:migrate
cd web && npm run build       # gql-gen + tailwind + next build
cd electron && npm run build
cd services && bun install
```

## Architecture

### GraphQL API
Two endpoints at `api/app/graphql/{api,private}/v1/`:
- **api/v1** - Public API (OAuth, Zapier)
- **private/v1** - Private API (web, electron)

### Infrastructure
- **AnyCable** WebSocket subscriptions (`api/config/cable.yml`, `anycable.yml`)
- **Sidekiq** async jobs (`api/config/sidekiq.yml`)
- **Clockwork** scheduled jobs (`api/config/clock.rb`)
- **Kafka** event streaming (`api/config/initializers/kafka.rb`, `services/consumers/`)

### Databases
- **PostgreSQL** - Primary app data
- **TimescaleDB** - Time-series (separate connection in `database.yml`)
- **MySQL** - Legacy integrations
- **Redis** - Caching, ActionCable, Sidekiq

## Style Guidelines

### JavaScript/TypeScript
- Use `test()` not `it()` in tests
- Use `toBeCalled()` not `toHaveBeenCalledWith()` in Jest assertions

## Key Config Files
- `api/config/database.yml` - DB connections
- `api/Procfile.dev` - Dev processes
- `sol.code-workspace` - VS Code workspace
- Each project requires its own `.env` (not in repo)
```