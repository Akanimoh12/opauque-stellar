# Architecture Decision Records (ADR) Index

This index tracks major architecture decisions for Opaque Stellar. Each ADR documents the problem, decision, rationale, and consequences of significant protocol and infrastructure choices.

## Active ADRs

| ADR | Title | Status | Date |
|-----|-------|--------|------|
| [ADR-0001](0001_off_chain_published_roots.md) | Off-chain published roots for pool state and association sets | Accepted | 2026-06-15 |
| [ADR-0002](0002_browser_wasm_scanner.md) | Browser-side DKSAP scanner in WASM | Accepted | 2026-07-24 |
| [ADR-0003](0003_relayer_market_gossip_hub.md) | Relayer market with shared gossip hub | Accepted | 2026-06-15 |
| [ADR-0004](0004_non_custodial_wallet.md) | Non-custodial Freighter wallet requirement | Accepted | 2026-07-24 |
| [ADR-0005](0005_soroban_privacy_pool.md) | Soroban smart contracts for privacy pool enforcement | Accepted | 2026-06-15 |
| [ADR-0006](0006_event_abi_versioning_policy.md) | Contract event ABI versioning policy | Accepted | 2026-07-27 |
| [ADR-0007](0007_reputation_publisher_trust_model.md) | Reputation publisher trust model | Accepted | 2026-06-15 |
| [ADR-0008](0008_dataset_hash_format.md) | Dataset hash format | Accepted | 2026-06-15 |
| [ADR-0009](0009_deposit_presets.md) | Deposit amount presets | Accepted | 2026-07-24 |
| [ADR-0010](0010_multisig_governance_migration.md) | Multisig governance migration | Accepted | 2026-07-27 |
| [ADR-0011](0011_http_gossip_over_libp2p.md) | HTTP gossip transport over libp2p | Accepted | 2026-06-15 |
| [ADR-0012](0012_v3_circuit_adoption.md) | V3 privacy-pool circuit adoption | Accepted | 2026-06-15 |

## Deprecated ADRs

None yet.

## Process for new ADRs

1. **Create:** Copy `ADR_TEMPLATE.md` and name it `NNNN_short_title.md`
2. **Discuss:** Share the ADR with the team; iterate on the decision and rationale
3. **Accept:** Once consensus is reached, update status to "Accepted" and add to this index
4. **Implement:** Link the ADR from relevant code and documentation
5. **Review:** Periodically revisit ADRs to ensure they remain valid; deprecate if superseded

## Guidelines

- One decision per ADR; keep scope focused
- Link related ADRs to show dependencies and history
- Include consequences explicitly; don't shy away from tradeoffs
- Reference external sources (papers, blog posts, RFCs)
- Expect ADRs to be read by future contributors; write for clarity
