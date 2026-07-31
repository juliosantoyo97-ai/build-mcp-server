import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

const ITEMS = [
  { id: "item_001", title: "First item" },
  { id: "item_002", title: "Second item" },
];

export function buildServer(): McpServer {
  const server = new McpServer(
    { name: "modern-example", version: "1.0.0" },
    {
      instructions: "Use search_items to find item IDs.",
      cacheHints: {
        "tools/list": { ttlMs: 60_000, cacheScope: "public" },
      },
    },
  );

  server.registerTool(
    "search_items",
    {
      title: "Search items",
      description: "Search item titles by keyword and return matching IDs.",
      inputSchema: z.object({
        query: z.string().min(1).describe("Keyword to match in item titles"),
        limit: z.number().int().min(1).max(50).default(10),
      }),
      outputSchema: z.object({
        results: z.array(z.object({ id: z.string(), title: z.string() })),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ query, limit }) => {
      const needle = query.toLowerCase();
      const output = {
        results: ITEMS.filter((item) =>
          item.title.toLowerCase().includes(needle),
        ).slice(0, limit),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );

  return server;
}

export const handler = createMcpHandler(buildServer, {
  legacy: "reject",
  maxSubscriptions: 0,
});

export const app = createMcpExpressApp();
const nodeHandler = toNodeHandler(handler);

app.all("/mcp", (req, res) => {
  void nodeHandler(req, res, req.body);
});

app.get("/healthz", (_req, res) => res.json({ ok: true }));
