# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Sol is the monorepo for **Rize**, an automatic time tracking application. The stack consists of:
- **api/** - Rails 7.1 GraphQL backend (Ruby 3.3.5)
- **web/** - Next.js 14 React web app (Node 22)
- **electron/** - Electron desktop app (Node 22)
- **services/** - Bun-based TypeScript event consumers/workers
- **vanity/** - Webflow marketing site scripts (deprecated)
- **voyager/** - Marketing website for home and landing pageas (Next.js)
- **puppet/** - Puppeteer server for images/PDFs
- **chrome/** - Chrome browser extension
- **docs/** - Docusaurus documentation site
- **zapier/** - Zapier integration

## Development Commands

### Starting Development Environment
```bash
# Start all services (requires iTerm2 on macOS)
./scripts/run-dev.sh

# Or start individually:
cd api && hivemind Procfile.dev     # Rails + AnyCable + Sidekiq + Clockwork
cd web && npm run dev               # Next.js dev server
cd electron && npm run dev          # Electron with hot reload
cd services && hivemind Procfile.dev # Bun services
```

### Docker Dependencies (api/docker-compose.yml)
```bash
cd api && docker-compose up -d
# TimescaleDB: localhost:15432
# Redis: localhost:16379
# Kafka: localhost:9092
# MySQL: localhost:13306
```

### Testing
```bash
# API (RSpec)
cd api && bundle exec rspec
cd api && bundle exec rspec spec/path/to/file_spec.rb      # Single file
cd api && bundle exec rspec spec/path/to/file_spec.rb:42   # Single test at line

# Electron (Jest)
cd electron && npm test
cd electron && npm run test:watch
cd electron && npm run test:coverage

# Web - no active tests (exits 0)
```

### Building
```bash
cd api && bundle install && rake db:migrate
cd web && npm run build       # Runs gql-gen, tailwind, next build
cd electron && npm run build  # Electron Forge make
cd services && bun install
```

### GraphQL Code Generation
```bash
cd web && npm run build       # Includes gql codegen
cd electron && npm run dev    # Runs gql codegen as part of dev
```

## Architecture

### GraphQL API Structure
The API exposes two GraphQL endpoints:
- **api/v1** - Public API (OAuth consumers, Zapier)
- **private/v1** - Private API (web, electron apps)

Located at `api/app/graphql/{api,private}/v1/`

### Real-time Communication
- **AnyCable** WebSocket server for subscriptions
- ActionCable channels in `api/app/channels/`
- WebSocket config: `api/config/cable.yml` and `api/config/anycable.yml`

### Background Jobs
- **Sidekiq** for async job processing (`api/config/sidekiq.yml`)
- **Clockwork** for scheduled jobs (`api/config/clock.rb`)

### Event Streaming
- **Kafka** for event publishing/consumption
- Services consume events via `services/consumers/`
- Kafka config: `api/config/initializers/kafka.rb`

### Databases
- **Primary PostgreSQL** - Main application data
- **TimescaleDB** - Time-series data (separate connection in `database.yml`)
- **MySQL** - Legacy/external integrations
- **Redis** - Caching, ActionCable, Sidekiq

## Style Guidelines

### JavaScript/TypeScript
- Use `test()` instead of `it()` in tests
- Use `toBeCalled()` instead of `toHaveBeenCalledWith()` in jest assertions

## Key Configuration Files

- `api/config/database.yml` - Database connections (primary + timescale)
- `api/config/cable.yml` - AnyCable WebSocket config
- `api/Procfile.dev` - Development processes (rails, anycable, sidekiq, clockwork)
- `sol.code-workspace` - VS Code multi-folder workspace
- Each project requires its own `.env` file (not in repo)
