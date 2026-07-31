# Elicitation in Modern MCP

Elicitation lets a server request additional user input while resolving
`tools/call`, `resources/read`, or `prompts/get`.

In protocol revision `2026-07-28`, elicitation uses the Multi Round-Trip Request
(MRTR) pattern:

1. The client sends the original request.
2. The server returns `resultType: "input_required"` with one or more embedded
   `elicitation/create` requests.
3. The client presents UI, gathers the user's action/input, and retries the
   original method with a new JSON-RPC ID.
4. The retry includes `inputResponses` and the exact `requestState` when the
   server supplied one.
5. The handler re-validates everything and either completes or returns another
   input-required result.

Each retry carries only that round's `inputResponses`. For a multi-round flow,
encode prior accepted values and an explicit phase in protected `requestState`
or durable server storage; do not infer the phase from whichever response keys
happen to be present.

Do not send a direct server-to-client JSON-RPC request on the modern path. Older
SDK calls such as `ctx.mcpReq.elicitInput(...)` belong to the 2025 era.

## Contents

- Capability gate
- Form mode and destructive confirmation
- URL mode
- Protected `requestState`
- Response actions and checklist

## Capability gate

Client elicitation support is declared on each request in:

```json
{
  "_meta": {
    "io.modelcontextprotocol/clientCapabilities": {
      "elicitation": {
        "form": {},
        "url": {}
      }
    }
  }
}
```

An empty `elicitation: {}` means form support only for backward compatibility.
Never embed a mode the client did not declare. A conforming server/SDK should
return `MissingRequiredClientCapability` (`-32021`) rather than attempting an
unsupported interaction.

## Form mode

Use form mode only for non-secret data such as:

- confirmation
- short text, email, URI, date, or date-time
- bounded number or integer
- boolean
- single-select enum
- multi-select string enum

The requested schema is a flat object. Properties may be primitive fields or
the supported string-enum array shape. Nested objects, arrays of objects,
arbitrary arrays, and unrestricted JSON Schema features are not supported.
Defaults are allowed. Use `title` and `description` for clear UI.

Form mode must not request passwords, API keys, access tokens, payment
credentials, or other secrets.

### TypeScript SDK v2 shape

```typescript
import type {
  CallToolResult,
  InputRequiredResult,
} from "@modelcontextprotocol/server";
import {
  acceptedContent,
  createRequestStateCodec,
  inputRequired,
  inputResponse,
  McpServer,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";

const confirmationSchema = z.object({
  confirm: z.boolean().meta({ title: "Confirm deletion" }),
});

type DeleteState = { operation: "delete_item"; id: string };

const requestStateKey = process.env.REQUEST_STATE_HMAC_KEY;
if (!requestStateKey) {
  throw new Error("REQUEST_STATE_HMAC_KEY is required");
}

const stateCodec = createRequestStateCodec<DeleteState>({
  key: requestStateKey, // At least 32 random bytes; share across server instances.
  ttlSeconds: 300,
  bind: (ctx) => {
    const auth = ctx.http?.authInfo;
    const subject = auth?.extra?.subject;
    if (!auth || typeof subject !== "string") {
      throw new Error("verified user principal is required");
    }
    return `${ctx.mcpReq.method}\0${auth.clientId}\0${subject}`;
  },
});

const server = new McpServer(
  { name: "destructive-example", version: "1.0.0" },
  { requestState: { verify: stateCodec.verify } },
);

server.registerTool(
  "delete_item",
  {
    description: "Permanently delete one item after explicit confirmation.",
    inputSchema: z.object({ id: z.string() }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    },
  },
  async ({ id }, ctx): Promise<CallToolResult | InputRequiredResult> => {
    const view = inputResponse(ctx.mcpReq.inputResponses, "confirm_delete");

    if (view.kind === "missing") {
      return inputRequired({
        inputRequests: {
          confirm_delete: inputRequired.elicit({
            message: `Delete ${id}? This cannot be undone.`,
            requestedSchema: confirmationSchema,
          }),
        },
        requestState: await stateCodec.mint(
          { operation: "delete_item", id },
          ctx,
        ),
      });
    }

    if (view.kind !== "elicit") {
      return {
        isError: true,
        content: [{ type: "text", text: "Invalid confirmation response." }],
      };
    }

    if (view.action === "decline" || view.action === "cancel") {
      return {
        content: [
          {
            type: "text",
            text:
              view.action === "decline"
                ? "Deletion declined. No changes were made."
                : "Deletion cancelled. No changes were made.",
          },
        ],
      };
    }

    const state = ctx.mcpReq.requestState<DeleteState>();
    if (state?.operation !== "delete_item" || state.id !== id) {
      return {
        isError: true,
        content: [
          { type: "text", text: "Confirmation does not match this deletion." },
        ],
      };
    }

    const response = acceptedContent(
      ctx.mcpReq.inputResponses,
      "confirm_delete",
      confirmationSchema,
    );

    if (response?.confirm !== true) {
      return {
        content: [
          {
            type: "text",
            text: "Deletion was not confirmed. No changes were made.",
          },
        ],
      };
    }

    await deleteItem(id);
    return { content: [{ type: "text", text: `Deleted ${id}.` }] };
  },
);
```

