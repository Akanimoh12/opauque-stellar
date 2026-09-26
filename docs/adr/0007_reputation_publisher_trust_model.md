# ADR-0007: Reputation publisher trust model

**Date:** 2026-06-15
**Status:** Accepted
**Context:** Off-chain liveness service for the V2 reputation Merkle tree

## Problem statement

The `reputation-verifier` Soroban contract checks Groth16 proofs that a leaf is
included in a Poseidon Merkle tree whose root it stores on-chain. The contract
stores the root, but nothing automatically writes it: the tree must be built
off-chain because leaf pre-images contain private holder data (`stealth_pk`,
`trait_data_hash`) that a passive on-chain indexer cannot derive.

Someone must collect leaf commitments from holders, build the tree, and push the
root to the contract. The question is: what is the trust boundary of that
service?

## Context

The V2 leaf commitment is:

```
Poseidon(stealth_pk, schema_id, issuer_pk_x, trait_data_hash, nonce)
```

`stealth_pk` and `trait_data_hash` are private; only the holder knows them. An
indexer watching chain events cannot derive the leaf. Holders or their wallet
clients must submit the precomputed commitment to the publisher.

The publisher therefore receives commitments but not the underlying private
values. It builds the tree deterministically from the ordered commitment list,
compares the result to the on-chain root, and calls `update_merkle_root` only
when they differ.

## Decision

The reputation publisher is a trusted-liveness service with a defined, bounded
trust assumption:

1. **It cannot forge proofs.** The Groth16 verifier contract validates every
   proof cryptographically; a holder must know the actual private inputs to
   produce a valid proof regardless of what root the publisher posts.

2. **It can censor.** Omitting a leaf from the tree makes the corresponding
   holder unable to generate a valid Merkle inclusion proof. This is the
   publisher's sole meaningful power over holders.

3. **It cannot steal funds.** The reputation protocol does not custody assets;
   exclusion affects credential presentation, not balance.

4. **The dataset hash is the accountability mechanism.** The publisher posts a
   `dataset_hash = SHA256(ordered_leaf_list)` alongside every root. Any third
   party who receives the same leaf set can independently recompute the tree and
   verify the root matches. Holders who submitted a leaf and find it absent from
   the published dataset can detect and prove censorship.

5. **For testnet/MVP, the publisher uses the verifier admin key** (`PUBLISHER_SECRET`).
   Production deployments must migrate the root-publisher role to a dedicated
   key or the `multisig-admin` contract so the signing key is narrowly scoped
   to `update_merkle_root` (see ADR-0010).

## Rationale

The alternative — having holders push roots directly — requires either granting
every holder contract write access (not acceptable) or a separate on-chain
voting/aggregation mechanism (over-engineered for the reputation use case). A
single liveness publisher with a narrow, auditable trust surface is the
practical minimum.

The dataset hash makes the trust assumption auditable: the publisher's output is
reproducible by anyone with the leaf list, so the service is accountable even
though it is not trustless.

## Alternatives considered

- **On-chain leaf insertion:** Contract builds the tree on every submission.
  Rejected — a single Poseidon hash costs ~40 M CPU instructions; Stellar's
  per-transaction budget is 100 M (same constraint that drove ADR-0001 for the
  pool state tree).
- **Multi-publisher quorum:** Multiple independent publishers vote on the root.
  Deferred — adds coordination complexity disproportionate to the current
  censorship risk, which is low given the non-custodial nature of the protocol.
- **Holder-signed attestations as censorship proof on-chain:** Holders submit
  a signed "I was excluded" claim. Not viable without a proof system to verify
  the claim without revealing the private inputs.

## Consequences

### Positive
- Holders can independently verify their leaf is included via the dataset hash.
- Publisher compromise does not endanger funds (no custody).
- Simple, auditable service boundary.

### Negative
- A censored holder cannot present reputation credentials until the publisher
  includes their leaf (or a new publisher is deployed).
- MVP admin key doubles as publisher key — must be split before mainnet.

## Implementation notes

The publisher is the `publisher/` workspace. Key files:

- `publisher/src/publish.ts` — `computeDatasetHash`, manifest writing, and
  `signManifest` / `verifyManifestSignature` for issue #1011 publisher
  authentication.
- `publisher/src/engine.ts` — `runPublisherTick`: reads inbox, deduplicates
  leaves, builds the Poseidon tree, diffs against on-chain root, publishes.
- `publisher/data/inbox/` — file-backed MVP leaf intake directory.

## Related decisions

- [ADR-0001](0001_off_chain_published_roots.md) — same off-chain-root pattern
  applied to the pool state tree; this ADR follows the same trust model.
- [ADR-0008](0008_dataset_hash_format.md) — documents the dataset hash encoding
  that makes the publisher's output reproducible.
- [ADR-0010](0010_multisig_governance_migration.md) — production key management
  that scopes the publisher signing key.

## References

- Reputation publisher: `publisher/README.md`
- Verifier contract: `contracts/reputation-verifier/src/lib.rs`
- Leaf commitment spec: `circuits/v2/stealth_reputation.circom`
