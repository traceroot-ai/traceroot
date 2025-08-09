# UI

## Setup

```bash
# You may need to install nvm to manage node versions
nvm install 20
nvm use 20
node -v
npm -v
# v20.19.2
# 10.8.2
```

## Start the development server

Only run this command once:

```bash
npm install
# Source the environment variables
cp ../.env.development ./.env.local
```

Then run the following command to start the development server:

```bash
make dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Build and start the server

```bash
make start
```
