# Integrate: Relayer Market

End-to-end blind pool withdrawal through a staked market relayer, so the account
that submits the withdrawal isn't yours. Builds directly on the
[Privacy Pool](/integrate/privacy-pool) flow. See
[Relayer Market](/concepts/relayer-market) for the model and trust boundaries.

## Prerequisites

```sh
npm install @opaquecash/stellar "@stellar/stellar-sdk" "@noble/curves@^1" "@noble/hashes@^1" circomlibjs snarkjs tweetnacl
```

- Everything from the privacy-pool flow (artifacts, a note), plus:
- `tweetnacl` — encrypts the withdrawal payload to the chosen relayer's key.
- A **relayer gateway** — testnet defaults are baked in
  (`opaque.config.relayerGatewayUrls`); override via `relayerGatewayUrls`.

```ts
import { OpaqueClient, keypairSigner, urlArtifactResolver } from "@opaquecash/stellar";

const opaque = new OpaqueClient({
  network: "testnet",
  signer: keypairSigner(process.env.STELLAR_SECRET!),
  artifacts: urlArtifactResolver({ baseUrl: "https://your-cdn.example" }),
  storage: { notes: myNoteStore },
});
```

## Step 1 — Generate a withdrawal proof bound to the registry

This is a normal pool withdrawal proof, but the **relayer must be the registry**
contract and **fee 0** (the registry escrow pays the relayer), so the proof's
bound context matches the relayed payload.

```ts
const registryId = opaque.config.contracts.relayerRegistry;

const proof = await opaque.pool.proveWithdraw({
  note,
  recipient: payoutAddress,
  relayer: registryId, // bind the registry as the relayer
  fee: 0n,             // pool fee is zero; the escrow pays the relayer
});
```

## Step 2 — Build the blind payload + job draft

```ts
const payload = opaque.relayer.buildWithdrawPayload({ proof, recipient: payoutAddress });

const deadlineLedger = await opaque.relayer.deadlineLedger(); // ~720 ledgers ahead by default
const draft = opaque.relayer.buildJobDraft({
  payload,
  fee: 1_000_000n,     // stroops you pay the relayer (escrowed on-chain)
  deadlineLedger,
});
// draft.jobId / jobIdHex / payloadHash / advert
```

The advert reveals only the job id, fee, deadline, and **payload hash** — never
the withdrawal details.

## Step 3 — Escrow the job on-chain

::: warning Public funding transaction
This transaction is submitted by your connected wallet and is **public**. Fund it
from an address **not linked to your main identity** — this is the protocol's v1
linkage limitation.
:::

```ts
await opaque.relayer.createJobForDraft(draft); // escrows the fee, registers the job
```

## Step 4 — Advertise, collect bids, pick a relayer

```ts
await opaque.relayer.advertise(draft);                 // publish the advert to the gateway

const bids = await opaque.relayer.fetchBids(draft.jobIdHex);
// fetchBids verifies each bid's signature AND its on-chain registry state
// (job open, relayer stake >= fee, registered x25519 key matches)

const bid = opaque.relayer.pickBid(bids);              // stake-weighted random choice
if (!bid) throw new Error("no valid relayer bids yet — retry shortly");
```

## Step 5 — Deliver the encrypted payload

The payload is sealed (NaCl `crypto_box`) to the chosen relayer's registered
X25519 key. The relayer decrypts, hash-checks, simulates, accepts (bonding
stake), and submits the pool withdrawal.

```ts
const result = await opaque.relayer.deliverPayload({ draft, bid });
// result.acceptedTx / result.submittedTx — set once the relayer acts
```

## Step 6 — Track status and finalize

```ts
const status = await opaque.relayer.jobStatus(draft.jobIdHex);
// "open" | "accepted" | "submitted" | "slashed" | "canceled" | "unknown"

if (status === "submitted") {
  await opaque.notes.markSpent(note.commitment); // mark spent only after submission
}
```

Recovery if a relayer misbehaves (after the deadline):

```ts
await opaque.relayer.cancelJob({ jobId: draft.jobId }); // never accepted -> refund escrow
await opaque.relayer.slashJob({ jobId: draft.jobId });  // accepted but not submitted -> slash bond
```

## Full end-to-end script

