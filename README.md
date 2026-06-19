# dummy-mcp

A toy MCP server with two mocked PostHog-style tools (`get_trends`, `get_funnel`) for experimenting with the MCP Streamable HTTP transport and the `@posthog/mcp` analytics SDK.

## Setup

```bash
npm install
```

Config lives in `.env`. Copy the template and fill in your key:

```bash
cp .env.example .env
```

Then set in `.env`:

- `POSTHOG_API_KEY` — your **project API key** (the `phc_…` value from PostHog → Project Settings → Project API Key). Personal API keys (`phx_…`) are rejected with `401 personal_api_key`.
- `POSTHOG_HOST` — optional. Defaults to the local dev stack (`http://localhost:8010`); uncomment it and use `https://us.i.posthog.com` (or `https://eu.i.posthog.com`) for cloud.

## Run

```bash
node index.js
```

You should see:

```
server.ready http://localhost:3000/mcp
```

Override the port with `PORT=4000 node index.js` if needed.

All tool-call logs (`get_trends …`, etc.) go to stderr in this terminal. Leave it running.

## Connect from Claude Desktop

Claude Desktop speaks stdio MCP, so we bridge to the HTTP server with the `mcp-remote` proxy.

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "dummy-mcp": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://localhost:3000/mcp", "--transport", "http-only"]
    }
  }
}
```

Then restart Claude Desktop. Ask it to invoke `get_trends` or `get_funnel` and watch the live logs in the terminal running `node index.js`.

## Tools

- `get_trends(event, days=7)` — mocked daily time series
- `get_funnel(steps[], days=7)` — mocked funnel breakdown with conversion rates
