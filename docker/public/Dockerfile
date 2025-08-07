FROM ubuntu:24.04

# Set local build to true if using local github repo to build the image
ARG LOCAL_BUILD=false
ENV LOCAL_BUILD=${LOCAL_BUILD}

# Set environment variables
ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1
ENV NODE_VERSION=20.19.2
ENV NPM_VERSION=10.8.2

# Update system and install basic dependencies
RUN apt-get update && apt-get install -y \
    git \
    curl \
    wget \
    build-essential \
    software-properties-common \
    ca-certificates \
    gnupg \
    lsb-release \
    && rm -rf /var/lib/apt/lists/*

# Install Python 3.11
RUN add-apt-repository ppa:deadsnakes/ppa -y && \
    apt-get update && \
    apt-get install -y \
    python3.11 \
    python3.11-venv \
    python3.11-dev \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js v20.19.2 and npm 10.8.2
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    npm install -g npm@${NPM_VERSION}

# Verify Node.js and npm versions
RUN node --version && npm --version

# Set working directory
WORKDIR /app

# Add cache busting argument to force git clone to always run
ARG CACHEBUST=1

# Copy local files (will be used if LOCAL_BUILD is true)
COPY . /app/traceroot

# Clone repositories if not local build (this will replace the copied files)
RUN if [ "$LOCAL_BUILD" = "false" ]; then \
        rm -rf /app/traceroot && \
        git clone https://github.com/traceroot-ai/traceroot.git; \
    fi

# Change to traceroot directory
WORKDIR /app/traceroot

# Remove all ee folders recursively
RUN find /app/traceroot -type d -name "ee" -exec rm -rf {} +

# Remove existing venv directory if it exists (from local copy)
RUN rm -rf venv

# Create Python virtual environment
RUN python3.11 -m venv venv

# Activate virtual environment and install Python dependencies
RUN /bin/bash -c "source venv/bin/activate && \
    pip install pip --upgrade && \
    pip install ."

# Change to ui directory and install npm dependencies
WORKDIR /app/traceroot/ui
RUN npm install

# Set final working directory back to traceroot
WORKDIR /app/traceroot

# Required environment variables
ENV DB_NAME=traceroot
ENV DB_CHAT_COLLECTION=agent_chat
ENV DB_CHAT_METADATA_COLLECTION=chat_metadata
ENV DB_CONNECTION_TOKENS_COLLECTION=connection_tokens
ENV DB_TRACEROOT_TOKENS_COLLECTION=traceroot_tokens
ENV DB_SUBSCRIPTIONS_COLLECTION=user_subscriptions
ENV OPENAI_API_KEY=""
ENV DB_PASSWORD=""
ENV DB_USER_NAME=traceroot

# AWS Cognito environment variables (required for traceroot-auth)
ENV COGNITO_CLIENT_ID=""
ENV COGNITO_ISSUER=""
ENV NEXT_PUBLIC_COGNITO_CLIENT_ID=""
ENV COGNITO_CLIENT_SECRET=""
ENV NEXT_PUBLIC_AWS_REGION="us-west-2"
ENV COGNITO_USER_POOL_ID=""
ENV NEXTAUTH_URL=""
ENV NEXTAUTH_SECRET=""
ENV NEXT_PUBLIC_DEV=""

# Required environment variables for ui
ENV NEXT_PUBLIC_APP_URL="http://localhost:3000"
ENV REST_API_ENDPOINT="http://localhost:8000"
ENV NEXT_PUBLIC_REST_API_ENDPOINT="http://localhost:8000"
ENV JAEGER_URL="http://host.docker.internal:16686"
ENV NEXT_PUBLIC_STRIPE_MODE="disabled"

# Set local mode to true
ENV TRACE_ROOT_LOCAL_MODE=true
ENV NEXT_PUBLIC_LOCAL_MODE=true

# Expose ports
EXPOSE 3000 8000

# Copy and use the new startup script
COPY docker/public/start.sh /app/start.sh
RUN chmod +x /app/start.sh

# Default command runs the startup script
CMD ["/app/start.sh"]
