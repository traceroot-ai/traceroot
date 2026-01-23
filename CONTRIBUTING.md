# Contributing to Traceroot

Thanks for your interest in contributing to Traceroot!

## Project Overview

Traceroot is an observability platform for LLM applications to fix production bugs fast. The project is organized as a monorepo containing:

> **Note:** We're currently pivoting to AgentOps functionality. Development is happening on the `pivot/agentops` branch. Check with maintainers for the latest on feature priorities.

- **Frontend**: Next.js application (`ui/`)
- **Backend**: Python services (`rest/`, `worker/`)
- **Shared Code**: Common modules (`common/`, `db/`)
- **SDK**: Python SDK for instrumentation (`traceroot-py/`)


## Technologies

| Component | Stack |
|-----------|-------|
| Frontend | Next.js 15, React 19, TailwindCSS, TanStack Query |
| REST API | FastAPI, Pydantic, SQLAlchemy |
| Worker | Python, S3 polling |
| SDK | Python, OpenTelemetry |
| Databases | PostgreSQL, ClickHouse |
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
   ```

4. **Install dependencies and start services**

   See [Monorepo Quickstart](#monorepo-quickstart) below.

---

## Monorepo Quickstart

This project uses a hybrid monorepo setup:
- **pnpm** for the frontend (`ui/`)
- **uv** for Python packages (backend services + SDK)

### Installing Dependencies

```bash
# Python dependencies (from project root)
uv sync

# Frontend dependencies
cd ui && pnpm install
```

### Running Services

You can run each service independently for development:

```bash
# Terminal 1: REST API (from project root)
uv run python rest/main.py

# Terminal 2: Worker (from project root)
uv run python worker/main.py

# Terminal 3: Frontend
cd ui
pnpm dev
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
cd ui && pnpm test
```

### Useful Commands

| Command | Description |
|---------|-------------|
| `uv sync` | Install all Python dependencies |
| `uv run pytest` | Run Python tests |
| `uv run ruff check .` | Lint Python code |
| `uv run ruff format .` | Format Python code |
| `pnpm --filter traceroot-ui dev` | Start frontend dev server |
| `pnpm --filter traceroot-ui build` | Build frontend |
| `docker-compose up -d` | Start infrastructure |
| `docker-compose down` | Stop infrastructure |
| `docker-compose down -v` | Stop and remove volumes (reset data) |

---

### Package Dependencies

```
                    ┌─────────────┐
                    │   common    │
                    └──────┬──────┘
                           │
              ┌────────────┴────────────┐
              │                         │
              ▼                         ▼
        ┌──────────┐              ┌────────────┐
        │    db    │              │traceroot-py│
        └────┬─────┘              │  (SDK)     │
             │                    └────────────┘
    ┌────────┴────────┐
    │                 │
    ▼                 ▼
┌────────────┐  ┌────────────┐
│    rest    │  │   worker   │
└────────────┘  └────────────┘
```

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
cd ui && pnpm lint
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

### Migrations

PostgreSQL migrations are managed with Alembic:

```bash
# Create a new migration
cd db/migrations/postgres
alembic revision --autogenerate -m "description"

# Apply migrations
alembic upgrade head
```

### Resetting Databases

```bash
# Reset all data (keeps containers)
docker-compose down -v && docker-compose up -d
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

See `.env.example` for all configuration options:

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `postgresql+asyncpg://...` | PostgreSQL connection |
| `CLICKHOUSE_HOST` | `localhost` | ClickHouse host |
| `S3_ENDPOINT_URL` | `http://localhost:9000` | MinIO/S3 endpoint |
| `PORT` | `8000` | REST API port |

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
# Clear cache and retry
pnpm store prune
rm -rf node_modules
pnpm install
```

---


## License

TraceRoot is Apache-2.0 licensed. See [LICENSE](LICENSE) for more details.

When contributing to the TraceRoot codebase, you need to agree to the [Contributor License Agreement](https://cla-assistant.io/traceroot-ai/traceroot). You only need to do this once.
