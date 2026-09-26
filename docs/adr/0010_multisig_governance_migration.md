# ADR-0010: Multisig governance migration

**Date:** 2026-07-27
**Status:** Accepted
**Context:** Issue #589 — replace single-key admin accounts with on-chain N-of-M threshold governance

## Problem statement

The registry contracts (`attestation-engine-v2`, `privacy-pool`,
`reputation-verifier`, `relayer-registry`) each store an `admin` address that
can perform privileged operations (publish roots, pause deposits/withdrawals,
update configuration). Before this change that address was a single Stellar
account held by the deployer. A single-key admin is a single point of failure:
key compromise or loss locks the entire protocol.

## Context

Stellar accounts natively support N-of-M signing via `SetOptions`. Pointing a
registry's `admin` at a multi-sig Stellar account would work without new code,
but the threshold and signer set live off-chain in account configuration. An
auditor cannot query "what threshold governs this registry?" from the contract;
they must trust the operator configured the account correctly.

Soroban allows a contract address to satisfy `require_auth()` for its own
direct invocations. A purpose-built threshold contract can therefore replace the
single-key account as the `admin` with no changes to the registry contracts
themselves.

## Decision

Deploy a `multisig-admin` Soroban contract (contracts/multisig-admin) and point
each registry's `admin` field at a deployed instance. The contract enforces an
on-chain N-of-M threshold with the following properties:

- Minimum 2 signers, maximum 20 signers.
- Threshold must be ≥ 2 and ≤ N (no 1-of-N or single-signer costumes).
- Two proposal types: `propose_call` (generic contract invocation) and
  `propose_rotation` (signer-set change).
- Proposer's approval is recorded automatically; execution fires automatically
  when distinct approvals reach the threshold.
- Signer rotation uses the same propose/approve/threshold path as any other
  action — no redeployment required for key rotation within the set.
- Proposal IDs are SHA256(counter), stored in persistent storage with a
  ~120-day TTL to prevent archival expiry stranding pending proposals.

## Rationale

Making threshold and signer set first-class, queryable contract state
(`get_config`, `get_signers`, `get_threshold`) means any caller or auditor can
verify the governance structure on-chain, not just trust an operator's
off-chain configuration.

The decision to use two distinct entry points (`propose_call` /
`propose_rotation`) instead of a single generic `propose(ProposalAction)`
is forced by Soroban's type system: `Val` (Soroban's any-type) cannot be a
field inside a `#[contracttype]`-derived enum, so a generic proposal type
cannot be represented. Two concrete entry points with typed parameters are
equivalent in generality and avoid the problem entirely.

## Alternatives considered

- **Native Stellar multi-sig account (`SetOptions`):** Works without new code
  but stores governance configuration off-chain, invisible to on-chain auditors.
  Rejected because on-chain queryability is a stated acceptance criterion.
- **Single-key with social key rotation procedure:** Does not meet the N-of-M
  acceptance criteria. Rejected.
- **DAO-style contract with token-weighted voting:** Over-engineered for a
  small operator group; introduces token governance complexity. Rejected.

## Consequences

### Positive
- Threshold governance is auditable on-chain; no off-chain trust required.
- Key rotation within the signer set does not require contract redeployment.
- Any registry admin operation now requires threshold consensus by construction.

### Negative
- Admin operations require M approvals across M signers before execution,
  adding coordination latency for time-sensitive operations (e.g. emergency
  pause).
- The hard minimum threshold of 2/2 means a solo operator cannot use this
  contract without recruiting a second key.
- Proposal TTL (~120 days) means long-running proposals expire if not acted upon.

### Mitigation for emergency operations
The timelocked withdrawal-pause mechanism in the privacy pool (1-day delay
between a pause request and activation, see `WITHDRAWAL_PAUSE_TIMELOCK_LEDGERS`)
already assumes an admin operation can take hours; the multisig threshold latency
is acceptable within that window. Deposit pauses take effect immediately and do
not require a separate emergency path.

## Implementation notes

- Contract: `contracts/multisig-admin/src/lib.rs`
- The registries' `admin.require_auth()` calls need no modification; Soroban
  satisfies `require_auth()` for a contract's own direct invocations
  automatically (`execute_call` in `multisig-admin` calls `env.invoke_contract`
  which is a direct call from the multisig's own execution context).
- Event ABI: proposal and approval events follow the per-contract versioning
  policy in ADR-0006 (`EVENT_VERSION` constant, topic `(Symbol("Proposed"), 1)`
  / `(Symbol("Approved"), 1)`).
- The `multisig-admin` contract itself is administered by its own signer set;
  signer rotation is a proposal type, not a special upgrade path.

## Related decisions

- [ADR-0005](0005_soroban_privacy_pool.md) — privacy pool contract whose
  `admin` is migrated to multisig.
- [ADR-0006](0006_event_abi_versioning_policy.md) — event ABI versioning that
  governs the proposal/approval event shapes.
- [ADR-0007](0007_reputation_publisher_trust_model.md) — production shape
  of the reputation publisher requires the publisher key to be scoped under
  this multisig governance model.

## References

- Multisig contract: `contracts/multisig-admin/src/lib.rs`
- Test suite: `contracts/multisig-admin/src/test.rs`
- Issue: #589
