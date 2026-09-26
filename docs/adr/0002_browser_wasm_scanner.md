# ADR-0002: Browser-side DKSAP scanner in WASM

**Date:** 2026-07-24  
**Status:** Accepted  
**Context:** Local receipt discovery without hosted scanning service

## Problem statement

Recipients need to discover incoming stealth payments without revealing their identity to a third-party scanner service. Stealth payments are announced on-chain with only a view tag (not the recipient's identity), so scanning requires access to:
- All announcements across the network
- The recipient's private view key to filter announcements

**Options:**
1. Host a scanning service that stores all announcements and filters per user (requires user to prove identity to the service)
2. Have users download all announcements and scan locally (high bandwidth, requires user device compute)
3. Compile the scanning algorithm to WASM and run in the browser (hybrid: user device handles logic, browser handles data)

Option 1 centralizes privacy leakage. Option 2 is bandwidth-inefficient. Option 3 balances privacy and efficiency.

## Context

Stealth payments use DKSAP (Decentralized Key Stealth Account Protocol), which is:
- A symmetric-key scanning algorithm that derives view material from the recipient's view key
- Deterministic: given an announcement, a view key either matches or does not
- Auditable: the computation can be run locally to verify correctness

The algorithm was originally designed for desktop devices but can be compiled to WASM to run in the browser. This keeps receipt discovery local to the user's device.

## Decision

Scanning is implemented as a DKSAP algorithm compiled to WASM and executed in the user's browser.

**How it works:**
1. User's browser fetches announcements from the Stealth Announcer contract
2. The WASM scanner filters announcements using the recipient's view key
3. Matching announcements are decrypted locally
4. The user's browser creates a transaction to sweep matching one-time accounts

The browser does not require a hosted scanning service. The user's RPC provider sees:
- Queries to the Stealth Announcer contract (which announcements exist)
- The sweep transaction (which one-time account receives funds)

The RPC provider does NOT see:
- Which announcements the user scanned
- The recipient's view key

## Rationale

Browser-side scanning preserves the privacy boundary:

1. **No scanner operator:** Unlike a hosted service, there is no third party with access to viewing key material or user identity
2. **Verifiable:** The user runs the same WASM code on their own device; they can audit it
3. **Scalable:** Scanning load is distributed across users' devices, not concentrated on a server
4. **Offline capable:** The scanner can work with cached announcements if the network is intermittently available

The tradeoff is that users must:
- Download the WASM binary (~1-2 MB)
- Run scanning logic on every session (adds latency)
- Trust their RPC provider to provide authentic announcements (standard assumption)

Compared to a hosted service, the model is:
- **More private:** No third-party knowledge of which announcements belong to the user
- **Less convenient:** Users must scan on their own device, not a background service
- **More costly:** User CPU and bandwidth, not centralized infrastructure

## Alternatives considered

- **Hosted scanner:** Centralized scanning service stores all announcements and filters per user key. Simpler UX but requires user identity leakage. Rejected for privacy reasons.
- **Server-side proof of correctness:** User proves their view key matches locally, server stores the result without the key. Still requires trusting the server to not log viewing patterns. Rejected.
- **Blockchain scanning:** Store announcements on-chain and query by view tag. Expensive and leaks view tags on-chain. Rejected.
- **Lite client protocol:** Compact proofs of announcement inclusion, verified in the browser. Over-engineered for the current scale; deferred to future optimization.

## Consequences

### Positive
- Users control their scanning logic; can audit the WASM binary
- No centralized scanning service (no operator privacy leakage)
- Scanning is instant for users who trust their RPC provider
- Users can run scanning on a custom schedule (not tied to a service's availability)

### Negative
- First-time users wait for WASM download and compilation
- Users must scan on each device independently (no cross-device state sharing)
- Scanning latency depends on user device performance
- Users with no RPC access cannot scan (must be online to Horizon)

### Unknown
- Performance characteristics on mobile browsers
- Long-term browser WASM performance vs. native implementations
- Feasibility of optimizations (indexing, batching) at scale

## Implementation notes

**WASM compilation:**
- Rust or C implementation of DKSAP compiled to WASM via wasm-pack or emscripten
- Bundle with the frontend and cache aggressively in service worker
- Include hash verification to ensure binary integrity

**User flow:**
1. On login, load the WASM binary from cache or fetch
2. Fetch announcements from Stealth Announcer
3. Scan in a worker thread to avoid blocking the UI
4. Prompt user to sweep matching one-time accounts

**Privacy preservation:**
- Do not log which announcements were scanned
- Do not persist user view key in localStorage
- Clear view key from memory after scanning completes

## Related decisions

- [ADR-0004](0004_non_custodial_wallet.md): Wallet must be non-custodial; scanning runs in user's local environment, not a backend service

## References

- Technical overview: "Stealth Payments" and "Scanner" sections
- DKSAP scanner implementation: `scanner/` directory
- WASM integration: `frontend/` Webpack configuration
