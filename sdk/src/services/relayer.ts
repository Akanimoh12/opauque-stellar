/**
 * Relayer market: the wallet-side withdrawal flow. Build a blind withdrawal
 * payload from a pool proof, create the on-chain escrow job, advertise it,
 * collect and verify bids, pick a relayer, and deliver the encrypted payload.
 */
import {
  RelayerGateway,
  buildRelayedWithdrawPayload,
  buildRelayerJobDraft,
  pickStakeWeightedBid,
  type PoolWithdrawPayload,
  type RelayerBid,
  type RelayerJobDraft,
  type RelayerJobStatus,
  type VerifiedBid,
} from "../relayer-protocol/index";
import type { PoolWithdrawProof } from "../prove/pool";
import { resolveReadSource } from "./read-source";
import type { OpaqueClientContext } from "./context";
import type {
  JobRecord,
  JobStatus,
  RegistryConfig,
  RelayerRecord,
  RelayerRegistry,
  RelayerSlashRecord,
  SlashingProof,
  UnbondingStatus,
} from "../contracts/relayer";

export class RelayerService {
  constructor(private readonly ctx: OpaqueClientContext) {}

  private gateway(): RelayerGateway {
    return new RelayerGateway({
      gatewayUrls: this.ctx.config.relayerGatewayUrls,
      registryId: this.ctx.config.contracts.relayerRegistry,
      invoker: this.ctx.rpc,
    });
  }

  // --- on-chain job lifecycle -------------------------------------------------

  /** Create a blind withdrawal job (escrows the fee on-chain). */
  async createJob(opts: {
    jobId: Uint8Array;
    payloadHash: Uint8Array;
    deadlineLedger: number;
    fee: bigint;
  }): Promise<string> {
    return this.ctx.contracts.relayerRegistry.createJob({
      ...opts,
      signer: this.ctx.requireSigner(),
    });
  }

  /** Create the on-chain job for a built draft. */
  async createJobForDraft(draft: RelayerJobDraft): Promise<string> {
    return this.createJob({
      jobId: draft.jobId,
      payloadHash: draft.payloadHash,
      deadlineLedger: draft.deadlineLedger,
      fee: draft.fee,
    });
  }

  /** Cancel a never-accepted job after its deadline (refunds the escrow fee). */
  async cancelJob(opts: { jobId: Uint8Array }): Promise<string> {
    return this.ctx.contracts.relayerRegistry.cancelJob({
      ...opts,
      signer: this.ctx.requireSigner(),
    });
  }

  /** Slash an accepted-but-unsubmitted job after its deadline. */
  async slashJob(opts: { jobId: Uint8Array }): Promise<string> {
    return this.ctx.contracts.relayerRegistry.slashJob({
      ...opts,
      signer: this.ctx.requireSigner(),
    });
  }

  // --- payload + gateway ------------------------------------------------------

  /** Build the blind withdrawal payload from a pool proof. */
  buildWithdrawPayload(opts: {
    proof: PoolWithdrawProof;
    recipient: string;
  }): PoolWithdrawPayload {
    return buildRelayedWithdrawPayload({
      poolId: this.ctx.config.contracts.privacyPool,
      registryId: this.ctx.config.contracts.relayerRegistry,
      proof: opts.proof,
      recipient: opts.recipient,
    });
  }

  /** Build a job draft (job id, payload hash, advert) from a payload. */
  buildJobDraft(opts: {
    payload: PoolWithdrawPayload;
    fee: bigint;
    deadlineLedger: number;
    jobId?: Uint8Array;
  }): RelayerJobDraft {
    return buildRelayerJobDraft(opts);
  }

  /** A deadline `ledgers` ahead of the current ledger. */
  async deadlineLedger(ledgers?: number): Promise<number> {
    return this.gateway().deadlineLedger(ledgers);
  }

  /** Advertise a job to the gateway. */
  async advertise(draft: RelayerJobDraft): Promise<void> {
    return this.gateway().publishAdvert(draft.advert);
  }

  /** Fetch and verify bids for a job (signature + on-chain registry state). */
  async fetchBids(jobIdHex: string): Promise<VerifiedBid[]> {
    return this.gateway().fetchBids(jobIdHex);
  }

  /** Stake-weighted random choice among verified bids. */
  pickBid(bids: VerifiedBid[]): VerifiedBid | null {
    return pickStakeWeightedBid(bids);
  }

  /** Encrypt the payload to the chosen relayer and deliver it to the gateway. */
  async deliverPayload(args: {
    draft: RelayerJobDraft;
    bid: RelayerBid;
  }): Promise<{ acceptedTx?: string; submittedTx?: string } | null> {
    return this.gateway().deliverPayload(args);
  }

  /** Read a job's on-chain status. */
  async jobStatus(jobIdHex: string, source?: string): Promise<RelayerJobStatus> {
    const src = await resolveReadSource(this.ctx, source);
    return this.gateway().jobStatus(jobIdHex, src);
  }

  // --- on-chain job + registry reads -----------------------------------------
  //
  // All of these work without a configured signer: pass `source` (any account
  // funded enough to simulate from) or connect a client with one.

