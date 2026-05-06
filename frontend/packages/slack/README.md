# @traceroot/slack

Workspace-level Slack integration for TraceRoot — OAuth installer, encrypted bot-token store, Block Kit alert builder, and a `WebClient` factory shared between the web app (route handlers) and worker (alert delivery).

## Local development setup

Local dev runs over plain HTTP. Slack auto-installs into your currently-active Slack workspace; if you're signed into multiple workspaces and Slack picks the wrong one, see "Installing into the right workspace" below.

### 1. Create your own dev Slack app

You'll create a per-developer Slack app for local testing.

1. Go to https://api.slack.com/apps → **Create New App** → **From scratch**
2. App name: `traceroot dev` (or anything; just keep it distinct from anyone else's)
3. Pick a Slack workspace where you're an admin
4. **OAuth & Permissions** → **Scopes** → **Bot Token Scopes** → add all four:
   - `chat:write`
   - `chat:write.public`
   - `channels:read`
   - `groups:read`
5. **OAuth & Permissions** → **Redirect URLs** → add:
   - `http://localhost:3000/api/slack/oauth/callback`

### 2. Populate `.env`

In the repo root `.env`:

```bash
SLACK_CLIENT_ID=...               # Slack app → Basic Information → App Credentials → Client ID
SLACK_CLIENT_SECRET=...           # Same place → Client Secret
SLACK_STATE_SECRET=...            # Generate: `openssl rand -hex 32`
SLACK_REDIRECT_URI=http://localhost:3000/api/slack/oauth/callback
```

### 3. Installing into the right workspace

When you click **Connect** under Slack on the workspace integrations page, Slack auto-installs into your **currently-active** Slack workspace (whichever one your browser is on). To install into a specific workspace:

1. Open https://app.slack.com in another tab (incognito works well to isolate sessions)
2. Click the workspace icon in the left rail for the workspace you want to install into
3. Once that workspace is your active one, return to the integrations page and click **Connect**

If you accidentally land on the wrong workspace's OAuth page (e.g., one where you're not admin and Slack returns "You are not authorized to install"), repeat with the correct active workspace.

### Private channels: invite the bot

The `groups:read` scope only returns **private channels the bot is a member of**. Public channels are visible regardless of membership; private ones must explicitly add the bot.

To make a private channel selectable, open it in Slack and run:

```
/invite @traceroot dev
```

Close + reopen the Configure popover to pick up the new channel (or wait ~5 min for the cache to expire).
