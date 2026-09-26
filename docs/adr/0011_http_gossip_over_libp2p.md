# ADR-0011: HTTP gossip transport over libp2p

**Date:** 2026-06-15
**Status:** Accepted
**Context:** Transport layer for the relayer market gossip hub (ADR-0003)

## Problem statement

ADR-0003 decided to route relayer job advertisements through a shared gossip
hub. It left the wire transport unspecified. The two candidates evaluated during
implementation were:

1. **HTTP** — standard REST over HTTPS; works through firewalls and NAT without
   client-side routing machinery.
2. **libp2p** — peer-to-peer networking stack with gossipsub, DHT discovery, and
   native NAT traversal; used by several privacy and decentralisation protocols.

## Context

The gossip hub serves two categories of participant:

- **Browser wallets** — run in a sandboxed JavaScript environment with no
  raw TCP or UDP access; all outbound connections must be HTTP(S) or
  WebSocket.
- **Relayer nodes** — server-side Node.js processes with full network access.

libp2p's gossipsub transport requires a persistent peer connection and a DHT
bootstrap node or a well-known relay. The browser-side libp2p implementation
(`@libp2p/websockets`) works in theory but adds ~400 KB to the frontend bundle,
requires a WebSocket-capable libp2p relay (a separate always-on service), and
has historically had compatibility issues across browser vendors for anything
beyond a direct WebSocket.

HTTP has no such constraints: any wallet can POST to a known HTTPS URL with zero
additional dependencies.

## Decision

The gossip hub is implemented as an HTTP service. The gateway topic
`opaque/stellar/jobs/v1` is namespaced to allow future transport migration but
is today carried over HTTPS REST.

The relayer and wallet codebases define a transport abstraction (not a concrete
libp2p or HTTP class) so the backing transport can be swapped without protocol
changes. The running-relayer documentation explicitly notes:

> "The gossip transport is structured so a libp2p or pubsub backend can replace
> the in-memory transport later."

The decision to choose HTTP now does not close the door to libp2p later.

## Rationale

1. **Browser compatibility is a hard constraint.** The wallet must be able to
   submit jobs without installing browser extensions or relying on a WebSocket
   relay. HTTP satisfies this with zero additional dependencies.
2. **Simplicity of operation.** A single HTTPS endpoint is trivially deployable
   behind a CDN or load balancer. A libp2p relay requires a dedicated bootstrap
   node and DHT configuration.
3. **The privacy model is the same.** The gossip hub operator can observe job
   advertisements in both transports. The anonymity properties of ADR-0003
   (wallet IP hidden from relayers) hold equally well with HTTP — the wallet
   sends to the hub, not to the relayer directly.
4. **Reversibility.** The transport abstraction means switching to libp2p later
   does not require a protocol-level change to the job advertisement or bid
   formats.

## Conditions for revisiting

This decision should be revisited if:

- The gossip hub operator becomes a meaningful centralisation or censorship
  risk (a libp2p gossipsub network with multiple bootstrap nodes would reduce
  this).
- Browser libp2p matures to the point where a WebSocket relay is no longer
  required and bundle size is acceptable.
- Regulatory or operational pressure makes a single HTTPS endpoint
  unacceptable.

## Alternatives considered

- **libp2p gossipsub from day one:** Provides better decentralisation but
  requires a browser-compatible relay service as an additional dependency,
  adds significant bundle weight, and offers no practical privacy improvement
  over HTTP for the current threat model. Deferred, not rejected — see
  conditions above.
- **Nostr relays:** Pubsub-over-WebSocket with multiple independent relays.
  Compatible with browsers, offers better decentralisation than a single HTTP
  endpoint. Deferred — Nostr's event model would need mapping to the job
  advertisement protocol.
- **Encrypted broadcast (e.g. Waku):** Privacy-preserving pubsub. Adds
  significant complexity; overkill for the current scale. Deferred.

## Consequences

### Positive
- Browser wallets connect with zero additional dependencies.
- Hub is deployable on standard HTTPS infrastructure.
- Transport is swappable via abstraction layer.

### Negative
- Single HTTPS endpoint is a centralisation point; hub operator sees all job
  advertisements.
- No DHT-based peer discovery; wallets must know the hub URL from the
  deployment manifest.

## Implementation notes

- Hub service: `relayer/` workspace (HTTP gateway exposing job, bid, and
  payload endpoints).
- Topic namespace: `opaque/stellar/jobs/v1`.
- Production gateway (testnet): `https://g-stelar-relayer.opaque.cash`.
- The hub URL is read from the deployment manifest; wallets do not hardcode it.

## Related decisions

- [ADR-0003](0003_relayer_market_gossip_hub.md) — the gossip hub protocol this
  ADR provides transport for.

## References

- Running guide: `docs/running-relayer.md`
- Relayer workspace: `relayer/`
