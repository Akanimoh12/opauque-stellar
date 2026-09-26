/**
 * Relayer operator walkthrough for @opaquecash/stellar.
 *
 *   RELAYER_SECRET=SA...            node examples/relayer-operator.mjs
 *   RELAYER_SOURCE=G...             node examples/relayer-operator.mjs   # read-only
 *
 * The relayer registry is a contract, so the operator account is the relayer
 * identity: registering, bonding stake, taking jobs, and unbonding are all
 * on-chain calls signed by that one key (which can live in an HSM). This script
 * walks that lifecycle against testnet:
 *
 *   1. read the registry config,
 *   2. register with the initial stake (or top up an existing registration),
 *   3. report the operator's stake, slashing history, and unbonding state,
 *   4. request an unstake and show when it becomes withdrawable.
 *
 * With RELAYER_SECRET set, steps 2-4 move real testnet XLM. With only
 * RELAYER_SOURCE (or no credentials at all) the script stops after the reads,
 * so it is safe to run anywhere.
 *
 * A relayer also needs an x25519 keypair: creators encrypt the blind withdrawal
 * payload to its public half. Supply it as RELAYER_X25519_PUBKEY (32 bytes,
 * hex, no 0x) — the placeholder below is fine for exploring the flow, not for
 * relaying real payments.
 *
 * Published consumers import from "@opaquecash/stellar"; this in-repo example
 * imports the built dist directly.
 */
import { OpaqueClient, keypairSigner } from "../dist/index.js";

const NETWORK = process.env.NETWORK ?? "testnet";
const SECRET = process.env.RELAYER_SECRET;
/** A read needs *some* funded account to simulate from; the operator's own is fine. */
const READ_SOURCE = process.env.RELAYER_SOURCE ?? "";
const X25519_HEX = process.env.RELAYER_X25519_PUBKEY ?? "11".repeat(32);
const ENDPOINT = process.env.RELAYER_ENDPOINT ?? "https://relayer.example";
const XLM = 10_000_000n;
const TOP_UP = 100n * XLM;

const opaque = new OpaqueClient({
  network: NETWORK,
  ...(SECRET ? { signer: keypairSigner(SECRET) } : {}),
});

const readOpts = READ_SOURCE ? { source: READ_SOURCE } : undefined;
const formatXlm = (stroops) => `${Number(stroops) / Number(XLM)} XLM`;

if (!SECRET && !READ_SOURCE) {
  console.log("Nothing to do without a credential. Set one of:");
  console.log("  RELAYER_SECRET=SA...  run the full operator lifecycle (writes XLM)");
  console.log("  RELAYER_SOURCE=G...   read-only: config, stake, slashing, unbonding");
  console.log("\nNothing was submitted.");
  process.exit(0);
}

const registry = await opaque.relayer.getRegistryConfig(readOpts);
console.log(`registry on ${NETWORK}`);
console.log(`  pool             ${registry.privacyPool}`);
console.log(`  native sac       ${registry.nativeSac}`);
console.log(`  minimum stake    ${formatXlm(registry.minimumStake)}`);
console.log(`  unstake cooldown ${registry.unstakeCooldownLedgers} ledgers`);
console.log(`  max job deadline ${registry.maxDeadlineLedgers} ledgers`);

if (!SECRET) {
  console.log("\nRead-only run (no RELAYER_SECRET). Set it to register, stake, or unbond.");
  process.exit(0);
}

const operator = await opaque.requireSigner().publicKey();
console.log(`\noperator ${operator}`);

if (TOP_UP < registry.minimumStake) {
  console.error(
    `refusing to register: ${formatXlm(TOP_UP)} is below the registry's ` +
      `${formatXlm(registry.minimumStake)} minimum stake`,
  );
  process.exit(1);
}

// 1. Register, or top up if this operator is already on the registry.
try {
  const existing = await opaque.relayer.getRelayer({ operator });
  console.log(`\nalready registered at ${existing.endpoint}; adding ${formatXlm(TOP_UP)} stake`);
  await opaque.relayer.addStake({ amount: TOP_UP });
} catch {
  console.log(`\nregistering at ${ENDPOINT} with ${formatXlm(TOP_UP)} stake`);
  await opaque.relayer.register({
    x25519Pubkey: Uint8Array.from(Buffer.from(X25519_HEX, "hex")),
    endpoint: ENDPOINT,
    stake: TOP_UP,
  });
}

// 2. Where the stake stands.
const record = await opaque.relayer.getRelayer({ operator });
console.log("\nstake");
console.log(`  free    ${formatXlm(record.freeStake)}`);
console.log(`  bonded  ${formatXlm(record.bondedStake)}`);
console.log(`  pending ${formatXlm(record.pendingUnstake)}`);

// 3. Slashing history is public, and null for an operator who has never been
//    slashed — worth surfacing before taking a job.
const slash = await opaque.relayer.getSlashingRecord({ relayer: operator });
console.log(
  `\nslashing: ${slash ? `${slash.slashCount} slash(es), ${formatXlm(slash.totalSlashed)}` : "clean"}`,
);

// 4. Unbonding is two-phase, and the cooldown is counted in ledgers rather than
//    wall-clock time — so ask the contract when it unlocks instead of sleeping.
if (record.freeStake > 0n) {
  const amount = record.freeStake / 2n;
  console.log(`\nrequesting unstake of ${formatXlm(amount)}`);
  await opaque.relayer.requestUnstake({ amount });

  const unbonding = await opaque.relayer.getUnbondingStatus();
  console.log(
    unbonding.isUnlockable
      ? "  cooldown elapsed — withdrawStake() will succeed"
      : `  unlocks at ledger ${unbonding.unstakeUnlockLedger}`,
  );
  console.log("  then: await opaque.relayer.withdrawStake()");
} else {
  console.log("\nno free stake to unbond (it is all bonded to jobs)");
}

console.log("\nJob loop, once a payload arrives:");
console.log("  await opaque.relayer.acceptJob({ jobId });");
console.log("  await opaque.relayer.submitPoolWithdraw({ jobId, ...withdrawalPayload });");
console.log("\nDone. Every write above was submitted on-chain.");
