#!/usr/bin/env node
import http from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { PostHog } from "posthog-node";
import { instrument } from "@posthog/mcp";

// Load .env (POSTHOG_API_KEY, optional POSTHOG_HOST) if present.
try {
  process.loadEnvFile();
} catch {
  // no .env file — fall back to the real environment
}

if (!process.env.POSTHOG_API_KEY) {
  console.error("Missing POSTHOG_API_KEY. Copy .env.example to .env and set it.");
  process.exit(1);
}

// One PostHog client, shared across every session's server.
const posthog = new PostHog(process.env.POSTHOG_API_KEY, {
  // Defaults to the local PostHog dev stack. For production (PostHog Cloud US),
  // set POSTHOG_HOST=https://us.i.posthog.com in .env.
  host: process.env.POSTHOG_HOST ?? "http://localhost:8010",
  flushAt: 1,
});

const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

const daysBack = (n) =>
  Array.from({ length: n }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (n - 1 - i));
    return d.toISOString().slice(0, 10);
  });

// Fake but stable person for a session: same session id -> same name/email, so the
// repeated identify() calls within one session don't keep rewriting the person.
const FIRST = ["Ada", "Grace", "Linus", "Alan", "Margaret", "Dennis", "Barbara", "Ken"];
const LAST = ["Lovelace", "Hopper", "Torvalds", "Turing", "Hamilton", "Ritchie", "Liskov", "Thompson"];
const dummyPerson = (sessionId) => {
  const hex = sessionId.replace(/-/g, "");
  const tag = hex.slice(0, 6);
  const first = FIRST[parseInt(hex.slice(0, 8), 16) % FIRST.length];
  const last = LAST[parseInt(hex.slice(8, 16), 16) % LAST.length];
  return {
    id: `user_${tag}`,
    name: `${first} ${last}`,
    email: `${first}.${last}.${tag}@example.com`.toLowerCase(),
  };
};

// One MCP server per session. PostHog auto-captures its tool calls.
function buildServer() {
  const server = new McpServer({ name: "dummy-mcp", version: "0.1.0" });

  server.tool(
    "get_trends",
    "Return a mocked trends time series for an event over the last N days.",
    {
      event: z.string().describe("Event name, e.g. 'pageview'"),
      days: z.number().int().min(1).max(90).default(7).describe("Lookback window in days"),
    },
    async ({ event, days }) => {
      console.error("get_trends", { event, days });
      const series = daysBack(days).map((date) => ({ date, value: rand(50, 5000) }));
      const result = { event, total: series.reduce((s, p) => s + p.value, 0), series };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_funnel",
    "Return a mocked funnel conversion report for an ordered list of steps.",
    {
      steps: z.array(z.string()).min(2).describe("Ordered list of event names"),
      days: z.number().int().min(1).max(90).default(7).describe("Lookback window in days"),
    },
    async ({ steps, days }) => {
      console.error("get_funnel", { steps, days });
      let count = rand(5000, 20000);
      const breakdown = steps.map((name, i) => {
        if (i > 0) count = Math.floor(count * (Math.random() * 0.5 + 0.3));
        return { step: i + 1, name, count };
      });
      const top = breakdown[0].count;
      const result = {
        days,
        overall_conversion: +(breakdown.at(-1).count / top).toFixed(4),
        steps: breakdown.map((s) => ({ ...s, conversion_from_top: +(s.count / top).toFixed(4) })),
      };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  instrument(server, posthog, {
    // Print SDK logs (incl. "Identified session …") so you can watch identity happen.
    logger: (msg) => console.error("[posthog]", msg),
    // Identify each session as a generated dummy user. distinct_id is the user id
    // (not the session id), with name/email as person props (`$set`) on every event.
    identify: (_request, extra) => {
      const sessionId = extra?.sessionId;
      if (!sessionId) return null;
      const person = dummyPerson(sessionId);
      return {
        distinctId: person.id,
        properties: {
          name: person.name,
          email: person.email,
        },
      };
    },
  });

  return server;
}

// --- Stateful Streamable HTTP -------------------------------------------------
// Keep one transport (+ McpServer) per session, looked up by the `mcp-session-id`
// header. Statefulness is what carries the clientInfo from `initialize` through to
// later tool calls — so getClientVersion() and identify() both have a session.
const transports = {}; // sessionId -> transport

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : undefined);
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });

const PORT = Number(process.env.PORT ?? 3000);
http
  .createServer(async (req, res) => {
    if (new URL(req.url, `http://${req.headers.host}`).pathname !== "/mcp") {
      res.statusCode = 404;
      res.end("not found");
      return;
    }

    const sessionId = req.headers["mcp-session-id"];
    try {
      // Known session → reuse its server.
      if (sessionId && transports[sessionId]) {
        await transports[sessionId].handleRequest(req, res);
        return;
      }

      // New session → the client's first request is an `initialize` POST.
      if (req.method === "POST") {
        const body = await readBody(req);
        if (isInitializeRequest(body)) {
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            enableJsonResponse: true, // one JSON reply per POST (no long-lived SSE stream)
            onsessioninitialized: (sid) => (transports[sid] = transport),
          });
          transport.onclose = () => {
            if (transport.sessionId) delete transports[transport.sessionId];
          };
          await buildServer().connect(transport);
          await transport.handleRequest(req, res, body);
          return;
        }
      }

      // Unknown session id (e.g. the server restarted and dropped it) → 404 tells
      // the client to re-initialize. No id at all on a non-initialize → 400.
      res.statusCode = sessionId ? 404 : 400;
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: sessionId ? -32001 : -32000,
            message: sessionId ? "Session not found (re-initialize)" : "Expected initialize request",
          },
          id: null,
        })
      );
    } catch (err) {
      console.error("handler error", err?.stack ?? err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end();
      }
    }
  })
  .listen(PORT, () => console.error(`server.ready http://localhost:${PORT}/mcp`));

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    await posthog.shutdown();
    process.exit(0);
  });
}
