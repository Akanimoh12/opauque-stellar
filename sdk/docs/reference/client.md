# OpaqueClient

The high-level entry point. One config + one signer wires the network, RPC
client, contract bindings, storage, and the domain services.

## Construction

```ts
new OpaqueClient({
  network: "testnet" | "mainnet" | "futurenet" | "local",
  signer?: OpaqueSigner,            // required for writes
  rpcUrls?: string[],               // default: network preset
  horizonUrls?: string[],           // default: network preset
  contracts?: Partial<ContractAddresses>,   // override baked addresses
  relayerGatewayUrls?: string[],
  artifacts?: ArtifactResolver,     // enables proof generation
  storage?: { notes?, vault?, scan? },       // default: in-memory
  logger?: Logger,                  // default: silent
  telemetry?: Telemetry,            // default: no-op
})
```

Testnet contract addresses, pool scope, and relayer parameters are baked in.
Mainnet requires explicit `rpcUrls`, `horizonUrls`, and `contracts`.

## Signers

| Adapter | Use |
|---------|-----|
| `keypairSigner(secretOrKeypair)` | server / Node |
| `callbackSigner({ publicKey, signTransaction })` | Freighter, a hardware wallet, or any custom backend |

See the [hardware wallet guide](/guide/hardware-wallet) for a Ledger-backed
signer, including the blind-signing limitations of Soroban invocations.

## Services

### `payments`
- `deriveIdentity(signatureHex)` — viewing/spending keys + meta-address
- `register({ metaAddress })`
- `prepareTransfer(metaHex)` — one-time address + announcement params
- `send({ to, amountXlm })`
- `scan({ announcements, identity })` — pure-TS, returns matches
- `scanIterator({ identity, startLedger?, cursorKey?, maxPages?, allowTruncation? })` — async generator, streams matches from chain with a resumable, **per-identity** cursor; throws `EventTruncationError` rather than returning a partial scan
- `scanCursorKey(identity)` — the `ScanStore` key an identity's cursor lives under
- `sweep({ stealthPrivKey, destination, amountStroops })`

### `pool`
- `deposit({ amountXlm })` — reads index, derives commitment, persists note
- `withdraw({ proof, recipient, fee?, relayer?, noteCommitment? })`
- `withdrawBatch({ notes, recipient, fee?, relayer? })` — proves + submits multiple notes to one recipient, reports per-note success/failure *(needs `artifacts`)*
- `proveWithdraw({ note, recipient })` — reconstructs leaves from chain *(needs `artifacts`)*
- `getDepositCount()`, `getRoots()`
- `isDepositCovered({ stateRoot?, aspRoot? })` — can a withdrawal be proven right now? reports `reasons` (`no-state-root`, `unknown-asp-root`, `withdrawals-paused`, `tree-at-capacity`, …)
- `isKnownStateRoot({ root })`, `isKnownAspRoot({ root })`
- `isDepositsPaused()`, `isWithdrawalsPaused()`, `getWithdrawalPauseRequest()`, `getWithdrawalMinimum()`, `getCustody()`, `getTreeCapacityInfo()`
- `contracts.privacyPool.reconstructState({ startLedger, maxPages, onTruncation })` — raw leaf reconstruction; `EventTruncationError` at the page cap unless `onTruncation: "return"`

### `reputation`
- `attest({ schemaId, stealthAddressHash, fieldValues, fieldDefinitions, … })`
- `prove({ attestationId, stealthPrivKey, externalNullifier })` *(needs `artifacts`)*
- `verifyOnChain(proof)` — submit to `reputation-verifier`
- `proveAndVerify(input)`
- `getLatestRoot()`

### `schemas`
- `register({ name, fieldDefinitions, revocable, schemaExpiryLedger, … })`
- `attest(…)`, `revoke({ uid })`, `deprecate({ schemaId })`
- `addDelegate(…)`, `removeDelegate(…)`

### `relayer`
- `buildWithdrawPayload({ proof, recipient })`, `buildJobDraft({ payload, fee, deadlineLedger })`
- `deadlineLedger(ledgers?)`, `createJobForDraft(draft)` / `createJob({ … })`
- `advertise(draft)`, `fetchBids(jobIdHex)`, `pickBid(bids)`, `deliverPayload({ draft, bid })`
- `jobStatus(jobIdHex)`, `cancelJob({ jobId })`, `slashJob({ jobId })`

The wire format + gateway client are also exported from
`@opaquecash/stellar/relayer-protocol`.

## Escape hatches

```ts
opaque.contracts.privacyPool;  // typed contract bindings
opaque.rpc;                    // ContractInvoker
opaque.soroban;                // built-in RpcClient (Soroban + Horizon), or undefined
```

## Errors

All errors extend `OpaqueError` with a stable `code`: `ConfigError`,
`SignerError`, `RpcError`, `SimulationError`, `ContractError` (carries
`contract` + `contractCode`), `RootUnavailableError`, `ArtifactError`,
`NotWiredError`.
