# Private and Public Edge networking architecture

Status: decision-ready research

Date: 2026-07-12

Wayfinder ticket: [Choose Private and Public Edge networking architecture](https://github.com/AojdevStudio/hermes-satellite/issues/29)

## Executive verdict

- **Private Mode:** use persistent **Tailscale Serve** on the Hermes machine to terminate tailnet HTTPS and reverse-proxy only to the loopback Dispatcher listener. Restrict the Serve destination with a least-privilege Tailscale grant. Do not bind the Dispatcher to a tailnet address and do not use Funnel.
- **Public Edge Mode:** use one **named Cloudflare Tunnel** running beside the Dispatcher. Publish one Access-protected hostname whose only ingress target is the loopback Dispatcher listener. End the ingress list with `http_status:404`.
- **Worker:** **not needed now.** Tunnel supplies public routing and origin reachability; Access supplies human and service authentication; the Dispatcher already owns protocol mapping, principal authorization, task semantics, streaming, and replay. Add a Worker only if a later ticket proves a required edge transformation that cannot safely live in Access, Tunnel, or the Dispatcher.
- **Fallback:** authenticated local loopback is always the break-glass path. A narrowly granted Tailscale Serve path may remain as the independent remote-admin path when Public Edge is primary. Never use an Access `Bypass` policy as fallback.

Both modes expose the **Dispatcher, never the Host listener**. The Satellite Verifier, full transcripts, bulk Evidence, repository data, terminal streams, and artifact bodies remain local as required by the [Connectivity Mode contract](../connectivity-mode-contracts.md#execution-and-verification-placement) and [Local Mode topology](../local-mode-topology.md#listener-boundary).

## Stable source facts

These are vendor capabilities and constraints, not Hermes Satellite design choices.

### Tailscale

- Tailscale Serve can proxy a service on `127.0.0.1` to an HTTPS name available only inside the tailnet. Serve removes spoofable incoming Tailscale identity headers and adds authenticated user identity headers at the local proxy; tagged-device traffic does not receive user identity headers. Tailscale explicitly recommends a localhost-only backend when those headers are trusted. [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve)
- `tailscale serve --bg` persists across a device reboot and Tailscale restart until explicitly disabled. [Serve CLI](https://tailscale.com/docs/reference/tailscale-cli/serve)
- Grants are deny-by-default and can select users, groups, devices, and tags as sources and destinations. Matching grants accumulate, so a narrow grant does not cancel a broader existing grant. [Grants syntax](https://tailscale.com/docs/reference/syntax/grants)
- A Tailscale connection carries both node identity and either user identity or tag identity. Tags are for non-human machines; applying a tag removes the device's user ownership. Serve user headers are unavailable for tagged sources, while optional Serve application-capability headers can represent grants for users or tagged nodes. [Tailscale identity](https://tailscale.com/docs/concepts/tailscale-identity) [Device tags](https://tailscale.com/docs/features/tags) [Application capabilities](https://tailscale.com/docs/features/access-control/grants/grants-app-capabilities)
- Tailscale first attempts direct encrypted device-to-device connections and can fall back to DERP relays. Coordination, DERP, and backend traffic require outbound HTTPS; direct paths generally use UDP. If the coordination server is unavailable, already established connections and cached policy can continue, but new connections, key refresh, revocation, and policy updates cannot. [Firewall ports](https://tailscale.com/docs/reference/faq/firewall-ports) [Control and data planes](https://tailscale.com/docs/concepts/control-data-planes)
- Tailscale Funnel is public to the Internet, not a Private Mode transport. [Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel)

### Cloudflare

- `cloudflared` establishes outbound-only connections from the origin to Cloudflare, so the origin needs no public IP or inbound firewall opening. A connector normally establishes four connections across at least two Cloudflare data centers. [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/) [Tunnel availability](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-availability/)
- A published application route maps a hostname to an explicit local HTTP service. Locally managed ingress rules are evaluated top-to-bottom and must end in a catch-all; `http_status:404` is a supported catch-all. Cloudflare provides commands to validate the configuration and test which rule a URL matches. [Tunnel configuration file](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/configuration-file/) [Published application protocols](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/protocols/)
- Access human sessions use signed application JWTs. Access also supports non-interactive `Service Auth` policies with a service token or mTLS. A service token normally uses `CF-Access-Client-Id` and `CF-Access-Client-Secret`; Access can also be configured for one header. [Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/) [Service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/) [Mutual TLS](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/mutual-tls-authentication/)
- Cloudflare sends an application token to the origin in `Cf-Access-Jwt-Assertion`. Cloudflare recommends validating that header's signature, issuer, and application audience at the origin rather than trusting the cookie. Signing keys rotate, with current keys published at the team-domain JWKS endpoint. [Validate Access JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
- Access can require device posture or Cloudflare One Client/WARP state in a human Allow policy. These checks are distinct from identity claims. [Access policy selectors](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/) [Device posture policy example](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/common-policies/)
- Tunnel supports WebSockets. For Server-Sent Events, the origin must send `Content-Type: text/event-stream` or `cloudflared` buffers the response. Long-lived paths can disconnect during maintenance or network changes and need application keepalives/reconnect behavior. [Tunnel FAQ](https://developers.cloudflare.com/cloudflare-one/faq/cloudflare-tunnels-faq/) [Tunnel common errors](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/troubleshoot-tunnels/common-errors/)
- Additional `cloudflared` replicas using one tunnel UUID add connector/host failover, but do not provide sticky routing or health-aware traffic steering. A request can reach any replica. [Tunnel availability and failover](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-availability/)
- Tunnel transport requires outbound TCP or UDP port `7844` for HTTP/2 or QUIC. [Tunnel with a firewall](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/)

## Recommended architecture

This section is recommendation and inference from the stable facts plus the repository's settled contracts.

### Exact listener and origin boundary

The installation retains exactly the two application listeners established by Local Mode:

| Listener | Bind | Reachable by | Never reachable by |
|---|---|---|---|
| Dispatcher | `127.0.0.1:<dispatcher-port>` | local clients, Tailscale Serve, `cloudflared` | direct LAN, tailnet-IP, or Internet socket |
| Host | `127.0.0.1:<host-port>` | Dispatcher with its internal scoped credential | Tailscale, `cloudflared`, Dispatch Surfaces |

No mode changes either bind to `0.0.0.0`, `::`, a LAN address, or a tailnet address. The edge daemons are adapters to the Dispatcher listener; they are not alternate Task Engines or Host gateways.

```text
Private Dispatch Surface
  -> tailnet HTTPS + grant
  -> Tailscale Serve on Hermes machine
  -> http://127.0.0.1:<dispatcher-port>

Public Dispatch Surface
  -> HTTPS hostname + Cloudflare Access
  -> named Tunnel
  -> cloudflared on Hermes machine
  -> http://127.0.0.1:<dispatcher-port>

Dispatcher
  -> scoped internal auth
  -> http://127.0.0.1:<host-port>
  -> Task Engine / Hermes / local Evidence
```

The origin hop can be HTTP because it never leaves loopback. Adding origin TLS would add certificate lifecycle without protecting a new network boundary. If `cloudflared` later moves off-host, this decision must be reopened; it must not reach the origin over unauthenticated LAN HTTP.

### Private Mode

1. Run Tailscale normally on the Hermes machine and each remote Dispatch Surface.
2. Configure persistent Serve HTTPS to proxy the whole Hermes Satellite dispatch surface to `http://127.0.0.1:<dispatcher-port>`.
3. Apply a narrow tailnet grant from the intended human users/groups and explicitly tagged non-human client devices to only the installation's Serve destination and HTTPS port. Audit broader existing grants because grants accumulate.
4. Keep human laptops user-owned. Use tags only for unattended service devices; do not retag a shared Hermes machine during install without checking the effect on its existing Tailscale identity and grants.
5. Do not use Funnel. Public exposure belongs only to Public Edge through Access.

Tailscale identity is the **network admission layer**, not final Task authorization. Serve user headers can seed or corroborate human principal mapping, but tagged agents have no user headers. Therefore every Dispatch Surface still presents its own Hermes Satellite credential and the Dispatcher scopes create/get/list/continue/cancel/Evidence operations to that principal. Optional Tailscale application-capability headers are deferred until the identity ticket proves they simplify policy rather than duplicate it.

### Public Edge Mode

Use one named Tunnel and one whole-hostname self-hosted Access application. The conceptual locally managed ingress is:

```yaml
ingress:
  - hostname: satellite.example.com
    service: http://127.0.0.1:<dispatcher-port>
  - service: http_status:404
```

The actual installer owns the hostname, UUID, credentials path, port, service supervision, and configuration format. The required properties are invariant: no wildcard hostname, no Host origin, no LAN origin, no unauthenticated sibling route, and a final rejecting catch-all.

Attach both of these Access policy classes to the application:

- **Human:** an IdP-backed `Allow` policy restricted to the intended User identities. Device posture/WARP may be added as a `Require` condition for managed devices, but is not mandatory for the base mode.
- **Machine:** a `Service Auth` policy naming the exact service token for each non-interactive Dispatch Surface or automation boundary. Do not use “any service token,” share one token across unrelated devices, or create a bypass policy.

The Dispatcher validates `Cf-Access-Jwt-Assertion` against the configured team issuer, application audience, expiry, and current JWKS before using any Access claim. It then authenticates the separate Hermes Satellite client credential and maps the combined result to a `PrincipalRef`. A caller-supplied name remains display metadata.

Use Cloudflare's normal two service-token headers, leaving the application's `Authorization` header available for Hermes Satellite authentication. A client that cannot send the two Cloudflare headers plus the application credential is not Public-Edge-compatible yet; do not add a Worker merely to conceal that client limitation. mTLS is a valid later alternative for fleets with an existing certificate issue/rotation/revocation system, but service tokens are the minimum AFK-safe v1 path.

### Why no Worker now

There is no missing edge function:

- Tunnel already terminates the public route and proxies HTTP/WebSockets to loopback.
- Access already handles human sessions, service credentials, optional mTLS/device posture, policy enforcement, and audit events.
- The Dispatcher must remain the authority for MCP/A2A mapping, principal authorization, Task Events, idempotency, and verification state.

A Worker now would create another deployable, credential boundary, failure domain, and streaming proxy without removing responsibility from the Dispatcher. Reconsider only for a demonstrated requirement such as an edge-only protocol transformation, request-size enforcement unavailable in the origin, or first-party web behavior that cannot be implemented safely in Access or the Dispatcher.

## MCP and A2A over HTTP and streaming

Both modes proxy the same Dispatcher HTTP adapter surface; they do not expose protocol-specific origins.

| Caller/path | Edge credential | Dispatcher credential | Streaming implication |
|---|---|---|---|
| Private human device | tailnet user/node identity allowed by grant | per-user/device Hermes principal | reconnect after path change; resume from Task Event cursor |
| Private AFK agent | tagged node allowed by grant | unique service/device Hermes principal | tagged nodes have no Serve user headers; never infer principal from a missing header |
| Public human/browser | Access IdP session cookie/JWT; optional posture | Hermes user/device session or credential | browser must preserve Access session; SSE endpoint emits `text/event-stream` |
| Public AFK agent | exact Access service token via two headers | unique Hermes service/device credential | credentials accompany each new request/stream; reconnect and cursor replay after disconnect |

Specific implications:

- MCP Streamable HTTP POST/GET and A2A HTTP operations remain normal HTTPS requests through the same edge. Edge success does not grant Task access.
- Any SSE response sets `Content-Type: text/event-stream`, emits bounded keepalives, and treats disconnect as delivery failure only. The durable Task Event is committed before delivery; the client reconnects with its cursor and does not resubmit the Task.
- If WebSockets are introduced later, authenticate and authorize the handshake, assume the connection can drop, and recover from durable Task Events. Do not advertise streaming capability until the selected client, Access policy, Tunnel, Dispatcher, reconnect, and replay path pass conformance.
- Service tokens identify an automation boundary, not a human. One token per Dispatch Surface or tightly coupled deployment keeps revocation and audit attribution meaningful. Hermes principal authorization remains finer-grained and controls task ownership and Evidence access.
- Full transcript and bulk Evidence endpoints are not published merely because the control protocol supports artifact references. Remote callers receive only explicitly authorized small excerpts; verification continues locally after the originating stream disconnects.

## Administration and fallback

The recovery order is deliberately short:

1. **Authenticated local loopback** is always available for health, credential repair, mode changes, and disable/rollback operations.
2. **Private Tailscale Serve** may remain enabled as a narrowly granted remote-admin path while Public Edge is primary. It reaches only the Dispatcher and uses independent Tailscale plus Hermes credentials.
3. Console/SSH recovery is installation/platform policy, not a Dispatch Surface. It must not expose the Host HTTP listener or reuse Dispatch credentials.

An alternate Cloudflare hostname, second Access policy, or second connector on the same machine is useful for diagnosis but is not independent fallback. Access `Bypass` removes the authentication boundary and is prohibited as break-glass.

## Availability and outbound-connectivity constraints

- **Private:** both endpoints need working Tailscale nodes and usable Internet connectivity for normal coordination/relay behavior. Direct UDP is preferred; DERP over outbound HTTPS is the fallback. An established path may survive a coordination outage using cached state, but enrollment, key refresh, revocation, and policy changes do not. The Hermes machine remains the single origin failure domain.
- **Public Edge:** the Hermes machine must reach Cloudflare on outbound TCP or UDP `7844`, and DNS, Access, Tunnel, `cloudflared`, Dispatcher, Host, and Hermes must all be healthy for a new remote dispatch. The four connector connections protect against individual connection/data-center loss, not host, origin, credential, DNS, Access-policy, or account failure.
- **Replicas:** do not add a replica in v1. A replica on the same machine does not remove the machine/origin failure domain. A replica on another machine cannot reach a loopback-only Dispatcher without creating a new private origin path. Design true multi-origin HA only if the product later supports replicated Dispatcher/Task state and non-loopback authenticated origin routing.
- **Streams:** neither edge promises an immortal connection. Cursor replay and idempotent commands are the HA mechanism; active streams may reconnect to a different relay, connector, or replica.

## Failure modes, validation, and rollback

| Failure | Expected signal | Validation / recovery |
|---|---|---|
| Dispatcher or Host down | local health distinguishes Dispatcher from Host-unavailable | restart supervised service; accepted Tasks recover from durable state |
| Tailscale grant denies caller | Serve name reachable or connection denied; no Dispatcher authorization event | inspect effective grants and source identity; never widen to the whole tailnet as a shortcut |
| Tailscale coordination/DERP path fails | Tailscale status shows offline/relay/path trouble | retain local access; restore outbound connectivity; client resumes by cursor |
| Access policy rejects caller | Access `403`/login challenge; no origin request | inspect Access auth log, exact policy, token expiry, IdP/posture result |
| Access passes but JWT/app auth fails | Dispatcher `401/403` with edge-vs-principal reason | verify issuer/audience/JWKS, then Hermes principal credential and task scope |
| Tunnel disconnected | Cloudflare `1033` / tunnel Down | restore `cloudflared`, outbound `7844`, credentials, DNS/tunnel route |
| Tunnel healthy but origin unavailable | Cloudflare `502`; `cloudflared` cannot reach origin | verify only `127.0.0.1:<dispatcher-port>` and Dispatcher health |
| SSE buffered or disconnected | delayed events or stream close | assert `text/event-stream`, keepalive, reconnect, cursor replay; do not duplicate create/continue |
| Credential compromised | unexpected Access/Tailscale/Dispatcher audit principal | revoke that edge credential and Hermes principal independently; existing Tasks remain intact |

Minimum pre-enable validation for either mode:

1. Prove the Host listener is reachable only from the Dispatcher and that no LAN, tailnet, Tunnel, or public path can address it.
2. Prove an admitted edge identity with an invalid Hermes credential is rejected, and a valid Hermes principal cannot read another principal's Task or Evidence.
3. Run create -> observe/stream -> disconnect -> cursor replay -> terminal Execution -> local verification -> Verified Result.
4. Interrupt the edge path during execution and prove Task Outcome does not change and retry does not create a duplicate Task.
5. Confirm remote responses omit full transcript, repository, terminal, verifier scratch, and bulk Artifact/Evidence bodies by default.

Public Edge additionally validates the Tunnel ingress configuration and URL match, confirms the final `404`, tests human and service policies separately, validates origin JWT rejection for missing/wrong issuer/audience/expired tokens, and confirms there is no inbound public port. Private additionally tests an unauthorized tailnet member and a tagged AFK device separately.

Rollback is reachability-only: use local loopback to disable Serve or the Tunnel route/service, revoke mode-specific credentials, and restore the previous Dispatch Surface endpoint. Do not alter installation identity, Task IDs, Task/Event/Evidence stores, verifier policy, or Host credentials. Keep the old external mode disabled only after the replacement passes the authenticated end-to-end smoke required by the [mode-switching contract](../connectivity-mode-contracts.md#mode-switching).

## Deferred to later tickets

This decision fixes transport shape, not the following policy/lifecycle details:

- **Identity and authorization:** exact `PrincipalRef` schema; Cloudflare `sub`/email/service-token and Tailscale user/node/tag mapping; pairing; ownership; token issuance, storage, rotation, expiry, revocation, and recovery; browser session design; principal-scoped Task/Evidence policy.
- **Security invariants:** threat model for a compromised host, local same-user processes, edge-header trust, account takeover, device loss, audit retention, rate/abuse controls, and the product's assurance ceiling.
- **Installation/lifecycle:** supported Tailscale and `cloudflared` versions/platforms; safe detection of existing grants/tags/Serve/Tunnel/Access config; exact prompts and API permissions; launchd/systemd units; secret-store integration; upgrades; certificate/JWKS caching; uninstall and automated rollback.
- **Web Dispatch Surface:** browser CORS/session behavior and whether first-party web supports these user-owned modes.
- **Future HA:** replicated Dispatcher/Task state, authenticated non-loopback origin routing, Cloudflare Load Balancing, or multi-node Tailscale Services. None is required for the single-installation v1 contract.
