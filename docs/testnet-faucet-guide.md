# Testnet Faucet & Funding Guide

Opaque's stealth-payment and privacy-pool flows need **funded testnet accounts on
both sides of a transfer**: the wallet you connect with (the sender/deployer
account) and, indirectly, every one-time stealth account it creates for a
recipient. New contributors often get stuck here before they ever touch the app
UI. This guide covers where to get testnet XLM, how much to request, and the
gotchas specific to this repo's multi-step flows.

---

## 1. Which network to use locally

Local dev defaults to **Stellar Testnet** (`VITE_STELLAR_NETWORK=testnet` in
`frontend/.env`, copied from [`frontend/.env.example`](../frontend/.env.example)).
Unless you're specifically testing another cluster, stay on testnet — it's the
only network with a public, self-serve faucet and the one this repo's default
config, and the canonical manifest (`deployments/v1/testnet.json`), target.

| Network | Faucet available | Use for |
|---|---|---|
| `testnet` | Yes (Friendbot) | Local dev, most contributions |
| `futurenet` | Yes (Friendbot, futurenet host) | Testing not-yet-released Soroban/Horizon features |
| `local` (standalone) | Yes (Friendbot on your local node) | Fully offline development |
| `mainnet` | No — real funds only | Never for development or testing |

Set the network in `frontend/.env`:

```bash
cd frontend
cp .env.example .env
# VITE_STELLAR_NETWORK=testnet
```

---

## 2. Get testnet XLM via Friendbot

Stellar's testnet faucet is called **Friendbot**. It funds any valid Ed25519
public key (`G...`) with test XLM — no signup, no captcha for the API endpoint.

### Option A — Browser

Open in a browser and replace the address:

```
https://friendbot.stellar.org/?addr=GABC...YOUR_PUBLIC_KEY
```

### Option B — curl (recommended for scripting/CI)

```bash
curl "https://friendbot.stellar.org/?addr=GABC...YOUR_PUBLIC_KEY"
```

A successful response returns the funded account's ledger entry as JSON. Friendbot
funds new accounts with **10,000 XLM** on testnet as of this writing — far more
than you need for local dev, but there's no way to request a smaller amount.

### Option C — Stellar Laboratory

[laboratory.stellar.org](https://laboratory.stellar.org/#account-creator?network=test)
has a "Generate keypair" + "Fund account" button if you'd rather not use the CLI.

### Option D — Stellar CLI

If you already have the [Stellar CLI](https://developers.stellar.org/docs/build/smart-contracts/getting-started/setup)
installed, you can generate and fund an identity in one step:

```bash
stellar keys generate my-dev-account --network testnet --fund
stellar keys address my-dev-account
```

### Futurenet and local networks

- **Futurenet**: `https://friendbot-futurenet.stellar.org/?addr=<PUBLIC_KEY>`
- **Local standalone network**: Friendbot runs on your local node, typically
  `http://localhost:8000/friendbot?addr=<PUBLIC_KEY>`. Only relevant if you're
  running a full local Stellar quickstart container.

---

## 3. How this ties into the dev workflow

1. **Connect Freighter** to the wallet UI (`npm run dev` in `frontend/`, then
   connect on `http://localhost:5173`). Freighter must itself be set to
   **Testnet** in its own network switcher — the app reads `VITE_STELLAR_NETWORK`
   but Freighter's signing still depends on which network the extension is set to.
2. **Fund that connected account** with Friendbot before doing anything else. An
   unfunded source account cannot pay the base transaction fee, so registration
   (`RegistrationWizard` → `registerStealthKeys`) and `SendView`'s transfer +
   announcement will both fail — `RegistrationWizard` explicitly checks the
   balance first and shows a "not funded" hint with a link back to this guide's
   funding steps if it's zero.
3. **Stealth ("ghost") destination accounts are funded implicitly.** Opaque never
   pre-funds a recipient's one-time stealth address — the *first send* to that
   stealth meta-address is what creates the account on-chain (see
   `buildNativeTransferOperation` in `frontend/src/lib/stellar.ts`, used by
   `SendView.tsx`). You do not need to Friendbot-fund a stealth address yourself;
   you only need your **sender** account funded with enough to cover the send
   amount plus fees.
4. **Two accounts for a full round-trip test.** To exercise send → scan → sweep
   locally, fund two separate testnet keypairs: one to act as sender (registers
   and sends) and one to act as recipient (registers, publishes a meta-address,
   and later scans for + sweeps the stealth funds). Friendbot each independently.
5. **The privacy pool needs funding too.** Depositing into the privacy pool
   (`PoolView`) moves XLM from your connected wallet into the pool contract —
   same funding requirement as a stealth send: fund the depositor account first.

---

## 4. Minimum balances

| Account role | Minimum recommended balance | Why |
|---|---|---|
| Sender / deployer account | 2 XLM | Covers the 1 XLM base reserve, transaction fees, and one or more test sends |
| Recipient account (for registration only) | 2 XLM | Covers base reserve + the registration transaction fee |
| Ghost / stealth destination account | *(not pre-funded)* | Created by the sender's first payment; that payment amount must exceed the **1 XLM base reserve** for the new account to exist on-chain — sends below ~1 XLM to a brand-new stealth address will fail |

Friendbot's default 10,000 XLM grant covers all of the above with enormous
headroom — these minimums matter mainly if you're funding accounts through a
custom script or CI harness that transfers smaller amounts instead of using
Friendbot directly.

---

## 5. Common gotchas

- **"op_underfunded" / "op_no_destination" errors on send** — almost always
  means either the sender isn't funded, or the send amount is below the network's
  minimum account reserve (1 XLM) when the destination is a brand-new stealth
  account. Bump the test amount to at least 1.5–2 XLM.
- **Freighter network mismatch** — the app trusts `VITE_STELLAR_NETWORK`, but
  Freighter signs using whatever network *it* is configured for. If they
  disagree you'll get signature/passphrase errors that look unrelated to funding.
  Check Freighter's own network selector.
- **Friendbot rate limiting** — Friendbot occasionally rate-limits an IP after
  many requests in a short window. If a request errors with a 400/429, wait a
  minute and retry, or use Stellar Laboratory instead.
- **Reusing the same account across networks** — a keypair funded on testnet
  has a zero balance on futurenet/mainnet/local; each network's ledger is
  independent. Fund a fresh account per network you test against.
- **Mainnet has no faucet.** If `VITE_STELLAR_NETWORK=mainnet` locally, nothing
  in this guide applies — fund accounts with real XLM only if you know what
  you're doing, and see [`DISCLAIMER.md`](../DISCLAIMER.md) first.
- **Don't commit funded secret keys.** Friendbot-funded testnet keys are still
  real keypairs; keep them in `frontend/.env` (gitignored) or your own scratch
  files, never in a commit.

---

## Related docs

- [`README.md`](../README.md) — full local setup
- [`.github/CONTRIBUTING.md`](../.github/CONTRIBUTING.md) — contributor quick start, links here
- [`deployments/README.md`](../deployments/README.md) — canonical contract IDs per network
- [`frontend/.env.example`](../frontend/.env.example) — network/env configuration
- [`docs/testnet-slos.md`](testnet-slos.md) — testnet service health objectives (for off-chain services, not funding)
