#!/usr/bin/env node
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { track } from "@posthog/mcp";
import { z } from "zod";

const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

const daysBack = (n) => {
  const out = [];
  const today = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
};

const buildServer = () => {
  const server = new McpServer({
    name: "dummy-mcp",
    version: "0.1.0",
  });

  server.tool(
    "get_trends",
    "Return a mocked trends time series for a given event over the last N days.",
    {
      event: z.string().describe("Event name, e.g. 'pageview' or 'signup'"),
      days: z.number().int().min(1).max(90).default(7).describe("Lookback window in days"),
      interval: z.enum(["day"]).default("day").describe("Bucket interval"),
    },
    async ({ event, days, interval }) => {
      console.error("get_trends called", { event, days, interval });
      const labels = daysBack(days);
      const series = labels.map((date) => ({ date, value: rand(50, 5000) }));
      const result = {
        event,
        interval,
        total: series.reduce((s, p) => s + p.value, 0),
        series,
      };
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
      console.error("get_funnel called", { steps, days });
      let count = rand(5000, 20000);
      const breakdown = steps.map((name, i) => {
        if (i > 0) count = Math.floor(count * (Math.random() * 0.5 + 0.3));
        return { step: i + 1, name, count };
      });
      const top = breakdown[0].count;
      const result = {
        days,
        overall_conversion: +(breakdown.at(-1).count / top).toFixed(4),
        steps: breakdown.map((s) => ({
          ...s,
          conversion_from_top: +(s.count / top).toFixed(4),
        })),
      };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  track(server, {
    apiKey: "phc_.....",
    context: true,
    enableAITracing: true,
    host: "http://localhost:8010",
    posthogOptions: {
      flushAt: 1,
    },
  });

  return server;
};

const PORT = Number(process.env.PORT ?? 3000);
http
  .createServer(async (req, res) => {
    const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
    if (pathname !== "/mcp") {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    console.error("http req", req.method, req.url, {
      accept: req.headers.accept,
      "content-type": req.headers["content-type"],
    });

    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
      console.error("http req done", req.method, req.url, "->", res.statusCode);
    } catch (err) {
      console.error("http handler error", err?.stack ?? err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end();
      }
    }
  })
  .listen(PORT, () => {
    console.error(`server.ready http://localhost:${PORT}/mcp`);
  });