```ts
const registryId = opaque.config.contracts.relayerRegistry;

// 1. proof bound to the registry
const proof = await opaque.pool.proveWithdraw({ note, recipient: PAYOUT, relayer: registryId, fee: 0n });

// 2. payload + draft
const payload = opaque.relayer.buildWithdrawPayload({ proof, recipient: PAYOUT });
const draft = opaque.relayer.buildJobDraft({
  payload, fee: 1_000_000n, deadlineLedger: await opaque.relayer.deadlineLedger(),
});

// 3. escrow + 4. advertise + bids
await opaque.relayer.createJobForDraft(draft);
await opaque.relayer.advertise(draft);
const bid = opaque.relayer.pickBid(await opaque.relayer.fetchBids(draft.jobIdHex));

// 5. deliver + 6. finalize
await opaque.relayer.deliverPayload({ draft, bid: bid! });
if ((await opaque.relayer.jobStatus(draft.jobIdHex)) === "submitted") {
  await opaque.notes.markSpent(note.commitment);
}
```

## Run a relayer (operator side)

The registry is a contract, so being a relayer needs no separate daemon
identity — the operator account *is* the identity, and its key can live in an
HSM. The whole lifecycle is in the SDK:

```ts
// 1. Register once, escrowing the initial stake (>= config.minimumStake).
await opaque.relayer.register({
  x25519Pubkey,                      // the pubkey creators encrypt payloads to
  endpoint: "https://relayer.example",
  stake: 100n * 10_000_000n,
});

// 2. Top up free stake as needed.
await opaque.relayer.addStake({ amount: 50n * 10_000_000n });

// 3. Take a job (bonds the fee against your stake) and submit it — the
//    registry re-hashes the payload and forwards the withdrawal to the pool.
await opaque.relayer.acceptJob({ jobId });
await opaque.relayer.submitPoolWithdraw({ jobId, ...withdrawalPayload });

// 4. Unstake is two-phase: request, then withdraw once the cooldown elapses.
await opaque.relayer.requestUnstake({ amount: 50n * 10_000_000n });
const { isUnlockable, unstakeUnlockLedger } = await opaque.relayer.getUnbondingStatus();
if (isUnlockable) await opaque.relayer.withdrawStake();
```

A runnable end-to-end version is in
[`examples/relayer-operator.mjs`](https://github.com/collinsadi/opauque-stellar/blob/main/sdk/examples/relayer-operator.mjs).

Reads need no signer at all — a watcher or a relayer node can hold a public
client and pass the account to simulate from:

```ts
const readonly = new OpaqueClient({ network: "testnet" });
const config = await readonly.relayer.getRegistryConfig({ source: someFundedAccount });
const record = await readonly.relayer.getRelayer({ source: someFundedAccount, operator });
const job = await readonly.relayer.getJob({ source: someFundedAccount, jobId });
const statuses = await readonly.relayer.jobStatuses({ source: someFundedAccount });
```

Compare `job.status` against the codes read from the contract
(`jobStatuses()`) rather than a hardcoded list, so a registry that reorders its
statuses cannot be misread as "unknown".

### Slashing

Anyone can report an offense; the slashed stake (bonded first, then free) is
paid to the reporter:

```ts
await opaque.relayer.reportSlash({
  proof: { relayer, offense: "DoubleSign", evidence, timestamp: BigInt(Date.now() / 1000), reporter },
  slashAmount: 10n * 10_000_000n,
});

const record = await opaque.relayer.getSlashingRecord({ relayer });  // null when clean
const bps = await opaque.relayer.getSlashingPercentage({ relayer }); // basis points of original stake
```

Only offenses the contract can verify are accepted — `DoubleSign` (two distinct
Ed25519 signatures over one 32-byte digest) and `InvalidSignature`. Timing and
ordering offenses (censorship, frontrunning) are governance matters, not
on-chain slashes.

## What a relayer can and cannot do

- **Cannot** change the recipient, amount, or proof (all bound into the ZK
  context), or read the payload before accepting.
- **Can** see the final withdrawal on-chain (it is public) and the public
  job-funding wallet.

## Notes & errors

- The wire format + gateway client are also exported standalone from
  `@opaquecash/stellar/relayer-protocol` for relayer-node operators.
- Missing `tweetnacl` → payload encryption throws a clear error; install it.
- No bids → no relayer has bid yet (or none meet stake/fee); retry, or fall back
  to a direct `pool.withdraw({ proof, recipient })`.
