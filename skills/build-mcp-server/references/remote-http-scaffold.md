# Modern Remote Streamable HTTP Scaffold (TypeScript)

This scaffold targets protocol revision `2026-07-28` with the official
TypeScript SDK v2 split packages. It is intentionally not a v1
`StreamableHTTPServerTransport` example: that API serves the 2025-era protocol.

Read `protocol-eras.md` first. Before copying imports, confirm that the selected
package versions expose `createMcpHandler` and advertise `2026-07-28` support.

## Contents

- Install and ESM project configuration
- Server and serving entry
- Listen and legacy compatibility choices
- Authorization
- Handler, outer-composition, and raw-wire tests
- Stdio and other SDKs

## Install

Inspect package tags, then install one internally consistent v2 line:

```bash
npm view @modelcontextprotocol/server dist-tags
npm view @modelcontextprotocol/node dist-tags
npm view @modelcontextprotocol/express dist-tags

npm install @modelcontextprotocol/server \
  @modelcontextprotocol/node \
  @modelcontextprotocol/express \
  express zod
npm install -D typescript @types/express @types/node tsx
```

The split packages were stable at `2.0.0` when this reference was checked. Do
not combine `@modelcontextprotocol/sdk` v1 imports with the v2 scaffold.

For a copyable project with exact dependency versions plus compile and smoke
scripts, start from `../assets/typescript-http/`. Keep those pins until an
upgrade is separately verified.

Use ESM explicitly. `npm init -y` alone creates a CommonJS package, which does
not run the top-level-await client smoke test below.

Minimal `package.json` fields:

```json
{
  "type": "module",
  "scripts": {
    "check": "tsc --noEmit",
    "start": "tsx src/server.ts"
  }
}
```

Minimal `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
```

## `src/server.ts`

```typescript
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

const ITEMS = [
  {
    id: "item_001",
    title: "First item",
    body: "Example item for smoke tests.",
  },
  { id: "item_002", title: "Second item", body: "Another example item." },
];

function buildServer() {
  const server = new McpServer(
    { name: "my-service", version: "0.1.0" },
    {
      instructions: "Use search_items to discover IDs before calling get_item.",
      cacheHints: {
        "tools/list": { ttlMs: 60_000, cacheScope: "public" },
      },
    },
  );

  server.registerTool(
    "search_items",
    {
      title: "Search items",
      description:
        "Search item titles and bodies by keyword. Returns up to limit matches with IDs for get_item.",
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .describe("Keywords to match in item titles and bodies"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe("Maximum matches; defaults to 10 and cannot exceed 50"),
      }),
      outputSchema: z.object({
        results: z.array(
          z.object({ id: z.string(), title: z.string(), body: z.string() }),
        ),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ query, limit }) => {
      const needle = query.toLowerCase();
      const results = ITEMS.filter(
        (item) =>
          item.title.toLowerCase().includes(needle) ||
          item.body.toLowerCase().includes(needle),
      ).slice(0, limit);

      const output = { results };
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    "get_item",
    {
      title: "Get item",
      description:
        "Fetch one item by ID. Use search_items first when the ID is unknown.",
      inputSchema: z.object({
        id: z
          .string()
          .regex(/^item_[0-9]{3}$/)
          .describe("Item ID returned by search_items, such as item_001"),
      }),
      outputSchema: z.object({
        id: z.string(),
        title: z.string(),
        body: z.string(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ id }) => {
      const item = ITEMS.find((candidate) => candidate.id === id);
      if (!item) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Item ${id} was not found. Use search_items to find valid IDs.`,
            },
          ],
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(item) }],
        structuredContent: item,
      };
    },
  );

  return server;
}

// The handler creates a fresh McpServer for every HTTP request. This primary
// scaffold is modern-only and deliberately refuses subscriptions/listen rather
// than opening a long-lived SSE response with no application notification path.
const handler = createMcpHandler(buildServer, {
  legacy: "reject",
  maxSubscriptions: 0,
});

// This factory installs JSON parsing plus localhost Host and Origin guards.
const app = createMcpExpressApp();
const nodeHandler = toNodeHandler(handler);

app.all("/mcp", (req, res) => {
  void nodeHandler(req, res, req.body);
});

app.get("/healthz", (_req, res) => res.json({ ok: true }));

