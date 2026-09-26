/**
 * Pool state reads and the pre-proving coverage check (issue #1005).
 *
 * A withdrawal proof is the expensive step, and it is wasted work if the pool
 * will not accept the result: no root published yet, a root the contract does
 * not know, a pause in effect, or a full tree. `isDepositCovered` composes the
 * pool's own views into one read and says which of those is blocking, so the
 * check can gate proving instead of guessing.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Keypair, xdr } from "@stellar/stellar-sdk";
import {
  OpaqueClient,
  keypairSigner,
  type ContractInvoker,
  type ReadOptions,
} from "../../src/index";

const PK = Keypair.random().publicKey();
const ROOT = new Uint8Array(32).fill(9);

class StubInvoker implements ContractInvoker {
  reads: Record<string, unknown> = {};
  readMethods: string[] = [];

  async invoke(): Promise<string> {
    return "TXHASH";
  }
  async readNative<T>(opts: ReadOptions): Promise<T> {
    this.readMethods.push(opts.method);
    if (opts.method in this.reads) return this.reads[opts.method] as T;
    throw new Error(`unstubbed read: ${opts.method}`);
  }
  async simulateRead(): Promise<xdr.ScVal | undefined> {
    return undefined;
  }
  async getEvents(): Promise<never> {
    throw new Error("not used");
  }
  async getLatestLedger(): Promise<number> {
    return 5_000;
  }
}

let inv: StubInvoker;
let client: OpaqueClient;
beforeEach(() => {
  inv = new StubInvoker();
  client = new OpaqueClient({
    network: "testnet",
    signer: keypairSigner(Keypair.random()),
    invoker: inv,
  });
});

/** Stub the reads `isDepositCovered` composes. */
const stubCoverage = (overrides: Record<string, unknown> = {}) => {
  inv.reads = {
    get_latest_root: Buffer.from(ROOT),
    is_known_state_root: true,
    is_known_asp_root: true,
    is_deposits_paused: false,
    is_withdrawals_paused: false,
    get_tree_capacity_info: {
      max_capacity: 65536,
      current_count: 100,
      depth: 10,
      last_updated: 1_700_000_000,
    },
    ...overrides,
  };
};

describe("PoolService state reads", () => {
  it("getTreeCapacityInfo decodes the contract struct and derives utilization", async () => {
    inv.reads.get_tree_capacity_info = {
      max_capacity: 1_000,
      current_count: 250,
      depth: 8,
      last_updated: 1_700_000_000,
    };
    const capacity = await client.pool.getTreeCapacityInfo();
    expect(capacity.maxCapacity).toBe(1_000);
    expect(capacity.currentCount).toBe(250);
    expect(capacity.depth).toBe(8);
    expect(capacity.utilization).toBe(0.25);
  });

  it("getCustody reports deposited, withdrawn, and what is still held", async () => {
    inv.reads.get_custody = [1_000n, 400n];
    const custody = await client.pool.getCustody();
    expect(custody.totalDeposited).toBe(1_000n);
    expect(custody.totalWithdrawn).toBe(400n);
    expect(custody.netHeld).toBe(600n);
  });

  it("getWithdrawalPauseRequest turns the (requested, activates) pair into a countdown", async () => {
    inv.reads.get_withdrawal_pause_request = [4_000, 4_500];
    const pause = await client.pool.getWithdrawalPauseRequest();
    expect(pause.pending).toBe(true);
    expect(pause.requestedAt).toBe(4_000);
    expect(pause.activatesAt).toBe(4_500);
    // The stub reports ledger 5_000 as latest, so the pause is already active.
    expect(pause.ledgersUntilActivation).toBe(0);

    inv.reads.get_withdrawal_pause_request = [0, 0];
    const none = await client.pool.getWithdrawalPauseRequest();
    expect(none.pending).toBe(false);
    expect(none.ledgersUntilActivation).toBe(0);
  });

  it("getWithdrawalMinimum reads the threshold in the pool's smallest unit", async () => {
    inv.reads.get_withdrawal_minimum = 1_000_000n;
    expect(await client.pool.getWithdrawalMinimum()).toBe(1_000_000n);
  });

  it("reads accept an explicit source, so a read-only server needs no key", async () => {
    stubCoverage();
    const readonly = new OpaqueClient({ network: "testnet", invoker: inv });
    const coverage = await readonly.pool.isDepositCovered({ source: PK });
    expect(coverage.covered).toBe(true);
  });
});

describe("PoolService.isDepositCovered", () => {
  it("is covered when both roots are published, known, and the pool is open", async () => {
    stubCoverage();
    const coverage = await client.pool.isDepositCovered();
    expect(coverage.covered).toBe(true);
    expect(coverage.reasons).toEqual([]);
    expect(coverage.stateRootKnown).toBe(true);
    expect(coverage.aspRootKnown).toBe(true);
  });

  it("reports a root the contract does not know as unknown, not covered", async () => {
    stubCoverage({ is_known_state_root: false });
    const coverage = await client.pool.isDepositCovered();
    expect(coverage.covered).toBe(false);
    expect(coverage.reasons).toEqual(["unknown-state-root"]);
  });

  it("reports an unpublished root without asking the known-root questions", async () => {
    stubCoverage({ get_latest_root: undefined });
    const coverage = await client.pool.isDepositCovered();
    expect(coverage.covered).toBe(false);
    expect(coverage.reasons).toEqual(["no-state-root", "no-asp-root"]);
    expect(inv.readMethods).not.toContain("is_known_state_root");
  });

  it("reports a withdrawal pause as a reason to wait", async () => {
    stubCoverage({ is_withdrawals_paused: true });
    const coverage = await client.pool.isDepositCovered();
    expect(coverage.covered).toBe(false);
    expect(coverage.reasons).toEqual(["withdrawals-paused"]);
    expect(coverage.withdrawalsPaused).toBe(true);
  });

  it("reports a full tree, since nothing new can be proven against it", async () => {
    stubCoverage({
      get_tree_capacity_info: {
        max_capacity: 1_000,
        current_count: 1_000,
        depth: 8,
        last_updated: 1_700_000_000,
      },
    });
    const coverage = await client.pool.isDepositCovered();
    expect(coverage.covered).toBe(false);
    expect(coverage.reasons).toEqual(["tree-at-capacity"]);
  });

  it("checks specific roots when the caller supplies them", async () => {
    stubCoverage({ is_known_asp_root: false });
    const coverage = await client.pool.isDepositCovered({
      stateRoot: ROOT,
      aspRoot: ROOT,
    });
    expect(coverage.covered).toBe(false);
    expect(coverage.reasons).toEqual(["unknown-asp-root"]);
  });

  it("carries the pause flags and capacity so a UI can explain the answer", async () => {
    stubCoverage({ is_deposits_paused: true });
    const coverage = await client.pool.isDepositCovered();
    expect(coverage.depositsPaused).toBe(true);
    expect(coverage.capacity.currentCount).toBe(100);
    expect(coverage.capacity.maxCapacity).toBe(65_536);
  });
});
