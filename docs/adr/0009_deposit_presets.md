# ADR-0009: Deposit amount presets

**Date:** 2026-07-24
**Status:** Accepted
**Context:** Preserving the withdrawal anonymity set by encouraging uniform deposit sizes

## Problem statement

A privacy pool's anonymity set degrades when deposits have unique amounts: a
withdrawal of an unusual size is trivially linked to the matching deposit even
without breaking the zero-knowledge proof. The protocol is cryptographically
sound but practically weak if each note has a fingerprinting amount.

The question is how to encourage users to deposit in uniform sizes without
removing the ability to deposit arbitrary amounts.

## Context

The pool accepts any positive XLM amount (validated on-chain: must be > 0 and
below the BN254 field modulus). There is no protocol-level restriction to preset
amounts — partial withdrawals (V3 circuit, ADR-0012) allow spending less than
a deposit, which makes truly uniform deposits less critical than in tornado-style
pools, but uniform deposit sizes still improve the anonymity set for users who
want that guarantee.

The deployment manifest already carries per-network wiring for contract
addresses; adding presets there keeps them deployment-configurable without a
code change.

## Decision

Deposit amount presets are configured per deployment in the manifest file
(`deployments/v1/<network>.json`) under `wiring.privacyPool.depositPresetsXlm`.

Current testnet presets:

```json
"depositPresetsXlm": [10, 100, 1000, 10000]
```

The frontend (`frontend/src/contracts/poolConfig.ts`) reads `depositPresetsXlm`
and exposes one-tap buttons for each preset on the deposit screen. Custom
amounts remain allowed; the UI explains that using a preset size means the note
blends with other same-size deposits.

The client-side SDK (`sdk/src/services/pool-validation.ts`) enforces only
protocol-level constraints (non-zero, within field modulus, respects asset
decimal precision) — it does not restrict to presets so that programmatic
depositors and future UIs have full flexibility.

## Rationale

Presets as UI hints rather than protocol-level enforcement:

- Users who want maximal anonymity can click a preset; users with specific
  amounts are not blocked.
- Operators can adjust presets via manifest change without a contract upgrade.
- The constraint that matters for security (proving circuit correctness) is
  enforced on-chain; UI defaults are a privacy UX improvement, not a security
  control.

The specific denominations (10, 100, 1 000, 10 000 XLM) are round numbers at
1-2 orders-of-magnitude intervals. This creates four distinguishable anonymity
sets rather than one large mixed one — matching the canonical design for
fixed-denomination pools.

## Alternatives considered

- **Protocol-level enforcement (contract rejects non-preset amounts):** Provides
  a stronger guarantee but removes flexibility and requires a contract upgrade to
  change denominations. Rejected — partial withdrawals (V3 circuit) already
  allow spending sub-preset amounts, so strict enforcement would require tracking
  the original preset on-chain.
- **No presets, rely on social convention:** Users would need to coordinate
  off-chain on standard amounts. Too fragile. Rejected.
- **Single uniform denomination (e.g. 100 XLM only):** Maximises the anonymity
  set per denomination but excludes small and large depositors. Deferred for
  consideration if the 4-preset model produces uneven set sizes.

## Consequences

### Positive
- Depositors using presets contribute to a shared anonymity set.
- Operators can tune denominations without contract changes.
- Programmatic depositors and the SDK are unaffected.

### Negative
- Users who deposit custom amounts get a weaker anonymity guarantee than preset
  users (documented in the UI).
- Maintaining four separate anonymity sets instead of one means each set grows
  more slowly.

## Implementation notes

- Manifest field: `deployments/manifest.schema.json` →
  `wiring.privacyPool.depositPresetsXlm` (array of positive integers).
- Config reader: `frontend/src/contracts/poolConfig.ts` → `getPoolConfig()`.
- UI: `frontend/src/components/PoolView.tsx` — preset buttons and explanatory copy.
- Validation: `sdk/src/services/pool-validation.ts` → `validateDepositAmount`.

## Related decisions

- [ADR-0005](0005_soroban_privacy_pool.md) — the privacy pool contract that
  accepts deposits.
- [ADR-0012](0012_v3_circuit_adoption.md) — partial withdrawals (V3) which
  interact with the anonymity-set reasoning for presets.

## References

- Testnet manifest: `deployments/v1/testnet.json`
- Pool view component: `frontend/src/components/PoolView.tsx`
