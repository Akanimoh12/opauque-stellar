# ADR-0001: Off-chain published roots for pool state and association sets

**Date:** 2026-06-15  
**Status:** Accepted  
**Context:** Privacy pool state verification without smart contract root storage

## Problem statement

The privacy pool requires users to prove their note exists in an approved association set and in the current pool state tree. Users generate zero-knowledge proofs locally that bind to a Merkle root. But where does this root come from?

**Options:**
1. Store the root on-chain in a smart contract and have users read it
2. Publish the root off-chain and have users verify it matches public events

On-chain storage is simple but creates a bottleneck: every pool state change requires a contract write, adding latency and cost. Off-chain publication allows the Association Set Provider (ASP) to publish independently and requires users to verify correctness.

## Context

The privacy pool separates deposit identity from withdrawal identity. To prove withdrawal is legitimate, users must prove:
1. Their note is in the approved association set (curated by the ASP)
2. Their note is in the current pool state tree (derived from public events)

The ASP decides policy (which deposits are approved) and publishes roots. In the MVP, the policy is "approve all," so the ASP is primarily a liveness service.

Requiring on-chain root storage would mean:
- Every pool state change triggers a contract write
- Scalability issues on high-throughput deployments
- Centralized reliance on a single contract for root data

## Decision

Roots are published off-chain and independently verified by clients.

**Association-set root:** The ASP maintains a list of approved deposits and publishes a Merkle root. Users verify the root is valid by:
- Checking it against other published roots (consensus detection)
- Verifying their note hashes to the published root

**State root:** The ASP reconstructs the pool state tree from public pool events and publishes the current root. Users verify by:
- Rebuilding the tree locally from Horizon event history
- Confirming their rebuild matches the published root before proof generation
- If mismatch, the wallet alerts the user and does not generate the proof

## Rationale

Off-chain publication decouples root management from contract writes. This allows:

1. **Independent ASP operation:** The ASP can update roots on its own schedule, not limited by Soroban throughput
2. **Client verification:** Each wallet verifies roots against public events; no trust in ASP signature alone
3. **Scalability:** High-frequency deposits do not trigger contract writes until withdrawal
4. **Flexibility:** Policy changes (approve-all to selective) are quick to deploy without contract upgrade

The tradeoff is increased client-side complexity: wallets must rebuild Merkle paths and verify roots. This is manageable because:
- Merkle path reconstruction is deterministic and auditable
- Verification happens offline before submission
- Clients have cryptographic proof the root is valid (or detection of a mismatch)

## Alternatives considered

- **On-chain root storage:** Every deposit/withdrawal writes the new root. Simpler for wallets, but creates contract bottleneck and adds tx cost to every pool operation. Rejected because it reduces scalability.
- **Quorum of ASP nodes:** Multiple ASP instances publish roots; clients verify majority consensus. Added complexity and does not scale to decentralized ASP. Deferred to future work.
- **Ephemeral proofs (no root):** Prove directly against recent events without intermediate root. Massive proof size and latency. Rejected.

## Consequences

### Positive
- Wallets detect misbehaving ASP (published root ≠ public events) before losing funds
- High-frequency pool operations do not block on contract writes
- ASP can be operated independently; no contract upgrade needed for policy changes
- Scalable to high-throughput deployments

### Negative
- Wallets must rebuild Merkle trees locally (adds latency to proof generation)
- More complex to audit; requires understanding both ASP and client logic
- ASP downtime blocks new withdrawals (cannot generate proofs without roots)
- Users must trust their RPC node for accurate event history

### Unknown
- Feasibility of decentralized ASP with independent root publishers
- Performance impact on mobile and resource-constrained wallets

## Implementation notes

**Client-side:**
- Wallets cache ASP-published roots and refresh periodically
- Before proof generation, rebuild Merkle paths and verify against published roots
- Alert user if rebuild fails (ASP misbehavior or RPC fork detected)

**ASP-side:**
- Maintain a database of approved deposits
- On each pool event, update the association-set and state tree roots
- Publish roots to a public HTTP endpoint and blockchain (e.g., memo field)
- Publish an audit log of policy decisions for transparency

## Related decisions

- [ADR-0003](0003_relayer_market_gossip_hub.md): Relayer market also relies on off-chain data (job advertisements) with on-chain verification

## References

- Technical overview: "Association Set Provider" section
- Merkle tree reconstruction: [merkletreejs library](https://github.com/OpenZeppelin/merkle-tree)
