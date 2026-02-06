# Contributing to Traceroot

Thanks for your interest in contributing to Traceroot!

## Project Overview

Traceroot is an observability platform for LLM applications to fix production bugs fast. The project is organized as a monorepo containing:

> **Note:** We're currently pivoting to AgentOps functionality. Development is happening on the `pivot/agentops` branch. Check with maintainers for the latest on feature priorities.

- **Frontend**: TypeScript monorepo (`frontend/`)
  - `frontend/packages/core/` - Shared package with Prisma schema, client, and types (`@traceroot/core`)
  - `frontend/ui/` - Next.js application
  - `frontend/worker/` - TypeScript background worker
- **Backend**: Python services (`backend/`)
  - `backend/rest/` - FastAPI REST API
  - `backend/worker/` - Celery background worker
  - `backend/db/` - ClickHouse client and migrations
- **SDK**: Python SDK for instrumentation (`traceroot-py/`)


## Technologies

| Component | Stack |
|-----------|-------|
| Frontend | Next.js 15, React 19, TailwindCSS, TanStack Query, Prisma |
| REST API | FastAPI (trace ingestion), Next.js API Routes (CRUD) |
| Worker | Python, S3 polling |
| SDK | Python, OpenTelemetry |
| Databases | PostgreSQL (via Prisma), ClickHouse |
| Storage | MinIO (S3-compatible) |

## Development Setup

### Requirements