const port = Number(process.env.PORT ?? 3000);
app.listen(port, "127.0.0.1", () => {
  console.error(`MCP server listening on http://127.0.0.1:${port}/mcp`);
});
```

For a public bind, configure `allowedHosts` and `allowedOrigins` on the framework
factory. A request without `Origin` normally comes from a non-browser client and
may pass; a present Origin must be checked. Do not expose a private-data or
mutating server before adding authorization.

### Enabling `subscriptions/listen`

`createMcpHandler` installs a listen router independently of advertised
application capabilities. Omitting a subscription capability does not disable
that router. Keep `maxSubscriptions: 0` when the server has no notification
path, and test that a listen request returns an in-band error without opening
SSE.

To support listen, replace that rejection with a real `ServerEventBus`, set a
bounded positive subscription limit and keepalive policy, publish application
events to the bus, propagate cancellation, and test fan-out and reconnect. The
default in-memory bus reaches only one process or isolate; a multi-instance
deployment needs a shared bus.

### Deliberate dual-era variant

Only enable legacy serving for a required, tested client:

```typescript
const handler = createMcpHandler(buildServer, {
  maxSubscriptions: 0,
  // Omitting legacy: "reject" enables the SDK's stateless legacy path.
});
```

Keep sessionful legacy HTTP behind a separate legacy handler. Do not add
session state to the modern factory.

## What the serving entry owns

On the modern path, application code should not manually add wire bookkeeping.
A conforming SDK serving entry owns:

- `server/discover`
- per-request protocol version, identity, and capability envelopes
- required `resultType` on results
- required `ttlMs`/`cacheScope` defaults on cacheable results
- `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`, and `Mcp-Param-*`
  validation for JSON-RPC request POSTs
- JSON versus request-scoped SSE response handling
- modern transport cancellation behavior
- `subscriptions/listen` routing, which the application must explicitly reject
  or back with a real event bus

The application owns tool/resource/prompt definitions, access control,
authorization, upstream calls, domain errors, application state, and any MRTR
state codec.

## Add authorization

When OAuth protects the server, the MCP server is the protected resource, not
necessarily the authorization server. Verify the bearer token before the MCP
handler and pass the verified principal as the SDK's `authInfo`. Publish
path-aware OAuth Protected Resource Metadata and a useful `WWW-Authenticate`
challenge.

Do not treat the simple comparison of an environment token as a production
multi-user OAuth implementation. See `auth.md`.

## Test the actual modern path

Use the official v2 client in-process for a fast handler-level test:

```typescript
import assert from "node:assert/strict";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

const transport = new StreamableHTTPClientTransport(
  new URL("http://test.local/mcp"),
  {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  },
);

const client = new Client(
  { name: "test-client", version: "1.0.0" },
  { versionNegotiation: { mode: { pin: "2026-07-28" } } },
);

await client.connect(transport);
const tools = await client.listTools();
assert.deepEqual(
  tools.tools.map((tool) => tool.name),
  ["search_items", "get_item"],
);

const result = await client.callTool({
  name: "search_items",
  arguments: { query: "item" },
});
assert.equal(result.isError, undefined);

await client.close();
await handler.close();
```

This test intentionally calls `handler.fetch` directly. It proves the MCP
handler path, but bypasses the deployed Express Host, Origin, and authorization
composition. Also start the actual app on an ephemeral loopback port and send
HTTP requests through that socket. At minimum assert:

- allowed and rejected Host/Origin values
- unauthenticated and authorized access when auth is enabled
- malformed JSON and unexpected content types never become HTML responses
- the `/mcp` method/status behavior and the separate health endpoint
- proxy/header normalization exactly as deployed

Send a raw pinned-modern `subscriptions/listen` request as well. With this
minimal scaffold it must complete with a JSON-RPC error and `Content-Type` must
not be `text/event-stream`. If listen is enabled, invert the assertion and test
stream cancellation, capacity, fan-out, and reconnect.

Also run wire/conformance tests for missing `_meta`, unsupported version,
missing or mismatched request-POST MCP headers, malformed input, and cache
scope. Test every server response mode you enable. A JSON-only server is valid;
MCP clients must accept both JSON and request-scoped SSE. High-level SDK APIs may
consume wire-only fields such as `resultType`, so conformance checks are still
needed.

For a mutation, also abort the response after the handler commits and retry with
a new JSON-RPC ID. Verify application-level idempotency or recovery; modern SSE
responses are not resumable and a lost result does not prove the mutation was
rolled back.

Use a current MCP Inspector build that explicitly supports the target revision.
An Inspector connection that silently falls back to a 2025-era handshake does
not prove modern conformance.

## Stdio equivalent

Use the same `buildServer` factory with the v2 stdio serving entry:

```typescript
import { serveStdio } from "@modelcontextprotocol/server/stdio";

serveStdio(buildServer);
console.error("MCP server listening on stdio");
```

Never write logs to stdout. The modern stdio process is still stateless at the
protocol layer and may interleave unrelated requests.

## Other SDKs

Before using FastMCP or another framework for a modern server, verify all of the
following in the installed version: no initialization dependency, per-request
metadata, `server/discover`, `resultType`, cache hints, MRTR,
`subscriptions/listen`, modern HTTP headers, and no session/GET/resumability
assumptions. If any are absent, either choose a supporting SDK or label the
server as targeting the older protocol revision.
