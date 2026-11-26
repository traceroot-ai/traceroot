# Vapi Webhook Importer for TraceRoot

Receives Vapi `end-of-call-report` server webhooks and exports each call as a TraceRoot trace with:

- The Vapi `call.id` as the TraceRoot `session_id`
- A root `AGENT` span (`vapi.call`) carrying the call transcript, summary, and total reported cost
- Child `LLM` spans for assistant turns (with model name)
- Child `TOOL` spans for tool/function calls (with tool name, arguments, and result)

## Run locally

```bash
cp .env.example .env
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8080
```

Configure your Vapi assistant or organization **Server URL** to point to `https://<your-host>/vapi/webhook` and enable `end-of-call-report` in `serverMessages`.