- **Python**: 3.11+
- **Node.js**: 20+ (for frontend)
- **uv**: Python package manager ([install](https://docs.astral.sh/uv/getting-started/installation/))
- **pnpm**: Node.js package manager ([install](https://pnpm.io/installation))
- **Docker**: For infrastructure only

### Quick Start

1. **Clone the repository**

   ```bash
   git clone https://github.com/traceroot-ai/traceroot.git
   cd traceroot
   ```

2. **Start infrastructure** (databases only)

   ```bash
   docker-compose up -d
   ```

   This starts:
   - PostgreSQL (port 5432)
   - ClickHouse (port 8123)
   - MinIO S3 (port 9000, console 9001)

3. **Set up environment**

   ```bash
   cp .env.example .env
   cp frontend/packages/core/.env.example frontend/packages/core/.env
   cp frontend/ui/.env.example frontend/ui/.env
   # Edit .env and frontend/ui/.env, set INTERNAL_API_SECRET to the same value
   # Edit frontend/packages/core/.env with your DATABASE_URL
   ```

4. **Install dependencies**

   ```bash
   # Python dependencies (from project root)
   uv sync

   # Frontend dependencies (installs all packages in the workspace)
   cd frontend && pnpm install
   ```

5. **Run database migrations**

   ```bash
   # Generate Prisma client and apply PostgreSQL migrations
   cd frontend/packages/core && pnpm db:generate
   cd frontend/packages/core && npx prisma migrate dev

   # ClickHouse schema (via goose - requires goose CLI)
   cd backend/db/clickhouse && ./migrate.sh up
   ```

6. **Start services**

   See [Running Services](#running-services) below.

---

## Monorepo Quickstart

This project uses a hybrid monorepo setup:
- **pnpm workspace** for the frontend (`frontend/`) containing:
  - `packages/core` - Shared TypeScript package (`@traceroot/core`) with Prisma
  - `ui` - Next.js application
  - `worker` - TypeScript background worker
- **uv** for Python packages (backend services + SDK)

### Installing Dependencies

```bash
# Python dependencies (from project root)
uv sync

# Frontend dependencies (from frontend folder - installs all workspace packages)
cd frontend && pnpm install

# Build the shared core package (required before running ui or worker)
cd frontend/packages/core && pnpm build
```

### Running Services

You can run each service independently for development:

```bash
# Terminal 1: REST API (from project root)
uv run python backend/rest/main.py

# Terminal 2: Python Worker (from project root)
uv run celery -A worker.celery_app worker --loglevel=info

# Terminal 3: Frontend UI
cd frontend/ui && pnpm dev

# Terminal 4: TypeScript Worker (optional)
cd frontend/worker && pnpm dev
```

### SDK Development

The SDK is in `traceroot-py/` and is included in the uv workspace (installed in editable mode via `uv sync`):

```bash
# Run SDK tests
cd traceroot-py && uv run pytest

# Test SDK manually
uv run python scripts/example_usage.py
```

### Running Tests

```bash
# All Python tests
uv run pytest

# SDK tests only
cd traceroot-py && uv run pytest

# Frontend tests
cd frontend/ui && pnpm test
```

### Useful Commands

| Command | Description |
|---------|-------------|
| `uv sync` | Install all Python dependencies |
| `uv run pytest` | Run Python tests |
| `uv run ruff check .` | Lint Python code |
| `uv run ruff format .` | Format Python code |
| `cd frontend && pnpm install` | Install all frontend workspace dependencies |
| `cd frontend/packages/core && pnpm build` | Build shared core package |
| `cd frontend/packages/core && pnpm db:generate` | Generate Prisma client |
| `cd frontend/packages/core && pnpm db:migrate` | Run Prisma migrations (dev) |
| `cd frontend/ui && pnpm dev` | Start frontend dev server |
| `cd frontend/ui && pnpm build` | Build frontend |
| `cd frontend/worker && pnpm dev` | Start TypeScript worker (dev) |
| `docker-compose up -d` | Start infrastructure |
| `docker-compose down` | Stop infrastructure |
| `docker-compose down -v` | Stop and remove volumes (reset data) |

---

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                   Frontend (frontend/)                           │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  @traceroot/core (packages/core/)                         │  │
│  │  • Prisma schema & client (PostgreSQL)                    │  │
│  │  • Shared TypeScript types                                │  │
│  └───────────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  Next.js UI (ui/)                                         │  │
│  │  • /api/organizations/**     (org CRUD)                   │  │
│  │  • /api/projects/**/api-keys (API key management)         │  │
│  │  • /api/internal/**          (for Python backend)         │  │
│  └───────────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  TypeScript Worker (worker/)                              │  │
│  │  • Background jobs using @traceroot/core                  │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              ▲
                              │ Internal HTTP API
                              │
┌─────────────────────────────┴───────────────────────────────────┐
│                    Python Backend (backend/rest/)                        │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  • /api/v1/public/traces   (OTEL ingestion → S3 → Celery) │  │
│  │  • /api/v1/projects/*/traces (trace reading ← ClickHouse) │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Python Worker (backend/worker/)               │
│  • Processes traces from S3 → ClickHouse                        │
└─────────────────────────────────────────────────────────────────┘

┌──────────────┐  ┌──────────────────────┐
│ traceroot-py │  │   backend/db/        │
│    (SDK)     │  │   (clickhouse)       │
└──────────────┘  └──────────────────────┘
```

### Internal API

The Python backend communicates with Next.js via internal HTTP API:

| Endpoint | Purpose |
|----------|---------|
| `POST /api/internal/validate-api-key` | Validate API key for trace ingestion |
| `POST /api/internal/validate-project-access` | Validate user access for trace reading |

These endpoints require the `X-Internal-Secret` header matching `INTERNAL_API_SECRET` env var.

---

## Making Changes

### Before You Start

1. **Open an issue** first for significant changes
2. Check existing [issues](https://github.com/traceroot-ai/traceroot/issues) for related work
3. Fork the repository and create a feature branch

### Code Style

- **Python**: We use `ruff` for linting and formatting
- **TypeScript**: We use ESLint and Prettier
- Follow existing patterns in the codebase

```bash
# Format and lint Python
uv run ruff format .
uv run ruff check . --fix

# Lint frontend
cd frontend/ui && pnpm lint
```

### Commit Messages

We follow [conventional commits](https://www.conventionalcommits.org/):

```
feat: add new trace filtering API
fix: resolve race condition in worker
docs: update SDK documentation
refactor: simplify database queries
```

### Pull Requests

1. Ensure tests pass locally
2. Update documentation if needed
3. Add tests for new features
4. Keep PRs focused and reasonably sized

---

## Database Development

### Database Schema Strategy

We use **Prisma** (TypeScript) as the single source of truth for PostgreSQL schema:

| Component | Technology | Role |
|-----------|------------|------|
| Frontend (Next.js) | Prisma | **Source of truth** for schema and migrations |
| Backend (Python) | httpx | Calls Next.js internal API for database access |

**Important:**

- **Prisma owns all PostgreSQL schema and migrations**
- Python backend accesses PostgreSQL via internal HTTP API to Next.js
- ClickHouse schema is managed separately via `backend/db/clickhouse/migrations/`

### Migrations

**PostgreSQL** - Managed by Prisma (in `frontend/packages/core/`):

```bash
cd frontend/packages/core

# Generate Prisma client after schema changes
pnpm db:generate
# or: npx prisma generate

# Create and apply a migration (development)
pnpm db:migrate
# or: npx prisma migrate dev --name "description"

# Apply migrations in production
npx prisma migrate deploy
```

**ClickHouse** - Managed by goose:

```bash
cd backend/db/clickhouse

# Apply all pending migrations
./migrate.sh up

# Check migration status
./migrate.sh status

# Create a new migration
./migrate.sh create add_new_column
```

> **Note**: Prisma only supports PostgreSQL. ClickHouse migrations use [goose](https://github.com/pressly/goose) with SQL files in `backend/db/clickhouse/migrations/`.

### Resetting Databases

```bash
# Reset all data (keeps containers)
docker-compose down -v && docker-compose up -d

# Re-run migrations after reset
cd frontend/packages/core && npx prisma migrate dev   # PostgreSQL
cd backend/db/clickhouse && ./migrate.sh up             # ClickHouse
```

### Inspecting Databases

You can query the databases directly to inspect data during development.

**PostgreSQL:**

```bash
# List all tables
docker exec traceroot-postgres-1 psql -U postgres -d postgres -c "\dt"

# Query specific tables
docker exec traceroot-postgres-1 psql -U postgres -d postgres -c "SELECT * FROM users;"
docker exec traceroot-postgres-1 psql -U postgres -d postgres -c "SELECT * FROM organizations;"
docker exec traceroot-postgres-1 psql -U postgres -d postgres -c "SELECT * FROM projects;"
docker exec traceroot-postgres-1 psql -U postgres -d postgres -c "SELECT * FROM api_keys;"

# Interactive psql session
docker exec -it traceroot-postgres-1 psql -U postgres -d postgres
```

**ClickHouse:**

```bash
# List all tables
docker exec traceroot-clickhouse-1 clickhouse-client --user clickhouse --password clickhouse -q "SHOW TABLES"

# Query traces
docker exec traceroot-clickhouse-1 clickhouse-client --user clickhouse --password clickhouse -q "SELECT * FROM traces LIMIT 10"

# Interactive session
docker exec -it traceroot-clickhouse-1 clickhouse-client --user clickhouse --password clickhouse
```

**MinIO (S3):**

Access the MinIO web console at [http://localhost:9001](http://localhost:9001)

- Username: `minio` (or value of `MINIO_ROOT_USER`)
- Password: `minio` (or value of `MINIO_ROOT_PASSWORD`)

---

## Environment Variables

Environment files are needed in multiple locations:
- `.env` - Python backend configuration (root)
- `frontend/packages/core/.env` - Database URL for Prisma
- `frontend/ui/.env` - Next.js application settings

See `.env.example` and respective `.env.example` files for all configuration options:

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `postgresql://...` | PostgreSQL connection (Prisma format) |
| `CLICKHOUSE_HOST` | `localhost` | ClickHouse host |
| `S3_ENDPOINT_URL` | `http://localhost:9000` | MinIO/S3 endpoint |
| `PORT` | `8000` | REST API port |
| `TRACEROOT_UI_URL` | `http://localhost:3000` | Next.js URL for internal API |
| `INTERNAL_API_SECRET` | - | Shared secret for internal API auth |

---

## Troubleshooting

### Common Issues

**Port already in use**
```bash
# Find and kill process on port 8000
lsof -i :8000
kill -9 <PID>
```

**Database connection issues**
```bash
# Check if containers are running
docker-compose ps

# View logs
docker-compose logs postgres
docker-compose logs clickhouse
```

**uv sync fails**
```bash
# Clear cache and retry
uv cache clean
uv sync
```

**pnpm install fails**
```bash
# Clear cache and retry (from frontend folder)
cd frontend
pnpm store prune
rm -rf node_modules packages/core/node_modules ui/node_modules worker/node_modules
pnpm install
```

---


## License

TraceRoot is Apache-2.0 licensed. See [LICENSE](LICENSE) for more details.

When contributing to the TraceRoot codebase, you need to agree to the [Contributor License Agreement](https://cla-assistant.io/traceroot-ai/traceroot). You only need to do this once.
