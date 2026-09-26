# ADR-0004: Non-custodial Freighter wallet requirement

**Date:** 2026-07-24  
**Status:** Accepted  
**Context:** User funds and key management without backend custody

## Problem statement

Users need to:
- Hold and manage their private keys
- Authorize transactions
- Maintain backup copies for recovery
- Prove ownership without leaking keys to a backend service

**Options:**
1. Custodial wallet: Backend stores and manages keys, users authenticate via credentials
2. Hybrid wallet: Backend holds keys encrypted by user password; user controls decryption
3. Non-custodial: User holds keys locally; backend provides data and infrastructure only

Custodial wallets (Option 1) are simpler but users must trust the backend with their keys. Hybrid wallets (Option 2) reduce backend trust but still create key custody risks. Non-custodial wallets (Option 3) give users full control but require more client-side complexity.

## Context

Opaque Stellar is designed for privacy and financial sovereignty. Users should control their funds without relying on a backend service for key management. The protocol requires:
- Proof generation (local, client-side only)
- Key signing (user-authorized)
- Key backup and recovery (user responsibility)

A non-custodial model aligns with these requirements. Users hold keys in Freighter (a Stellar wallet extension), which provides:
- Secure key storage
- Transaction signing
- Hardware wallet support (for high-security users)

## Decision

Opaque Stellar requires a non-custodial Freighter wallet. All key management, signing, and proof generation happen on the user's device.

**User flow:**
1. Install Freighter browser extension
2. Create or import a Stellar account into Freighter
3. Opaque Stellar derives secondary keys (stealth key, note keys) from the Freighter account
4. User authorizes privacy pool deposits and withdrawals via Freighter's signature prompts
5. All proof generation happens locally in the browser
6. User backs up keys via Freighter's backup mechanism

## Rationale

Non-custodial design provides:

1. **User sovereignty:** Users control their funds; no backend can freeze or spend them
2. **Key security:** Keys are stored locally (optionally in a hardware wallet) and never sent to a backend
3. **Auditability:** Users can inspect proof generation and transaction authorization
4. **Censorship resistance:** No backend operator can prevent withdrawals or block users

The tradeoff is:
1. **User responsibility:** Key backup and security are the user's responsibility
2. **Complexity:** Client-side proof generation and key derivation increase code complexity
3. **UX friction:** Users must approve transactions via Freighter; no single-click submissions

Compared to custodial wallets:
- **More privacy:** Backend never sees user keys or withdrawal details
- **More friction:** Freighter prompts for each transaction
- **More resilient:** User funds are not frozen by backend downtime or operator action

## Alternatives considered

- **Custodial wallet (backend holds keys):** Simple UX, but users must trust the backend. Rejected for privacy and sovereignty reasons.
- **Hybrid wallet (encrypted keys in backend):** Reduces backend trust, but key derivation must happen server-side, leaking proof patterns. Rejected.
- **Self-custodial app (app holds keys):** No Freighter dependency; full control. Requires app to store and back up keys (complex). Rejected in favor of Freighter integration for UX and security.
- **Hardware wallet only:** Mandatory hardware wallets increase friction and cost. Non-custodial is already achievable via Freighter + local storage.

## Consequences

### Positive
- Users have full financial sovereignty
- Keys are never stored or transmitted through a backend
- Freighter provides mature key management and signing UX
- Hardware wallet support for high-security users
- Community auditing of key handling (open-source code)

### Negative
- Users must manage key backup and recovery
- Key loss results in permanent fund loss (no backend recovery)
- Freighter extension is a dependency; extension compromise affects all users
- Proof generation and scanning are slower (client-side, not server-side)

### Unknown
- Long-term maintenance of Freighter integration as the wallet evolves
- Friction impact on user adoption vs. custodial alternatives
- Security of browser storage for high-value accounts

## Implementation notes

**Key derivation:**
- Stealth key is derived from Freighter's account via standard Stellar key derivation (BIP-44)
- Note keys are generated per-deposit and backed up by the user
- All derivation happens locally; no backend involvement

**Transaction signing:**
- Deposit and withdrawal transactions are signed by Freighter (user authorizes via popup)
- Freighter signature proves user authorization; backend cannot forge signatures

**Backup and recovery:**
- Users export private keys via Freighter's backup (following Freighter's security practices)
- Users store backups offline; Opaque Stellar app assists with encrypted exports
- Recovery: Reimport wallet to Freighter, re-scan the ledger, re-import note keys

**Hardware wallet support:**
- Freighter supports hardware wallets (Ledger, Trezor)
- High-security users can store keys on a hardware device
- Transaction signing happens on the device; keys never leave the device

## Related decisions

- [ADR-0002](0002_browser_wasm_scanner.md): Scanning happens locally; user device has all key material
- [ADR-0003](0003_relayer_market_gossip_hub.md): Relayer cannot spend funds because Freighter requires user authorization

## References

- Freighter wallet: https://www.freighter.app/
- BIP-44 key derivation: https://github.com/bitcoin/bips/blob/master/bip-0044.mediawiki
- Stellar key management docs: https://developers.stellar.org/learn/fundamentals/stellar-data-structures/accounts-and-keys
- Key management guide: `docs/KEY_MANAGEMENT_GUIDE.md`
