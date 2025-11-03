# TraceRoot Docker Compose Setup

This directory contains Docker Compose configuration for running TraceRoot locally with all its dependencies.

## Prerequisites

- **Docker** and **Docker Compose** installed on your system
  - [Install Docker](https://docs.docker.com/get-docker/)
  - [Install Docker Compose](https://docs.docker.com/compose/install/)
- **Git** (for cloning the repository if needed)

## Quick Start

1. **Clone the repository** (if you haven't already):

   ```bash
   git clone https://github.com/traceroot-ai/traceroot.git
   cd traceroot
   ```

1. **Navigate to the compose directory**:

   ```bash
   cd docker/public/compose
   ```

1. **Start all services**:

   ```bash
   docker-compose up -d
   ```

1. **Wait for services to be ready** (this may take 5-10 minutes on first run):

   ```bash
   docker-compose logs -f traceroot
   ```

1. **Access the applications**:

   - **TraceRoot UI**: http://localhost:3000
   - **TraceRoot API**: http://localhost:8000
   - **Jaeger UI**: http://localhost:16686

## Services

### Jaeger (Tracing Backend)

- **Image**: `cr.jaegertracing.io/jaegertracing/jaeger:2.8.0`
- **Ports**:
  - `16686` - Jaeger UI
  - `14268` - Jaeger collector HTTP
  - `14250` - Jaeger collector gRPC
  - `4317` - OTLP gRPC receiver
  - `4318` - OTLP HTTP receiver

### TraceRoot

- **Build**: Uses local Dockerfile with `LOCAL_BUILD=true`
- **Ports**:
  - `3000` - Frontend (Next.js)
  - `8000` - Backend API (FastAPI)

## Common Commands

### Start services

```bash
docker-compose up -d
```

### View logs

```bash
# All services
docker-compose logs -f

# Specific service
docker-compose logs -f traceroot
docker-compose logs -f jaeger
```

### Stop services

```bash
docker-compose down
```

### Restart services

```bash
docker-compose restart
```

### Rebuild and restart (after code changes)

```bash
docker-compose down
docker-compose up -d --build
```

### Check service status

```bash
docker-compose ps
```

## Health Checks

Both services include health checks:

- **Jaeger**: Checks if the UI is accessible on port 16686
- **TraceRoot**: Checks if both frontend (3000) and backend (8000) are responding

You can check the health status with:

```bash
docker-compose ps
```

## Troubleshooting

### Services won't start

1. **Check if ports are already in use**:

   ```bash
   lsof -i :3000,8000,16686
   ```

1. **Check Docker logs**:

   ```bash
   docker-compose logs traceroot
   ```

1. **Ensure Docker has enough resources**:

   - At least 4GB RAM allocated to Docker
   - At least 2GB disk space available

### Build fails

1. **Clean up and rebuild**:
   ```bash
   docker-compose down -v
   docker system prune -f
   docker-compose up -d --build
   ```

### Services are slow to start

- **First build** can take 5-10 minutes as it needs to:

  - Install Python dependencies
  - Install Node.js dependencies
  - Build the Next.js frontend

- **Subsequent starts** should be much faster (under 1 minute)

### Can't access services

1. **Check if services are healthy**:

   ```bash
   docker-compose ps
   ```

1. **Wait for health checks to pass** (especially for TraceRoot, which takes longer to start)

1. **Check firewall settings** - ensure ports 3000, 8000, and 16686 are not blocked

## Development

### Making code changes

After making changes to the codebase:

```bash
docker-compose down
docker-compose up -d --build
```

### Using local development mode

The compose setup uses `LOCAL_BUILD=true`, which means it will use your local code instead of cloning from GitHub.

## Differences from One-Line Installer

| Feature        | One-Line Installer          | Docker Compose                 |
| -------------- | --------------------------- | ------------------------------ |
| **Setup**      | Single command              | Requires Docker Compose        |
| **Management** | Manual container management | Declarative service management |
| **Logs**       | `docker logs <container>`   | `docker-compose logs`          |
| **Updates**    | Re-run installer script     | `docker-compose up --build`    |
| **Cleanup**    | Manual container removal    | `docker-compose down`          |

## Getting Help

- **TraceRoot Documentation**: https://docs.traceroot.ai
- **Discord Community**: https://discord.gg/tPyffEZvvJ
- **GitHub Issues**: https://github.com/traceroot-ai/traceroot/issues
