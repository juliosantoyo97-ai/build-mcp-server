# Target Client Compatibility

Read this for a remote Streamable HTTP server used by real MCP hosts,
especially when OAuth or dual-era support is involved.

Protocol compliance is necessary but not sufficient. Hosts differ in the
protocol revisions they support, negotiation behavior, OAuth discovery and
registration, callback URLs, token storage/refresh, extension support, tool
rendering, and whether server instructions affect tool selection.

Record the exact host version and test date. Host behavior is version-sensitive.
A vendor announcement that support is rolling out across a product family is
not evidence that every web, desktop, CLI, connector, or embedded surface has
shipped the same negotiation and extension behavior.

## Client inventory

For each target host, verify:

- supported protocol revisions and whether it sends `server/discover` or
  legacy `initialize`
- modern Streamable HTTP support: POST, per-request `_meta`, required headers,
  every response mode the server enables; the client itself must accept both
  JSON and request-scoped SSE responses
- auth mode: none, closed-system bearer, OAuth, or a combination
- OAuth Protected Resource Metadata and authorization-server discovery paths
- registration priority: pre-registration, CIMD, deprecated DCR, or user-entered
  client details
- callback URL and OIDC `application_type`
- requested scopes and RFC 8707 `resource` behavior
- issuer validation and credential isolation when the AS changes
- refresh, reconnect, scope step-up, revoke, and re-auth behavior
- form/URL elicitation through MRTR
- subscriptions, caching, structured output, icons, and extensions
- how it displays tool titles, descriptions, parameters, annotations, and
  server instructions

## Protocol-era compatibility

Test the modern path independently:

- `server/discover` succeeds
- the client selects `2026-07-28`
- requests carry the required body metadata and HTTP headers
- no `initialize`, MCP session ID, GET stream, DELETE session, or SSE replay is
  used
- elicitation becomes an input-required result followed by a retry
- change events arrive only after `subscriptions/listen`

If the host only supports the 2025 era, decide whether it is important enough
to justify a dual-era server. A dual-era SDK entry should keep lifecycle and
transport behavior isolated. Do not claim modern support because the same tool
handler happens to work after a legacy initialization.

For dual-era clients, distinguish normative modern evidence from the selected
SDK's classifier. In `@modelcontextprotocol/client@2.0.0`, a valid discovery
result or well-formed `-32022` proves modern support, while `-32020` and
`-32021` can still lead to legacy fallback. The client also defaults to legacy
unless `versionNegotiation` is explicit. Use pinned-modern and raw-wire tests
for conformance, then separately verify intended automatic fallback and that
the selected era is cached only for the correct process or origin.

## OAuth discovery

For a protected MCP endpoint, serve OAuth Protected Resource Metadata and point
the `WWW-Authenticate` challenge at it. For an endpoint such as
`https://mcp.example.com/mcp`, the path-aware RFC 9728 location is:

```text
https://mcp.example.com/.well-known/oauth-protected-resource/mcp
```

That document names one or more authorization-server issuers. Discover AS
metadata from the selected issuer, including path insertion when the issuer has
a path. Do not assume the MCP endpoint path is also the authorization-server
issuer path.

If a client has a static `Authorization` header or bearer-token setting, it may
skip interactive OAuth discovery. Test OAuth without bearer configuration and
test the closed-system bearer path separately.

## Registration

Prefer pre-registration when a relationship already exists, then Client ID
Metadata Documents for an open ecosystem. Dynamic Client Registration is
deprecated in `2026-07-28`; retain it only when required by a tested host.

If supporting CIMD:

- validate exact client ID/metadata URL equality and redirect URIs
- bound outbound fetches and defend against SSRF/DNS rebinding
- restrict redirects, response size, content type, and latency
- cache according to HTTP metadata without trusting stale identity forever

If supporting DCR compatibility:

- require the appropriate native/web `application_type`
- bind the registration to the authorization-server issuer
- never reuse credentials at another issuer

Normalize every registration mechanism into one internal client-policy record
so authorization and consent do not depend on how the client registered.

## Refresh, reconnect, and scope step-up

Do not stop after the first successful browser login.

Test this sequence:

1. connect and authorize
2. call one read tool
3. trigger a tool that needs a broader scope and complete step-up
4. wait past access-token expiry
5. restart/reconnect the host and call a read tool
6. revoke the grant and verify the next call produces a clean re-auth path

If operating the authorization server, issue short-lived access tokens and
rotate refresh tokens for public clients. Keep refresh state bound to the
client, subject, authorization-server issuer, MCP resource, scopes, and grant.
Reject explicit resource/audience mismatches.

Do not advertise `offline_access` as a protected-resource scope. A client that
wants refresh tokens negotiates that with the authorization server.

## Tool UX

Models call the schema the host exposes:

- provide discovery tools so users need not know opaque IDs
- describe required parameters, formats, and defaults
- use accurate annotations, while enforcing actual policy server-side
- include optimistic-concurrency fields for writes when the upstream supports
  them
- return IDs and versions needed for the next call
- keep `tools/list` order deterministic
- keep the first part of server instructions self-contained

Verify that the host consumes `structuredContent` or can use the text fallback,
and that it does not discard important pagination or truncation information.

## Smoke matrix

For every target host/version:

- modern discovery/version selection or explicitly documented legacy fallback
- SDK-specific modern-evidence/fallback handling and cached-era invalidation
- unauthenticated endpoint returns a useful 401 challenge
- Protected Resource Metadata and AS metadata validate
- supported registration mechanism works
- browser login, consent, PKCE, resource, and issuer validation succeed
- one discovery/read flow works without hand-supplied opaque IDs
- one write works only with the required scope and confirmation policy
- input validation returns a useful tool execution error
- MRTR form/URL elicitation works or fails with a clear capability error
- cache scope does not leak caller-specific lists/resources
- change subscriptions work and reconnect cleanly, or listen is explicitly
  rejected without opening SSE
- access-token expiry, refresh, scope step-up, revoke, and re-auth work
- closed-system bearer fallback works separately, if supported
