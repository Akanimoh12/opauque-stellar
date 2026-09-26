# Circuit Versioning and Verifier Migration Strategy

> Tracking issue: [#596 — Add circuit versioning and verifier migration strategy](https://github.com/collinsadi/opaque-stellar/issues/596)

Fixing a circuit bug or upgrading constraints requires new verifying keys.
Without an explicit migration path, existing notes proven under old keys can
become permanently unwithdrawable when the old verifier is replaced. This
document defines the versioning scheme, coexistence window policy, deprecation
timeline, and deployment manifest requirements.

---

## Circuit Version Identifier

Each deployed circuit is identified by a **circuit version** tuple:

```
(circuit_name, version_id, verifying_key_hash)
```

| Field | Type | Example |
|---|---|---|
| `circuit_name` | ASCII string | `stealth_attestation` |
| `version_id` | `u32` monotonically increasing | `2` |
| `verifying_key_hash` | `BytesN<32>` — SHA-256 of the `.zkey` | `0xabcd…` |

`version_id` starts at `1` and is incremented for every circuit change that
produces different verifying keys. Purely cosmetic or comment-only changes must
not increment the version.

### Commitment in notes

Notes commit to the circuit version at proof time:

```
note_commitment = Poseidon₄(amount, owner_pk, nonce, version_id)
```

This binds a note to the verifier that produced its proof. The on-chain verifier
contract reads `version_id` from the submitted proof's public signal and routes
verification to the corresponding registered verifier.

---

## On-chain Verifier Registry

The `groth16-verifier` contract maintains a registry of active verifier entries:

```rust
struct VerifierEntry {
    version_id:       u32,
    vk_hash:          BytesN<32>,
    activated_at:     u64,   // ledger sequence
    deprecated_at:    Option<u64>,  // None = still active
    sunset_at:        Option<u64>,  // None = not yet scheduled
}
```

Registration is admin-gated. The admin calls `register_verifier(version_id, vk_hash, vk_bytes)`.

### Routing

When a proof is submitted:

1. The contract reads `version_id` from the public signals.
2. It looks up the `VerifierEntry` for that `version_id`.
3. If `deprecated_at` is `Some(d)` and `current_ledger > sunset_at.unwrap()`, the
   entry is expired and the proof is rejected.
4. Otherwise verification proceeds against the stored verifying key.

---

## Coexistence Window Policy

When a new circuit version is deployed, the old and new verifiers are
**simultaneously active** for a minimum coexistence window of **30 days**
(approximately 2 592 000 ledgers at ~5 s/ledger).

```
Timeline:

  T₀   New verifier registered (version N+1 active)
  T₀   Old verifier (version N) enters "deprecated" state:
         deprecated_at = T₀
         sunset_at     = T₀ + 2_592_000

  T₀…T₀+30d   Both versions active; old notes proven under N remain withdrawable
  T₀+30d       Old verifier sunset: sunset_at ledger reached; version N rejected
```

Notes proven before `T₀` carry `version_id = N` in their commitment. During the
coexistence window, holders can withdraw those notes against the still-active
version N verifier. After `sunset_at`, version N proofs are rejected; any
un-withdrawn note proven under N is permanently locked. Users receive advance
notice (see §Signaling).

The window may be extended (but never shortened) by the admin via
`extend_sunset(version_id, new_sunset_at)`.

### New deposits

After `T₀`, the frontend forces `version_id = N+1` for all new deposit operations.
This is enforced client-side by reading the `latest_version_id()` view from the
verifier contract before constructing the witness.

---

## Deprecation Signaling

### On-chain event

When a verifier is deprecated, the contract emits a versioned event
(see `EVENT_VERSIONING.md`):

```
topics = (Symbol("VerifierDeprecated"), EVENT_VERSION, version_id)
data   = (deprecated_at: u64, sunset_at: u64, vk_hash: BytesN<32>)
```

The scanner (`scanner/src/scanner.rs`) processes `VerifierDeprecated` events and
writes them to the index with a `sunset_at` field. Indexers and explorers should
surface this as a user-facing warning.

### Frontend banner

When the frontend detects that the user holds notes proven under a deprecated
circuit version (by comparing note `version_id` against the registry), it
renders a time-bounded withdrawal prompt:

> "Your note was proven with an older circuit version (v{N}). Withdraw before
> {sunset_date} to avoid loss."

The `deprecated_at` and `sunset_at` ledger sequences are converted to
approximate wall-clock times using the current ledger close time.

---

## Deployment Manifests

Every deployment artifact for a circuit version must include a manifest file at:

```
deployments/<network>/<circuit_name>_v<version_id>.json
```

Example: `deployments/mainnet/stealth_attestation_v2.json`

Required fields:

```json
{
  "circuit_name": "stealth_attestation",
  "version_id": 2,
  "vk_hash": "0xabcdef...",
  "zkey_sha256": "0x123456...",
  "constraint_count": 109842,
  "circom_version": "2.1.6",
  "snarkjs_version": "0.7.5",
  "ceremony": "opauque-mainnet-2026-q3",
  "activated_ledger": 12345678,
  "deprecated_ledger": null,
  "sunset_ledger": null
}
```

`deprecated_ledger` and `sunset_ledger` are written by the deployment tooling
after the admin deprecation transaction confirms on-chain.

---

## Upgrading: Step-by-Step Checklist

1. Compile the new circuit and run `snarkjs groth16 setup` through the
   ceremony process (see `TRUSTED_SETUP_CEREMONY.md`).
2. Compute `vk_hash = sha256(verifying_key.json)` and record it.
3. Write `deployments/<network>/<circuit_name>_v<N+1>.json` with
   `deprecated_ledger: null` and `sunset_ledger: null`.
4. Submit the `register_verifier(N+1, vk_hash, vk_bytes)` admin transaction.
   Record `activated_ledger`.
5. Submit the `deprecate_verifier(N, sunset_at = current_ledger + 2_592_000)`
   admin transaction. Update `deprecated_ledger` and `sunset_ledger` in the
   v{N} manifest.
6. Monitor the scanner for `VerifierDeprecated` event indexing.
7. Verify the frontend displays the deprecation banner for affected note holders.
8. After `sunset_at`, confirm version N proofs are rejected on-chain.

---

## References

- [ADR-0006](adr/0006_event_abi_versioning_policy.md) — event schema versioning, including `VerifierDeprecated`
- [CIRCUIT_VERSIONING.md](CIRCUIT_VERSIONING.md) — circuit (verifying-key) versioning, superset and adoption rules
- [NULLIFIER_SPEC.md](NULLIFIER_SPEC.md) — note commitment includes `version_id`
- [TRUSTED_SETUP_CEREMONY.md](TRUSTED_SETUP_CEREMONY.md) — ceremony plan for new verifying keys
