# UI

## Setup

### Using Bun (Recommended)

```bash
# Install Bun if you haven't already
curl -fsSL https://bun.sh/install | bash

# The project uses Bun version specified in .bun-version (1.2.23)
# Upgrade to the latest version
bun upgrade

# Install dependencies
bun install

# Copy all necessary environment variables to .env.local for nextjs to use
cp ../.env.development ./.env.local
```

### Using Node.js (Alternative)

```bash
# You may need to install nvm to manage node versions
nvm install 20
nvm use 20
node -v
npm -v
# v20.19.2
# 10.8.2

npm install
# Copy all necessary environment variables to .env.local for nextjs to use
cp ../.env.development ./.env.local
```

## Start the development server

```bash
make dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Build and deploy

### Development build

```bash
make start
```

### Production deployment

```bash
# Build the production bundle
bun run build
# Or with npm
npm run build

# Start the production server
bun run start
# You may need to run start on another endpoint such as 3001
bun run start -- -p 3001
# Or with npm
npm run start
```
