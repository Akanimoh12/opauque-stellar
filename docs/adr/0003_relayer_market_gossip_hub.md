# ADR-0003: Relayer market with shared gossip hub

**Date:** 2026-06-15  
**Status:** Accepted  
**Context:** Privacy-pool withdrawal submission without linking wallet to relayer

## Problem statement

Privacy pool withdrawals require someone to submit the transaction to the blockchain. The wallet cannot submit directly (withdrawal proof leaks the withdrawal amount and recipient on-chain). A relayer submits on behalf of the user and earns a fee.

**Options:**
1. User directly contacts a relayer operator's endpoint (leaks wallet IP to relayer)
2. User relays through a trusted gateway (introduces an intermediary; gateway knows wallet-to-relayer linkage)
3. Multiple wallets post blind job advertisements to a shared gateway; relayers bid without knowing which wallet is which (gateway-mediated but job advertisements are anonymous)

Option 1 is simple but leaks network metadata. Option 2 centralizes the metadata linkage. Option 3 is complex but preserves some anonymity.

## Context

The relayer market removes the last linking step from pool withdrawal. After the wallet generates a proof (local), the relayer is the only actor that knows:
- The withdrawal is happening
- The amount being withdrawn
- The recipient address

A wallet connecting directly to a relayer's endpoint leaks:
- The wallet's IP address to the relayer
- Temporal correlation between the wallet connection and the withdrawal
- The relayer now knows which wallet address submitted the job

A shared gateway can observe:
- All job postings and relayer bids
- IP addresses of connecting wallets
- But not which wallet posted which job (if anonymized)

## Decision

Wallets post blind job advertisements to a shared gossip hub. Relayers inspect the hub, bid without identifying wallets, and receive encrypted payloads via the same hub.

**How it works:**
1. Wallet creates an escrowed job in the relayer registry (on-chain)
2. Wallet publishes a blind job advert to the hub (off-chain), containing only a job ID and encrypted metadata
3. Relayers query the hub, see the job ID, and fetch the on-chain job details
4. Relayers bid if credentials match (registered, enough stake)
5. Wallet selects a bid and sends an encrypted payload to the hub
6. The winning relayer retrieves and decrypts the payload, submits the transaction

The hub sees job postings and bids but not the linkage between wallet identity and bids.

## Rationale

A shared gossip hub provides:

1. **Anonymity at the application level:** The gateway does not know which wallet posted which job (both use the same endpoint)
2. **Decentralized relayer competition:** Relayers compete in an open marketplace without manual operator selection
3. **No relayer linkage at submission:** The wallet connects to the hub (not a relayer directly), and the relayer only sees an encrypted payload

The tradeoff is:

1. **Gateway trust model:** The gateway operator can observe all job metadata and bids. Wallets must trust the gateway to not log or leak this data.
2. **Off-chain coordination:** Job advertisements are off-chain; wallets must refresh to detect new bids.
3. **Complexity:** Wallets and relayers must implement the gossip protocol; operators must run a reliable hub.

Compared to direct wallet-to-relayer:
- **More private:** No direct IP leakage to relayers
- **More complex:** Requires shared infrastructure
- **More resilient:** Single relayer downtime does not block all withdrawals

## Alternatives considered

- **Direct relayer selection:** User manually configures a relayer endpoint. Simple but leaks wallet IP to relayer. Rejected for privacy.
- **Decentralized relayer discovery (DHT):** Use a peer-to-peer DHT instead of a shared hub. Distributed but adds latency and requires client to run a DHT node. Deferred to future optimization.
- **Proxy/anonymizer:** Wallets route through a separate anonymizer service. Adds another intermediary; creates a new trust and centralization point. Rejected.
- **Relayers publish bids directly:** Wallets discover relayers via contract events. No hub needed, but wallets must track all relayers and their credentials on-chain. Expensive in storage. Rejected.

## Consequences

### Positive
- Wallets do not leak IP to relayers
- Relayers compete in an open market
- Wallets can select from multiple relayers without manually configuring endpoints
- No on-chain polling of relayer state by each wallet

### Negative
- Gateway sees all job advertisements (metadata leakage)
- Gateway must be reliable; if down, wallets cannot submit withdrawals
- Added latency: wallets wait for bids instead of submitting directly
- Coordination overhead: both parties must monitor the hub

### Unknown
- Feasibility of a decentralized hub (multiple operators, consensus on job state)
- Performance characteristics at scale (throughput, latency, storage)
- Privacy implications of repeated withdrawal patterns to the same gateway

## Implementation notes

**Shared hub (current — HTTP):**

The hub is implemented as an HTTP service (not libp2p). This was an explicit
simplicity choice: HTTP works through firewalls and NAT without client-side
routing machinery, and the gossip transport abstraction is designed so a
libp2p or pubsub backend can replace the in-memory HTTP transport later
without protocol-level changes. The current gateway topic is
`opaque/stellar/jobs/v1` over HTTPS.

- REST endpoints for job posting, bid submission, and payload retrieval
- In-memory storage of recent jobs and bids, pruned after expiry
- Rate limiting to prevent spam
- Job metadata is blinded on the wire; the hub sees job IDs and bid commitments
  but not the withdrawal amount or recipient (those travel in the encrypted
  payload)

See [ADR-0008](0008_http_gossip_over_libp2p.md) for the full rationale for
choosing HTTP over libp2p and the conditions under which the transport
decision should be revisited.

**Wallet-side:**
1. Create on-chain escrow in the relayer registry
2. Generate a random job ID
3. POST blind advert to the hub with job ID
4. Poll the hub for bids on this job ID
5. Select a bid
6. POST encrypted payload to the hub (retrievable by winning relayer ID)

**Relayer-side:**
1. Poll (HTTP GET) the hub for new job advertisements
2. For each job, fetch the on-chain details from the relayer registry
3. If credentials match, post a bid with a cryptographic commitment
4. If selected, retrieve the encrypted payload from the hub
5. Decrypt (using X25519 private key) and submit the transaction

## Related decisions

- [ADR-0001](0001_off_chain_published_roots.md): Off-chain published roots are verified by clients; gossip hub is another off-chain coordination layer
- [ADR-0004](0004_non_custodial_wallet.md): Wallet must be non-custodial; relayer cannot change withdrawal context

## References

- Technical overview: "Relayer Market" section
- Relayer registry contract: `contracts/relayer-registry`
- Relayer implementation: `relayer/` directory
- Running guide: `docs/running-relayer.md`
