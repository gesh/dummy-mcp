# dummy-mcp

A toy MCP server with two mocked PostHog-style tools (`get_trends`, `get_funnel`) for experimenting with the MCP Streamable HTTP transport and the `@posthog/mcp` analytics SDK.

## Setup

```bash
npm install
```

Open `index.js` and replace the placeholder `apiKey: "phc_....."` inside `track(server, { ... })` with a real **project API key** (the `phc_…` value from PostHog → Project Settings → Project API Key). Personal API keys (`phx_…`) will be rejected with `401 personal_api_key`.

Adjust `host` in the same block if you're not pointing at a local PostHog (`http://localhost:8010` is the default). Use `https://us.i.posthog.com` or `https://eu.i.posthog.com` for cloud.

## Run

```bash
node index.js
```

You should see:

```
server.ready http://localhost:3000/mcp
```

Override the port with `PORT=4000 node index.js` if needed.

All tool-call logs (`get_trends called …`, etc.) go to stderr in this terminal. Leave it running.

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

- `get_trends(event, days=7, interval="day")` — mocked daily time series
- `get_funnel(steps[], days=7)` — mocked funnel breakdown with conversion rates
