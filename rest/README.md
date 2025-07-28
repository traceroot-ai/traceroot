# REST API

## Run the server

In the root directory, run:

```bash
# Required
export TRACE_ROOT_LOCAL_MODE=true # Set to true to start locally
export DB_NAME=traceroot
export DB_CHAT_COLLECTION=agent_chat
export DB_CHAT_METADATA_COLLECTION=chat_metadata
export DB_CONNECTION_TOKENS_COLLECTION=connection_tokens
export DB_TRACEROOT_TOKENS_COLLECTION=traceroot_tokens
export DB_SUBSCRIPTIONS_COLLECTION=user_subscriptions
```

Start the server:

```bash
uvicorn rest.main:app --reload --reload-dir rest
```