  /** A job's record, for deciding whether to cancel or slash it. */
  async getJob(opts: { jobId: Uint8Array; source?: string }): Promise<JobRecord> {
    return this.ctx.contracts.relayerRegistry.getJob({
      source: await resolveReadSource(this.ctx, opts.source),
      jobId: opts.jobId,
    });
  }

  /** Live registry configuration: stake floor, unstake cooldown, deadline cap. */
  async getRegistryConfig(opts?: { source?: string }): Promise<RegistryConfig> {
    return this.ctx.contracts.relayerRegistry.getConfig(
      await resolveReadSource(this.ctx, opts?.source),
    );
  }

  /** A relayer's registry record. Pass `operator` to inspect another relayer. */
  async getRelayer(opts?: { operator?: string; source?: string }): Promise<RelayerRecord> {
    const source = await resolveReadSource(this.ctx, opts?.source);
    return this.ctx.contracts.relayerRegistry.getRelayer({
      source,
      operator: opts?.operator ?? source,
    });
  }

  /** How much of a relayer's unstake is pending, when it unlocks, and whether it is. */
  async getUnbondingStatus(opts?: { operator?: string; source?: string }): Promise<UnbondingStatus> {
    const source = await resolveReadSource(this.ctx, opts?.source);
    return this.ctx.contracts.relayerRegistry.getUnbondingStatus({
      source,
      operator: opts?.operator ?? source,
    });
  }

  /** The registry's job status codes, read from the contract rather than hardcoded. */
  async jobStatuses(opts?: { source?: string }): Promise<JobStatus> {
    return this.ctx.contracts.relayerRegistry.jobStatuses(
      await resolveReadSource(this.ctx, opts?.source),
    );
  }

  /** A relayer's slashing record, or null when they have never been slashed. */
  async getSlashingRecord(opts: {
    relayer: string;
    source?: string;
  }): Promise<RelayerSlashRecord | null> {
    return this.ctx.contracts.relayerRegistry.getSlashingRecord({
      source: await resolveReadSource(this.ctx, opts.source),
      relayer: opts.relayer,
    });
  }

  /** Basis points of a relayer's original stake slashed so far (0 when clean). */
  async getSlashingPercentage(opts: { relayer: string; source?: string }): Promise<number> {
    return this.ctx.contracts.relayerRegistry.getSlashingPercentage({
      source: await resolveReadSource(this.ctx, opts.source),
      relayer: opts.relayer,
    });
  }

  // --- relayer operator lifecycle --------------------------------------------
  //
  // The relayer side of the market, driven from the operator account itself.
  // The registry is a contract, not an off-chain process, so an operator key is
  // enough to run a relayer: no separate daemon identity to secure.

  /**
   * Register this operator with the registry, escrowing the initial stake. The
   * operator authorizes the call and the stake transfer, so the SDK needs no
   * managed key — an HSM or hardware wallet can sign it.
   */
  async register(opts: {
    x25519Pubkey: Uint8Array;
    endpoint: string;
    stake: bigint;
  }): Promise<string> {
    return this.ctx.contracts.relayerRegistry.register({
      ...opts,
      signer: this.ctx.requireSigner(),
    });
  }

  /** Add stake to the operator's free (unbonded) balance. */
  async addStake(opts: { amount: bigint }): Promise<string> {
    return this.ctx.contracts.relayerRegistry.addStake({
      ...opts,
      signer: this.ctx.requireSigner(),
    });
  }

  /**
   * Queue stake out of the operator's free balance. The queue unlocks after
   * `config.unstakeCooldownLedgers`; read `getUnbondingStatus` to see when
   * rather than waiting a fixed number of ledgers.
   */
  async requestUnstake(opts: { amount: bigint }): Promise<string> {
    return this.ctx.contracts.relayerRegistry.requestUnstake({
      ...opts,
      signer: this.ctx.requireSigner(),
    });
  }

  /**
   * Withdraw the pending unstake once its cooldown has elapsed. Reverts
   * `UnstakeLocked` before then — check `getUnbondingStatus().isUnlockable`.
   */
  async withdrawStake(): Promise<string> {
    return this.ctx.contracts.relayerRegistry.withdrawStake({
      signer: this.ctx.requireSigner(),
    });
  }

  /** Accept an open job, bonding its fee against the operator's stake. */
  async acceptJob(opts: { jobId: Uint8Array }): Promise<string> {
    return this.ctx.contracts.relayerRegistry.acceptJob({
      ...opts,
      signer: this.ctx.requireSigner(),
    });
  }

  /**
   * Submit an accepted job: relays the pool withdrawal and collects the fee.
   * The registry re-hashes the payload, so a payload that drifts from the
   * escrowed hash fails here rather than on the pool.
   */
  async submitPoolWithdraw(opts: Omit<Parameters<RelayerRegistry["submitPoolWithdraw"]>[0], "signer">): Promise<string> {
    return this.ctx.contracts.relayerRegistry.submitPoolWithdraw({
      ...opts,
      signer: this.ctx.requireSigner(),
    });
  }

  /** Report an offense and slash a relayer's stake, collecting the reward. */
  async reportSlash(opts: {
    proof: SlashingProof;
    slashAmount: bigint;
  }): Promise<string> {
    return this.ctx.contracts.relayerRegistry.reportSlash({
      ...opts,
      signer: this.ctx.requireSigner(),
    });
  }
}
