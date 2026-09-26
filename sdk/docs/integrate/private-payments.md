# Integrate: Private Payments

A complete, end-to-end walkthrough of a stealth XLM payment — from both the
**sender** and **recipient** sides. By the end you'll have funds sent to a
recipient's published meta-address, detected by the recipient, and swept to a
fresh account, with no on-chain link between sender and recipient.

See [Stealth Payments](/concepts/stealth-payments) for the cryptography behind
this. Every method used here is in the [API reference](/api/).

## Prerequisites

```sh
npm install @opaquecash/stellar "@stellar/stellar-sdk" "@noble/curves@^1" "@noble/hashes@^1"
```

```ts
import { OpaqueClient, keypairSigner, buildDomainSeparatedMessage } from "@opaquecash/stellar";

const opaque = new OpaqueClient({
  network: "testnet",
  signer: keypairSigner(process.env.STELLAR_SECRET!), // or a Freighter signer in the browser
});
```

The signer's account pays for and authorizes on-chain calls (registering the
meta-address, announcing transfers). It is never linked to the funds the
recipient ultimately controls.

## Step 1 — Recipient derives a stealth identity

The recipient derives a viewing key + spending key from a **single signature**
used as entropy. Sign a stable, domain-separated message once and reuse it.

```ts
// The message is informational entropy — signing it moves no funds.
const message = buildDomainSeparatedMessage({
  origin: "https://your-app.example",
  networkPassphrase: opaque.config.passphrase,
  walletPublicKey: await opaque.signer!.publicKey(),
  purpose: "stealth-keys",
});

// Browser (Freighter): const { signedMessage } = await signMessage(message)
// Server: sign the message bytes with your keypair.
const signatureHex = signMessageSomehow(message); // hex string

const identity = opaque.payments.deriveIdentity(signatureHex);
// identity.viewingKey  (Uint8Array) — detects incoming transfers
// identity.spendingKey (Uint8Array) — controls the funds (keep secret)
// identity.metaAddress (Uint8Array, 66 bytes)
// identity.metaHex     (0x… 134 chars) — this is what senders use
```

::: warning Persist the identity
Re-deriving requires the **same signature**. Persist either the signature or the
derived keys (encrypted) so the identity is stable across sessions. The same
signature always yields the same identity.
:::

## Step 2 — Recipient publishes the meta-address

Register the meta-address on the stealth-registry so senders can look it up
(or share `identity.metaHex` directly / via a [payment link](/api/)):

```ts
await opaque.payments.register({ metaAddress: identity.metaAddress });
```

## Step 3 — Sender pays the meta-address

The sender needs only the recipient's `metaHex`. `send` derives a one-time
stealth account, funds it, and publishes an announcement so the recipient can
find it:

```ts
const result = await opaque.payments.send({
  to: recipientMetaHex,   // identity.metaHex from the recipient
  amountXlm: "10",
});
// result.stealthStellarAddress — the one-time account that received the XLM
// result.paymentTxHash         — the XLM transfer
// result.announceTxHash        — the on-chain announcement
```

Each call derives a **fresh** stealth address, so repeated payments to the same
recipient are unlinkable on-chain.

::: tip Build the transfer without sending
Need the stealth address before paying (e.g. to show the user)? Use the pure
helper: `const t = opaque.payments.prepareTransfer(recipientMetaHex)` returns
`{ stealthStellarAddress, ephemeralPubKey, stealthAddress, viewTag, metadata }`
without touching the network.
:::

## Step 4 — Recipient scans for incoming transfers

Scanning is two parts: **fetch announcements** from the stealth-announcer
contract, then **match** them against the recipient's keys (pure crypto, no
network).

```ts
// (a) Fetch announcements from chain. Read the stealth-announcer contract's
// events via the low-level client and map each to a StealthAnnouncement:
//   { stealthAddress: string, ephemeralPubKey: Uint8Array, viewTag: number }
const announcements = await fetchAnnouncements(opaque); // see note below

// (b) Match — view-tag prefilter, reconstruct, confirm by stealth id:
const matches = opaque.payments.scan({ announcements, identity });

for (const m of matches) {
  console.log("incoming transfer at", m.stealthStellarAddress);
  // m.stealthPrivKey — the one-time key controlling those funds
}
```

