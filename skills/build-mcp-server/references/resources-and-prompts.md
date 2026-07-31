# Resources and Prompts

MCP servers expose three main server primitives:

- **Tools**: model-controlled actions and parameterized operations.
- **Resources**: application-controlled, read-only context identified by URI.
- **Prompts**: user-controlled message templates/workflows.

Most servers start with tools. Add resources or prompts only when they improve
the host/user experience or remove repeated prompt boilerplate.

## Contents

- Resources and URI templates
- Resource authorization, errors, caching, and notifications
- Prompts
- MRTR, completion, and primitive selection

## Resources

A resource is read-only data identified by an RFC 3986 URI. The host lists,
reads, and attaches it as context; it is not invoked like a tool.

Use resources for documents, files, schemas, logs, configuration, records, and
versioned content that remain useful independent of a single model-chosen call.

Use a tool when the operation has side effects, the model should supply
parameters at call time, or the result is an action response rather than
browsable context.

### Static resource

```typescript
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";

server.registerResource(
  "config",
  "config://app/settings",
  {
    title: "Application settings",
    description: "Current non-secret application configuration",
    mimeType: "application/json",
    cacheHint: { ttlMs: 60_000, cacheScope: "private" },
  },
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(publicConfig),
      },
    ],
  }),
);
```

Each returned content item repeats its URI and contains either UTF-8 `text` or
a base64 `blob`. Include an accurate MIME type.

### Resource template

Resource templates register a URI family. Use the template's list callback only
when concrete instances are enumerable; otherwise expose the template through
`resources/templates/list` without pretending to list an unbounded set.

```typescript
import {
  ProtocolError,
  ProtocolErrorCode,
  ResourceTemplate,
} from "@modelcontextprotocol/server";

function scalarTemplateVariable(
  value: string | string[],
  name: string,
): string {
  if (typeof value !== "string") {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      `${name} must expand to exactly one URI segment`,
    );
  }
  return value;
}

server.registerResource(
  "document",
  new ResourceTemplate("workspace://{workspaceId}/documents/{documentId}", {
    list: undefined,
  }),
  {
    title: "Workspace document",
    description: "Read one document from a workspace",
    mimeType: "text/markdown",
    cacheHint: { ttlMs: 30_000, cacheScope: "private" },
  },
  async (uri, { workspaceId, documentId }) => {
    const workspace = scalarTemplateVariable(workspaceId, "workspaceId");
    const document = scalarTemplateVariable(documentId, "documentId");
    const doc = await readAuthorizedDocument(workspace, document);
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: doc.body,
        },
      ],
    };
  },
);
```

Authorize every read. A URI or template variable is untrusted input, not an
access grant. SDK v2 template variables are `string | string[]`; narrow every
variable to the shape the operation expects and reject array expansions with
Invalid Params (`-32602`) before calling application code.

### File-backed resources

For filesystem resources:

1. decode and parse the URI according to its scheme
2. resolve the requested path to its real path, including symlinks
3. prove the real path remains inside the configured root
4. reject traversal, encoded traversal, symlink escapes, alternate separators,
   and unsupported file types
5. apply caller authorization before reading

Do not rely on the deprecated Roots feature as an access-control mechanism.
Pass explicit paths/resource URIs or configure an approved server root.

### Resource errors

For `2026-07-28`, a missing resource is a JSON-RPC Invalid Params error
(`-32602`). Do not return an empty `contents` array for a resource that does not
exist. Clients may still accept legacy `-32002` from an older server.

### Caching

Modern successful results from `resources/list`,
`resources/templates/list`, and `resources/read` require `ttlMs` and
`cacheScope`.

- Use `public` only when the response is identical across callers.
- Use `private` when authorization, tenant, workspace, or user changes the
  response.
- An SDK may default to `ttlMs: 0` and `private`; set an intentional policy when
  caching is useful.
- Treat every paginated page as independently cached.

### Change notifications

In `2026-07-28`, clients opt in with `subscriptions/listen`:

- `resourcesListChanged: true` for changes to the listed resource set
- `resourceSubscriptions: [uri, ...]` for updates to specific resources

The older `resources/subscribe` and `resources/unsubscribe` methods are not part
of the modern path. Publish through the SDK's modern notification router so
only matching subscription streams receive the event.

## Prompts

A prompt is a reusable message template exposed for explicit user selection,
often as a slash command or menu action.

Use prompts for workflows users deliberately invoke, such as summarizing a
document, reviewing a changelog, drafting a reply, comparing versions, or
explaining an error report.

```typescript
import * as z from "zod/v4";

server.registerPrompt(
  "summarize_document",
  {
    title: "Summarize document",
    description: "Create a concise summary of document text",
    argsSchema: z.object({
      text: z.string().describe("Document text to summarize"),
      max_words: z
        .string()
        .optional()
        .describe("Optional word limit, such as 100"),
    }),
  },
  ({ text, max_words }) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Summarize in ${max_words ?? "100"} words:\n\n${text}`,
        },
      },
    ],
  }),
);
```

Prompt handlers should build messages without mutating application state.
Validate all arguments. Prompt argument validation failures are protocol errors
(`-32602`), unlike recoverable tool execution failures.

Prompt messages may contain text, image, audio, resource links, or embedded
resources. Embed only small content that is always needed; prefer a resource
link for large or optional follow-up context.

`prompts/list` is cacheable and needs a deliberate cache scope. In the modern
protocol, prompt-list changes are delivered only to a client that opened
`subscriptions/listen` with `promptsListChanged: true`.

## MRTR and completion

`resources/read` and `prompts/get` may return `input_required` when additional
client input is genuinely needed. Apply the same capability checks, response
validation, and `requestState` protections described in `elicitation.md`.

Completion can suggest values for prompt arguments and resource template
variables. Add it only when users must choose among many valid values; keep
suggestions access-controlled and rate-limited.

## Decision table

| Goal                                                              | Primitive              |
| ----------------------------------------------------------------- | ---------------------- |
| Let the model perform an action or parameterized query            | Tool                   |
| Expose browsable/read-only context                                | Resource               |
| Expose a dynamic family of readable objects                       | Resource template      |
| Give users a reusable message workflow                            | Prompt                 |
| Ask for additional user input while resolving a supported request | MRTR elicitation       |
| Notify opted-in clients that lists/content changed                | `subscriptions/listen` |
