# ADR-0005: Soroban smart contracts for privacy pool enforcement

**Date:** 2026-06-15  
**Status:** Accepted  
**Context:** On-chain state transitions and proof verification for privacy pool

## Problem statement

The privacy pool must:
- Accept deposits and hold commitments
- Verify zero-knowledge proofs from withdrawal requests
- Record nullifiers to prevent double-spending
- Enforce custody invariants (only authorized users withdraw)
- Process quickly and reliably

**Options:**
1. On-chain smart contract (Soroban): State transitions, proof verification, nullifier storage all on-chain
2. Off-chain coordination: Trusted operators enforce rules; on-chain is a fallback for disputes
3. Hybrid: Some state on-chain, some off-chain with periodic settlement

On-chain (Option 1) is simple and trustless but adds cost and latency. Off-chain (Option 2) is fast but requires trust. Hybrid (Option 3) is complex but could optimize for both trust and performance.

## Context

The Stellar blockchain added Soroban, a smart contract platform that enables:
- Custom token creation and asset management
- Proof verification via specialized contracts
- State trees and complex logic
- Access to Horizon for event reading

Stellar's native design (no general smart contracts until Soroban) meant privacy protocols previously had to choose between:
- Native Stellar escrow (limited, no proof verification)
- Completely off-chain with minimal on-chain footprint (high trust required)

Soroban enables a middle ground: put core custody and proof verification on-chain, but keep scanning and matching off-chain.

## Decision

The privacy pool is implemented as a Soroban smart contract that:
1. Accepts deposits and records commitments
2. Verifies Groth16 proofs of withdrawal eligibility
3. Records nullifiers to prevent note reuse
4. Enforces custody invariants
5. Releases XLM to the withdrawal recipient (or relayer on behalf of recipient)

**Core functions:**
- `deposit()`: User deposits XLM, adds a commitment to the pool, emits a deposit event
- `withdraw()`: User submits a proof, contract verifies it, records the nullifier, releases XLM

## Rationale

Soroban provides:

1. **Trustless proof verification:** Anyone can submit a withdrawal; the contract verifies the proof cryptographically
2. **Immutable state:** Nullifiers and commitments are stored on-chain; no way to forge or erase them
3. **Non-custodial:** Contract enforces rules, not an operator. Users do not have to trust a backend service
4. **Stella integration:** Soroban is part of Stellar's consensus; full security guarantees

The tradeoff is:
1. **Higher cost:** Deposits and withdrawals pay Soroban fees (vs. free off-chain alternatives)
2. **Latency:** Proofs are verified on-chain; slower than off-chain verification
3. **Soroban dependency:** Protocol depends on Soroban's security and availability (part of Stellar consensus, so acceptable)

Compared to off-chain:
- **More trustless:** No reliance on operator to honestly enforce rules
- **More expensive:** Every withdrawal pays a Soroban fee
- **More durable:** Rules are enforced by consensus, not by a single operator

## Alternatives considered

- **Native Stellar escrow only:** Use Stellar's built-in escrow and timelock operations. No proof verification capability. Rejected because privacy pool requires proof checking.
- **Off-chain with on-chain settlement:** Operators collect withdrawals, settle to Stellar periodically. Requires trust in operators during the settlement window. Rejected for custody risks.
- **Private ledger (sidechain):** Run privacy pool on a separate blockchain, bridge to Stellar. Adds complexity and creates a new consensus requirement. Rejected in favor of Soroban.
- **Simple custody contract:** Accept deposits and release on-chain, but do not verify proofs (users submit external proofs). Rejected because it couples proof verification to a backend service.

## Consequences

### Positive
- Withdrawals are trustless; contract logic enforces all invariants
- Nullifiers are immutable; double-spending is cryptographically impossible
- Users do not have to trust an operator service
- Stellar consensus secures the privacy pool
- Transparent: anyone can audit the contract code and state

### Negative
- Deposits and withdrawals incur Soroban fees (added cost)
- Proof verification latency (seconds, not milliseconds)
- Soroban contract upgrades require coordination (if a bug is found)
- Larger proofs consume more contract storage

### Unknown
- Long-term cost of Soroban fees as usage scales
- Feasibility of amortizing proof verification across multiple withdrawals
- Hardware wallet support for Soroban transactions (still evolving)

## Implementation notes

**Contract structure:**
- Privacy pool contract (`contracts/privacy-pool`): Deposit, withdraw, and nullifier logic
- Groth16 verifier contract (`contracts/groth16-verifier`): Standalone proof verification
- Relayer registry contract (`contracts/relayer-registry`): Tracks relayers and jobs

**State management:**
- Commitments stored as a ledger entry (vector)
- Nullifiers stored as a ledger entry (map, for O(1) lookup)
- Events emitted for deposits and withdrawals (for off-chain indexing)

**Fee model:**
- Deposits pay for contract storage and execution
- Withdrawals pay for proof verification and nullifier recording
- Fee amounts set via contract parameters (upgradable)

**Proof format:**
- Groth16 v3 privacy pool circuit
- Public inputs: commitment, nullifier, recipient, amount, fee, relayer
- Proof size: ~400 bytes (compact)

## Related decisions

- [ADR-0001](0001_off_chain_published_roots.md): Roots are published off-chain; contract does not store them (reduces on-chain storage)
- [ADR-0002](0002_browser_wasm_scanner.md): Scanning is off-chain; contract only verifies proofs
- [ADR-0003](0003_relayer_market_gossip_hub.md): Relayer market is off-chain; contract only enforces custody

## References

- Soroban documentation: https://developers.stellar.org/learn/smart-contract-paradigm
- Privacy pool contract: `contracts/privacy-pool`
- Groth16 verifier: `contracts/groth16-verifier`
- Relayer registry: `contracts/relayer-registry`
- Technical overview: "Privacy Pool" section
