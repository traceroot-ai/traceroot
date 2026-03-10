<h1 align="center">
  <b>TraceRoot</b>
</h1>

<p align="center">
  <b>AI-powered observability for LLM applications</b><br>
  Debug production issues fast with intelligent trace analysis
</p>

<p align="center">
  <a href="https://github.com/traceroot-ai/traceroot/blob/main/LICENSE">
    <img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License">
  </a>
  <a href="https://github.com/traceroot-ai/traceroot/issues">
    <img src="https://img.shields.io/github/issues/traceroot-ai/traceroot" alt="GitHub Issues">
  </a>
  <a href="https://github.com/traceroot-ai/traceroot/commits/main">
    <img src="https://img.shields.io/github/commit-activity/m/traceroot-ai/traceroot" alt="Commit Activity">
  </a>
</p>

<p align="center">
  <a href="#getting-started">Getting Started</a> •
  <a href="#features">Features</a> •
  <a href="#architecture">Architecture</a> •
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

---

## What is TraceRoot?

TraceRoot is an observability platform that helps teams **debug LLM applications in production**. Instrument your app with our SDK, and TraceRoot captures traces, analyzes them with AI, and surfaces insights to fix bugs faster.

## Features

- **Trace Ingestion** — Capture LLM calls, agent actions, and tool usage via OpenTelemetry-compatible SDK
- **AI-Powered Analysis** — Automatically detect anomalies and get root cause suggestions
- **Session Replay** — Understand user sessions by stepping through trace timelines
- **Production-Ready** — Built on ClickHouse for high-throughput trace storage

## Getting Started

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/)
- [uv](https://docs.astral.sh/uv/) — Python package manager
- [pnpm](https://pnpm.io/) — Node.js package manager
- [goose](https://github.com/pressly/goose) — Database migrations (`brew install goose`)
- [tmux](https://github.com/tmux/tmux) — Terminal multiplexer (`brew install tmux`)

### Quick Start

```bash
git clone https://github.com/traceroot-ai/traceroot.git
cd traceroot
make dev
```

That's it! This starts all services in a tmux session:

| Service | URL |
|---------|-----|
| **Frontend** | http://localhost:3000 |
| **REST API** | http://localhost:8000/docs |

### Instrument Your App

```bash
pip install traceroot
```

```python
from traceroot import observe

@observe()
def my_agent():
    # Your LLM calls here
    pass
```

## Architecture

```mermaid
graph TB
    subgraph Client
        SDK[TraceRoot SDK]
    end

    subgraph Frontend
        UI[Next.js UI]
        Core[@traceroot/core<br/>Prisma + Types]
        Worker[TS Worker]
    end

    subgraph Backend
        API[FastAPI<br/>Trace Ingestion]
        Celery[Celery Worker<br/>Processing]
    end

    subgraph Storage
        PG[(PostgreSQL)]
        CH[(ClickHouse)]
        S3[(MinIO/S3)]
        Redis[(Redis)]
    end

    SDK -->|OTEL traces| API
    API -->|Queue| S3
    S3 -->|Poll| Celery
    Celery -->|Write| CH
    
    UI --> Core
    Core --> PG
    UI -->|Read traces| API
    API -->|Query| CH
    
    Worker --> Core
```

### Data Flow

1. **Ingestion**: SDK sends OTEL traces → FastAPI writes to S3
2. **Processing**: Celery worker polls S3 → transforms and stores in ClickHouse
3. **Querying**: UI requests traces → FastAPI queries ClickHouse

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | Next.js 15, React 19, TailwindCSS, Prisma |
| Backend | FastAPI, Celery, Python |
| SDK | Python, OpenTelemetry |
| Databases | PostgreSQL, ClickHouse |
| Infrastructure | Docker, MinIO, Redis |

## Self-Hosting

TraceRoot can be self-hosted with Docker Compose:

```bash
# Coming soon
docker compose up
```

Set `ENABLE_BILLING=false` in your `.env` to unlock all features without Stripe integration.

## Contributing

We welcome contributions! See [CONTRIBUTING.md](CONTRIBUTING.md) for:

- Development setup
- Project structure
- Code style guidelines
- How to submit PRs

## License

TraceRoot is [Apache-2.0 licensed](LICENSE).

When contributing, you'll need to agree to our [Contributor License Agreement](https://cla-assistant.io/traceroot-ai/traceroot).
