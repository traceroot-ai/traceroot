# UI for Multi-Agent Code Agent

## Install Node.js

```bash
# You may need to install nvm to manage node versions
nvm install 20
nvm use 20
node -v
npm -v
# v20.19.2
# 10.8.2
```

## Setup Next.js

```bash
npm install
```

## Run the UI

```bash
NEXT_OTEL_DISABLED=1 npm run dev
```

**Note:** The API routes use `undici` instead of `fetch` to avoid Next.js's automatic fetch instrumentation, which prevents localhost spans from appearing in traces. This maintains clean distributed tracing between the frontend and backend services.
