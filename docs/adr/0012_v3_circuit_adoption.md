# ADR-0012: V3 privacy-pool circuit adoption

**Date:** 2026-06-15
**Status:** Accepted
**Context:** Selecting the circuit version that the on-chain verifier and off-chain proof generation use for privacy-pool withdrawals

## Problem statement

Three circuit versions exist in this repository:

| Version | File | Key capability |
|---------|------|----------------|
| V1 | `circuits/stealth_attestation.circom` | Stealth attestation; not a pool withdraw circuit |
| V2 | `circuits/v2/stealth_reputation.circom` | Reputation leaf inclusion; not a pool withdraw circuit |
| V3 | `circuits/v3/privacy_pool_withdraw.circom` | Full pool withdraw with partial-spend and dual-tree proof |

The privacy pool contract (`contracts/privacy-pool`) must be wired to exactly
one Groth16 verifying key. The choice of circuit determines:

- The public signal vector the contract passes to the verifier.
- The proof semantics (what the proof attests to).
- The capability surface available to wallets.

## Context

V3 is the first circuit in this repository that is a privacy-pool withdrawal
circuit. V1 and V2 serve different protocol components (stealth attestation and
reputation, respectively) and are not candidates for pool withdrawal.

V3 proves the following simultaneously in one Groth16 proof:

1. **State-tree inclusion** — the spent commitment is a leaf of the pool state
   tree (root = `stateRoot`).
2. **Association-set inclusion** — the same commitment's label is a leaf of the
   ASP association tree (root = `aspRoot`), binding withdrawal to ASP approval.
3. **Partial withdrawal** — the prover spends `withdrawnValue ≤ value` and
   re-inserts the remainder as a new commitment, enforced by an in-circuit
   range check.
4. **Context binding** — `context = keccak256(recipient ∥ withdrawnValue ∥ fee
   ∥ relayer ∥ scope) mod r` is a public input, preventing front-running and
   fee manipulation without changing the proof.
5. **Nullifier non-reuse** — `nullifierHash = Poseidon(nullifier)` is exposed
   so the contract can record and check it.

### Public signal vector (order is load-bearing)

| Index | Signal | Encoding |
|-------|--------|----------|
| 0 | `withdrawnValue` | i128 as 32-byte big-endian |
| 1 | `stateRoot` | Poseidon hash output |
| 2 | `aspRoot` | Poseidon hash output |
| 3 | `nullifierHash` | Poseidon(nullifier) |
| 4 | `newCommitment` | Poseidon(remainder, label, newPrecommit) |
| 5 | `context` | keccak256(...) mod r |

## Decision

The privacy-pool contract and the `groth16-verifier` contract use the V3 circuit
and verifying key exclusively. The `verify_proof_v3` entry point on the verifier
contract accepts the six-signal `VerifyPublicInputsV3` struct; the pool contract
builds this struct and calls across via `env.invoke_contract`.

The V3 circuit is embedded in the repository at
`circuits/v3/privacy_pool_withdraw.circom` with depth 20 (2^20 = 1 M leaf
capacity, see ADR-0009 for the capacity guard). The verifying key is encoded via
`contracts/groth16-verifier/scripts/encode_vk.mjs` and pinned in
`artifacts/manifest.json`.

## Rationale

V3 uniquely satisfies the protocol requirements:

- **Dual-tree proof** is required for the association-set privacy model (ADR-0001):
  a withdrawal must prove membership in both the pool state tree (proving the
  deposit exists) and the ASP tree (proving the ASP approved it). No earlier
  circuit version provides both.
- **Partial withdrawal** reduces the need for users to deposit in exact preset
  amounts; users can withdraw a portion and keep the remainder in-pool. This
  makes preset-denomination anonymity sets (ADR-0009) practical without forcing
  users to deposit multiples of a denomination.
- **Context binding** (Tornado-style) protects against relayer front-running and
  fee substitution without additional on-chain logic.

The on-chain custody invariant (`total_withdrawals ≤ total_deposits`) is
enforced by the contract independently of the circuit, so a bad root cannot
mint unbacked funds even if the ASP misbehaves (see ADR-0001 and the
`privacy-pool` contract docs).

## Alternatives considered

- **V1/V2 circuits for pool withdrawal:** These circuits prove different things
  (stealth attestation, reputation inclusion) and are not compatible with the
  pool withdrawal protocol. Not applicable.
- **Simple membership-only circuit (no partial spend, no ASP tree):** Simpler
  to implement but would require users to spend entire notes, creating amount
  fingerprinting. Rejected — partial withdrawal is a stated protocol
  requirement.
- **Two separate proofs (state + ASP):** Splitting the dual-tree proof into two
  sequential verifications halves circuit constraint count but doubles the
  on-chain verification cost and doubles the proof size. Rejected.

## Consequences

### Positive
- Single Groth16 proof covers all withdrawal invariants.
- Partial withdrawals eliminate the need for strict same-denomination deposits
  as a user constraint.
- Context binding is in-circuit; the contract does not need extra signature checks.

### Negative
- Larger circuit (dual Merkle inclusion + range checks) means longer prover time
  in the browser (seconds on a modern laptop; potentially 10–30 s on low-end
  devices).
- Depth-20 tree limits the pool to ~1 M commitments; a depth upgrade requires a
  new verifying key and a contract upgrade.
- The signal order is load-bearing (positional decoding in the verifier contract
  and in `docs/PUBLIC_SIGNALS.md`); any future circuit change must follow the
  ABI versioning policy in ADR-0006.

## Implementation notes

- Circuit: `circuits/v3/privacy_pool_withdraw.circom`
- On-chain verifier entry point: `contracts/groth16-verifier/src/lib.rs`
  → `verify_proof_v3(proof_a, proof_b, proof_c, public_inputs: VerifyPublicInputsV3)`
- Pool contract integration: `contracts/privacy-pool/src/lib.rs` → `withdraw()`
- Public signals documentation: `docs/PUBLIC_SIGNALS.md`
- Fixture generation: `circuits/v3/scripts/gen-fixtures.ts`
- Verifying key encoding: `contracts/groth16-verifier/scripts/encode_vk.mjs`

## Related decisions

- [ADR-0001](0001_off_chain_published_roots.md) — dual-tree roots published
  off-chain that this circuit proves inclusion in.
- [ADR-0005](0005_soroban_privacy_pool.md) — the pool contract that calls
  `verify_proof_v3`.
- [ADR-0006](0006_event_abi_versioning_policy.md) — ABI versioning policy that
  governs any future change to the public signal vector.
- [ADR-0009](0009_deposit_presets.md) — deposit presets whose anonymity-set
  rationale is partially relaxed by partial-withdrawal support.

## References

- V3 circuit: `circuits/v3/privacy_pool_withdraw.circom`
- Groth16 verifier: `contracts/groth16-verifier/src/lib.rs`
- Privacy pool withdraw: `contracts/privacy-pool/src/lib.rs`
- Public signals spec: `docs/PUBLIC_SIGNALS.md`
