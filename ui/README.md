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

Please update the `ui/.env.local` file with the correct values or use the
`set_env` script or export the environment variables.

```bash
export NEXT_PUBLIC_APP_URL=http://localhost:3000
export NEXT_PUBLIC_AUTH_ENDPOINT=http://localhost:8000
export REST_API_ENDPOINT=http://localhost:8000
export NEXT_PUBLIC_REST_API_ENDPOINT=http://localhost:8000
export NEXT_PUBLIC_LOCAL_MODE=true # Set to true to start locally
export NEXT_PUBLIC_STRIPE_MODE=disabled # Set to enabled to use stripe
```

## Start the development server

Only run this command once:

```bash
npm install
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
