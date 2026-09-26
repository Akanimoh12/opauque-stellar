---
"@opaquecash/stellar": minor
---

Fail loudly on truncated event scans, and stop re-reading the same ledgers.

- Shared `paginateContractEvents` for every contract-event loop, with a typed
  `EventTruncationError` (code `EVENT_TRUNCATION`) carrying the last scanned
  ledger and the cursor to resume from. `scanIterator` and `reconstructState`
  raise it instead of returning an incomplete scan that is indistinguishable
  from a complete one; both accept an explicit opt-out.
- Announcement scans now report `endLedger` per page, so a persisted cursor
  advances through ranges with no transfers instead of rescanning them on every
  run.
- Scan cursors are keyed per identity (`ScanStore.getCursor(identity?)` /
  `setCursor(ledger, identity?)`, `scanCursorKey(identity)`): one client can watch
  many identities without one identity's scan resuming past another's payments.
  Unkeyed calls and previously persisted cursors keep working.
- Pool state reads are bound and exposed on `PoolService`: `isDepositCovered`,
  `isKnownStateRoot`, `isKnownAspRoot`, `isDepositsPaused`, `isWithdrawalsPaused`,
  `getWithdrawalPauseRequest`, `getWithdrawalMinimum`, `getCustody`,
  `getTreeCapacityInfo`. `isDepositCovered` reports *why* a deposit is not yet
  provable, so a witness is not built against roots the pool will reject.
- Full relayer-registry bindings, plus the operator lifecycle on
  `RelayerService` (`register`, `addStake`, `requestUnstake`, `withdrawStake`,
  `acceptJob`, `submitPoolWithdraw`, `reportSlash`) and signer-free reads
  (`getJob`, `getRegistryConfig`, `getRelayer`, `getUnbondingStatus`,
  `jobStatuses`, `getSlashingRecord`, `getSlashingPercentage`).