The precise helper names are SDK-version-sensitive. The invariant is the wire
flow: input-required result, client retry, untrusted response validation. The
sample's `authInfo.extra.subject` is application-defined: populate it only from
a verified token, or replace it with the application's canonical verified
principal/tenant identifier.

## URL mode

Use URL mode for sensitive or out-of-band interactions:

- entering an upstream API key or password on the server's trusted domain
- authorizing the MCP server to call a third-party service
- payment or account-connection flows
- a long interaction that belongs in a browser

The embedded request includes only `mode: "url"`, a message, and a URL. The
sensitive data never returns through MCP.

```json
{
  "resultType": "input_required",
  "inputRequests": {
    "connect_upstream": {
      "method": "elicitation/create",
      "params": {
        "mode": "url",
        "message": "Connect your upstream account.",
        "url": "https://mcp.example.com/connect?flow=opaque-public-reference"
      }
    }
  },
  "requestState": "integrity-protected opaque state"
}
```

`elicitationId` and `notifications/elicitation/complete` are not part of
`2026-07-28`. Correlate retries using server storage or `requestState`.

The client response `action: "accept"` means the user consented to opening the
URL; it does not prove the browser flow completed. On retry, the server checks
its own state. If the flow is still pending, it may return another
input-required result.

### Safe URL rules

- Use HTTPS outside development.
- Never put credentials, tokens, PII, or a pre-authenticated capability URL in
  the elicitation URL.
- Make the connect page authenticate the browser user.
- Prove the browser user is the same verified principal that initiated the MCP
  request before accepting credentials or grants.
- Bind correlation state to the principal, purpose, original operation, and a
  short expiry.
- The client must show the full URL/domain and obtain consent; it must not
  prefetch or inspect the flow.

URL mode for third-party OAuth is separate from OAuth authorization of the MCP
client to the MCP server. The MCP server is the OAuth client of the third-party
service and stores the resulting upstream tokens itself.

## `requestState`

Use `requestState` when the server needs context across MRTR retries. It is an
opaque string to the client but attacker-controlled input when it returns.

Protect it with HMAC or authenticated encryption when tampering can influence
authorization, resource access, or business logic. Bind and verify:

- the authenticated principal/tenant
- the originating method and a digest of relevant arguments
- the current workflow phase
- a short expiry
- a nonce or server-side consumed marker when single-use is required

A signature prevents modification but does not provide confidentiality. Keep
secrets and sensitive user data out of signed plaintext state. A multi-instance
deployment needs a shared verification key or shared state store.

Ask for confirmation before an irreversible side effect. If work must begin
before the input round, make it resumable and idempotent because the retry has a
new JSON-RPC ID and may land on another server instance.

## Response actions

| Action    | Meaning                                                     |
| --------- | ----------------------------------------------------------- |
| `accept`  | User submitted the form or consented to the URL interaction |
| `decline` | User explicitly rejected the request                        |
| `cancel`  | User dismissed or abandoned the interaction                 |

Validate accepted form content against the original schema. Handle decline and
cancel explicitly. Do not endlessly re-prompt a user who declined a destructive
action.

## When not to use elicitation

Do not use elicitation for:

- ordinary required arguments known before the original call
- rich custom interfaces better served by MCP Apps or a web application
- background account setup that can happen before tool use
- secrets in form mode
- methods other than `tools/call`, `resources/read`, or `prompts/get`

If data is required every time, make it an argument. If it is durable account
configuration, prefer OAuth or a settings/setup flow.

## Checklist

- [ ] Client declared support for the requested mode on this request.
- [ ] Handler returns input-required; it does not push a JSON-RPC request.
- [ ] Retry uses a new JSON-RPC ID and validates untrusted responses.
- [ ] Multi-round flows carry prior answers and phase in protected state.
- [ ] Form schema stays within the restricted elicitation subset and contains no secrets.
- [ ] URL contains no sensitive/pre-authenticated data and opens only with user consent.
- [ ] Browser identity is bound to the verified MCP principal.
- [ ] `requestState` is integrity-protected, principal/operation-bound, and short-lived.
- [ ] Decline, cancel, incomplete URL flow, expiry, tampering, and replay are tested.
