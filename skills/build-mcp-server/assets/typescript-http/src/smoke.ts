import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

import { app, handler } from "./server.js";

const listener = app.listen(0, "127.0.0.1");
await once(listener, "listening");

const { port } = listener.address() as AddressInfo;
const endpoint = new URL(`http://127.0.0.1:${port}/mcp`);
const transport = new StreamableHTTPClientTransport(endpoint);
const client = new Client(
  { name: "modern-smoke", version: "1.0.0" },
  { versionNegotiation: { mode: { pin: "2026-07-28" } } },
);

try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name),
    ["search_items"],
  );

  const rejectedOrigin = await fetch(new URL("/healthz", endpoint), {
    headers: { Origin: "https://attacker.example" },
  });
  assert.equal(rejectedOrigin.status, 403);

  const listen = await fetch(endpoint, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "subscriptions/listen",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "listen-rejected",
      method: "subscriptions/listen",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": {
            name: "modern-smoke",
            version: "1.0.0",
          },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
        notifications: { toolsListChanged: true },
      },
    }),
  });

  assert.match(listen.headers.get("content-type") ?? "", /application\/json/);
  const listenBody = (await listen.json()) as {
    error?: { code?: number; message?: string };
  };
  assert.equal(listenBody.error?.code, -32603);
  assert.equal(listenBody.error?.message, "Subscription limit reached");
} finally {
  await client.close();
  await new Promise<void>((resolve, reject) => {
    listener.close((error) => (error ? reject(error) : resolve()));
  });
  await handler.close();
}