`scan` returns only the transfers addressed to this identity. A coincidental
view-tag collision is rejected (it confirms by recomputing the stealth id), so
matches are exact.

::: details Fetching announcements from the announcer contract
`scan` takes announcements you supply, so you control the source and pagination.
Read the stealth-announcer events with the built-in client and map them:

```ts
async function fetchAnnouncements(opaque) {
  const announcer = opaque.config.contracts.stealthAnnouncer;
  const res = await opaque.rpc.getEvents({
    startLedger: opaque.config.startLedger,
    filters: [{ type: "contract", contractIds: [announcer] }],
    limit: 100,
  });
  // Map each announce event's (stealthId, ephemeralPubKey, metadata) into:
  // { stealthAddress, ephemeralPubKey, viewTag: metadata[0] }
  // Follow res.cursor to page older history (see pool reconstruction for the pattern).
  return res.events.map(decodeAnnounceEvent);
}
```

Persist a scan cursor (via a `ScanStore`) so you only process new ledgers.
`scanIterator` does this for you, and the cursor is **keyed per identity** — one
client can watch many identities without one identity's scan resuming past
another's payments. A range with no announcements still counts as scanned, so
quiet ledgers are not re-read on every run.

Scans are event-paged and bounded: a scan that hits the page cap raises
`EventTruncationError` (transfers may be missing) with `lastScannedLedger` and
`continuationCursor` to resume from, rather than reporting a partial result as a
complete one. Pass `allowTruncation: true` only if a gap is acceptable to you.
:::

## Step 5 — Recipient sweeps the funds

Move the funds from the one-time stealth account to a destination the recipient
controls. The stealth account signs **itself** (derived from the one-time key),
so the connected wallet is never the source.

```ts
import { parseXlmToStroops } from "@opaquecash/stellar";

await opaque.payments.sweep({
  stealthPrivKey: matches[0].stealthPrivKey,
  destination: myMainAccount,
  amountStroops: parseXlmToStroops("9.9"), // reserve some for fees/min-balance
});
```

Compute `amountStroops` from the account balance minus the Stellar base reserve
and fee. Querying the stealth account's spendable balance:
`opaque.soroban?.horizon().loadAccount(matches[0].stealthStellarAddress)`.

## Full end-to-end script

```ts
import { OpaqueClient, keypairSigner, parseXlmToStroops } from "@opaquecash/stellar";

// --- recipient ---
const recipient = new OpaqueClient({ network: "testnet", signer: keypairSigner(RECIPIENT_SECRET) });
const id = recipient.payments.deriveIdentity(recipientSignatureHex);
await recipient.payments.register({ metaAddress: id.metaAddress });

// --- sender ---
const sender = new OpaqueClient({ network: "testnet", signer: keypairSigner(SENDER_SECRET) });
const sent = await sender.payments.send({ to: id.metaHex, amountXlm: "10" });
console.log("paid stealth account:", sent.stealthStellarAddress);

// --- recipient detects + sweeps ---
const announcements = await fetchAnnouncements(recipient);
const [match] = recipient.payments.scan({ announcements, identity: id });
await recipient.payments.sweep({
  stealthPrivKey: match.stealthPrivKey,
  destination: RECIPIENT_MAIN_ACCOUNT,
  amountStroops: parseXlmToStroops("9.9"),
});
```

## Errors to handle

| Error | When | Handling |
|-------|------|----------|
| `SignerError` | an operation needs a signer but none/invalid | construct the client with a `signer` |
| `RpcError` | network/RPC failure | retry; the client already retries reads |
| `SimulationError` | a contract call fails pre-flight | inspect `.diagnostics` |

All extend `OpaqueError` with a stable `.code`. See [errors in the API reference](/api/).
