# Embedded Desktop MCP Servers

Use this shape when an Electron or other desktop application already has an
in-process service layer and should expose that same behavior to MCP hosts.
Read `protocol-eras.md` first; embedding changes the process topology, not the
wire protocol.

## Recommended shape

```text
desktop UI
    |
existing in-process service or local API
    |
thin MCP adapters + one registry/factory
    |                         |
loopback Streamable HTTP      optional stdio shim
```

The existing service remains the source of truth for validation,
authorization, persistence, transactions, and events. MCP handlers translate
protocol arguments and results; they do not recreate business logic or open a
second database ownership path.

## Choose the host boundary

Prefer an embedded loopback HTTP listener when:

- the desktop process already owns the service and its lifecycle
- one or more local hosts can connect to an HTTP endpoint
- the app needs a stable authorization, Origin, or event-stream boundary
- spawning a second process would duplicate state or coordination

Add a stdio shim only for hosts that require it. The shim should construct the
same registry/factory and call the same service methods. Do not maintain a
second set of tool definitions or validation rules.

Use a separate stdio process instead when process isolation is the desired
security boundary or the desktop process cannot safely own a listener.

## Listener lifecycle and discovery

- Bind to `127.0.0.1` and, if supporting IPv6, explicitly bind and test `::1`.
- Prefer an ephemeral port unless the host requires a fixed port.
- Publish the chosen port through a protected app-owned discovery mechanism,
  not a world-readable file containing a reusable bearer credential.
- Start the listener after the service is ready and close it during orderly app
  shutdown. Treat partial startup and app reloads as normal failure cases.
- Keep the health endpoint separate from the MCP endpoint.
- Do not use a hidden HTTP cookie or process-global map as a protocol session.

## Loopback is still a security boundary

A malicious local process or browser page can reach loopback. At minimum:

- validate Host and Origin before MCP dispatch
- authenticate the connecting host with a short-lived, app-issued credential or
  another deliberate local trust mechanism
- bind authorization to the verified desktop user/workspace and re-check it on
  every call
- never accept identity, workspace, or filesystem authority from tool arguments
  alone
- reject unexpected methods, content types, and non-loopback interfaces
- keep secrets out of URLs, command-line arguments, logs, and MCP results

If OAuth protects the listener, apply the same protected-resource and audience
rules as any remote MCP server. OAuth is not mandatory merely because the
transport is HTTP; the chosen local trust mechanism must still be explicit and
tested.

## Events and `subscriptions/listen`

Adapt the service's existing event source to the SDK `ServerEventBus`. Set a
bounded subscription count, propagate stream cancellation, and remove listeners
when a client disconnects. If the desktop app has no notification path, reject
`subscriptions/listen` explicitly; capability advertising alone does not turn
off the official SDK's listen router.

An in-memory bus is usually correct for one desktop process. If multiple
processes can handle calls or emit events, use a shared bus or route all event
traffic through the owning process.

## Tests

Test both the shared application behavior and each serving adapter:

- the same tool inputs produce equivalent domain results over HTTP and stdio
- the outer HTTP composition rejects bad Host/Origin/auth before dispatch
- listener startup, port discovery, reload, collision, and shutdown are clean
- filesystem/workspace confinement is enforced by the service layer
- unauthenticated local processes cannot call private tools
- listen either fails without opening SSE or receives only authorized events
- disconnecting a host cancels requests/subscriptions and releases listeners
- the modern path is pinned to `2026-07-28` in SDK tests and verified raw on the
  wire; any legacy shim is tested separately

For Electron, keep listener and credential ownership in the main process. A
renderer should reach privileged behavior through the app's validated IPC or
service API, not receive unrestricted filesystem or network authority merely
because MCP is present.
