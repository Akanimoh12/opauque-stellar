/**
 * Contract-binding argument construction. Drives each binding through a stub
 * invoker that captures the invoke options, then decodes the ScVal arguments to
 * assert the exact on-chain call shape (method, contract, and argument values).
 * This guards the wire format without needing a network.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Keypair, rpc, xdr } from "@stellar/stellar-sdk";
import {
  StealthRegistry,
  StealthAnnouncer,
  SchemaRegistry,
  AttestationEngine,
  Groth16Verifier,
  PrivacyPool,
  RelayerRegistry,
  MultisigAdmin,
  keypairSigner,
  fromScVal,
  addressToScVal,
  bytesToScVal,
  u64ToScVal,
  keysToStealthMetaAddress,
  type ContractInvoker,
  type InvokeOptions,
} from "../../src/index";

class CaptureInvoker implements ContractInvoker {
  last?: InvokeOptions;
  lastRead?: { source: string; contractId: string; method: string };
  reads: Record<string, unknown> = {};
  /** Canned `getEvents` pages, consumed in order (one per call; an `Error` entry is thrown). */
  eventPages: (rpc.Api.GetEventsResponse | Error)[] = [];
  eventsCallCount = 0;
  latestLedgerValue = 0;
  async invoke(opts: InvokeOptions): Promise<string> {
    this.last = opts;
    return "TXHASH";
  }
  async readNative<T>(opts: {
    source: string;
    contractId: string;
    method: string;
  }): Promise<T> {
    this.lastRead = opts;
    if (opts.method in this.reads) return this.reads[opts.method] as T;
    throw new Error("not used");
  }
  async simulateRead(): Promise<xdr.ScVal | undefined> {
    throw new Error("not used");
  }
  async getEvents(): Promise<rpc.Api.GetEventsResponse> {
    this.eventsCallCount++;
    const next = this.eventPages.shift();
    if (next instanceof Error) throw next;
    return next ?? ({ events: [], latestLedger: 0, cursor: "" } as unknown as rpc.Api.GetEventsResponse);
  }
  async getLatestLedger(): Promise<number> {
    return this.latestLedgerValue;
  }
}

const keypair = Keypair.random();
const signer = keypairSigner(keypair);
const PK = keypair.publicKey();
const C = "CAIXWMGYZR3YAQ3CPCXOU42WG62E3ARUSG4GDHHDMNRXUD44YSGE5VXW";
const DELEGATE = "GCMPINZMMQVQ7MWIJLB34F5JRAHLQQTWCP6XB5HEZR353PPPWRUWHLPU";

let inv: CaptureInvoker;
beforeEach(() => {
  inv = new CaptureInvoker();
});

const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill);
const decoded = () => inv.last!.args.map(fromScVal);

describe("payments bindings", () => {
  // A real on-curve meta-address, not a bytes(66) filler: registerKeys now
  // validates on-curve-ness client-side before submitting (#736), so a
  // meta-address of arbitrary filler bytes is correctly rejected rather than
  // reaching this stub invoker.
  const validMetaAddress = keysToStealthMetaAddress(
    bytes(32, 1),
    bytes(32, 2),
  ).metaAddress;

  it("registerKeys encodes [address, u64 scheme, bytes meta]", async () => {
    await new StealthRegistry(inv, C).registerKeys({
      stealthMetaAddress: validMetaAddress,
      signer,
    });
    expect(inv.last!.method).toBe("register_keys");
    expect(inv.last!.contractId).toBe(C);
    expect(inv.last!.source).toBe(PK);
    const a = decoded();
    expect(a[0]).toBe(PK);
    expect(a[1]).toBe(1n); // default secp256k1 scheme
    expect((a[2] as Uint8Array).length).toBe(66);
  });

  it("registerKeys rejects a well-formed-prefix, off-curve meta-address (#736)", async () => {
    // Prefix bytes are valid (0x02/0x03), but the 32-byte "x-coordinates" are
    // 0xFF repeated - >= the secp256k1 field prime, so neither half can be a
    // real curve point. The on-chain registry's own check is length+prefix
    // only and would have accepted this; the SDK must reject it first.
    const offCurveView = new Uint8Array(33);
    offCurveView[0] = 0x02;
    offCurveView.fill(0xff, 1);
    const offCurveSpend = new Uint8Array(33);
    offCurveSpend[0] = 0x03;
    offCurveSpend.fill(0xff, 1);
    const offCurveMetaAddress = new Uint8Array(66);
    offCurveMetaAddress.set(offCurveView, 0);
    offCurveMetaAddress.set(offCurveSpend, 33);

    await expect(
      new StealthRegistry(inv, C).registerKeys({
        stealthMetaAddress: offCurveMetaAddress,
        signer,
      }),
    ).rejects.toThrow(/secp256k1/);
    expect(inv.last).toBeUndefined();
  });

  it("announce encodes [address, u64, bytes x3]", async () => {
    await new StealthAnnouncer(inv, C).announce({
      stealthAddress: bytes(20),
      ephemeralPubKey: bytes(33),
      metadata: new Uint8Array([0x2a]),
      signer,
    });
    expect(inv.last!.method).toBe("announce");
    const a = decoded();
    expect(a[0]).toBe(PK);
    expect(a[1]).toBe(1n);
    expect((a[2] as Uint8Array).length).toBe(20);
    expect((a[3] as Uint8Array).length).toBe(33);
    expect(Array.from(a[4] as Uint8Array)).toEqual([0x2a]);
  });

  const announcementEvent = (opts: { stealthAddress: number; ephemeralPubKey: number; viewTag: number; ledger: number }) =>
    ({
      value: xdr.ScVal.scvVec([
        u64ToScVal(1n),
        bytesToScVal(bytes(20, opts.stealthAddress)),
        addressToScVal(PK),
        bytesToScVal(bytes(33, opts.ephemeralPubKey)),
        bytesToScVal(new Uint8Array([opts.viewTag])),
      ]),
      ledger: opts.ledger,
    }) as unknown as rpc.Api.EventResponse;

  it("scanEvents decodes Announcement events into pages with a ledger cursor", async () => {
    inv.eventPages = [
      {
        events: [
          announcementEvent({ stealthAddress: 1, ephemeralPubKey: 2, viewTag: 0x2a, ledger: 100 }),
          announcementEvent({ stealthAddress: 3, ephemeralPubKey: 4, viewTag: 0x2b, ledger: 105 }),
        ],
        latestLedger: 105,
        cursor: "",
      } as unknown as rpc.Api.GetEventsResponse,
    ];

    const pages = [];
    for await (const page of new StealthAnnouncer(inv, C).scanEvents({ startLedger: 1 })) {
      pages.push(page);
    }
    expect(pages.length).toBe(1);
    expect(pages[0].ledger).toBe(105);
    expect(pages[0].announcements.length).toBe(2);
    expect(pages[0].announcements[0].stealthAddress).toBe("0x" + "01".repeat(20));
    expect(pages[0].announcements[0].ephemeralPubKey.length).toBe(33);
    expect(pages[0].announcements[1].viewTag).toBe(0x2b);
  });

  it("scanEvents retries with the retained-window start ledger on a range error", async () => {
    inv.eventPages = [
      new Error("startLedger must be within the ledger range: 900 - 2000"),
      {
        events: [announcementEvent({ stealthAddress: 5, ephemeralPubKey: 6, viewTag: 1, ledger: 950 })],
        latestLedger: 950,
        cursor: "",
      } as unknown as rpc.Api.GetEventsResponse,
    ];

    const pages = [];
    for await (const page of new StealthAnnouncer(inv, C).scanEvents({ startLedger: 1 })) {
      pages.push(page);
    }
    expect(inv.eventsCallCount).toBe(2);
    expect(pages.length).toBe(1);
    expect(pages[0].ledger).toBe(950);
  });

  it("scanEvents stops paging once the consumer breaks early", async () => {
    inv.eventPages = [
      {
        events: [announcementEvent({ stealthAddress: 7, ephemeralPubKey: 8, viewTag: 1, ledger: 100 })],
        latestLedger: 100,
        cursor: "page1",
      } as unknown as rpc.Api.GetEventsResponse,
      {
        events: [announcementEvent({ stealthAddress: 9, ephemeralPubKey: 10, viewTag: 1, ledger: 200 })],
        latestLedger: 200,
        cursor: "",
      } as unknown as rpc.Api.GetEventsResponse,
    ];

    for await (const _page of new StealthAnnouncer(inv, C).scanEvents({ startLedger: 1 })) {
      break;
    }
    expect(inv.eventsCallCount).toBe(1);
  });
});

describe("attestation bindings", () => {
  it("registerSchema encodes authority key bytes and null resolver", async () => {
    await new SchemaRegistry(inv, C).registerSchema({
      schemaId: bytes(32),
      name: "credit",
      fieldDefinitions: "u64 score",
      revocable: true,
      schemaExpiryLedger: 5_000_000,
      signer,
    });
    expect(inv.last!.method).toBe("register_schema");
    const a = decoded();
    expect(a[0]).toBe(PK);
    expect((a[1] as Uint8Array).length).toBe(32); // decoded ed25519 authority key
    expect((a[2] as Uint8Array).length).toBe(32); // schema id
    expect(a[3]).toBe("credit");
    expect(a[4]).toBe("u64 score");
    expect(a[5]).toBe(true);
    expect(a[6]).toBe(1); // default version
    expect(a[8]).toBe(5_000_000);
  });

  it("addDelegate rejects a non-G delegate", async () => {
    await expect(
      new SchemaRegistry(inv, C).addDelegate({ schemaId: bytes(32), delegate: "nope", signer }),
    ).rejects.toThrow();
  });

  it("attest encodes the issuer + schema + payload", async () => {
    await new AttestationEngine(inv, C).attest({
      schemaId: bytes(32),
      stealthAddressHash: bytes(32),
      data: bytes(8),
      expirationLedger: 6_000_000,
      refUid: bytes(32, 0),
      signer,
    });
    expect(inv.last!.method).toBe("attest");
    const a = decoded();
    expect(a[0]).toBe(PK);
    expect(a[4]).toBe(6_000_000);
  });
});

describe("verifier binding", () => {
  it("verifyProofV2 encodes proofs + a 4-key public-signal map", async () => {
    await new Groth16Verifier(inv, C).verifyProofV2({
      proofA: bytes(64),
      proofB: bytes(128),
      proofC: bytes(64),
      merkleRoot: bytes(32, 1),
      attestationId: bytes(32, 2),
      externalNullifier: bytes(32, 3),
      nullifierHash: bytes(32, 4),
      signer,
    });
    expect(inv.last!.method).toBe("verify_proof_v2");
    const a = decoded();
    expect((a[0] as Uint8Array).length).toBe(64);
    expect((a[1] as Uint8Array).length).toBe(128);
    const map = a[3] as Record<string, Uint8Array>;
    expect(Object.keys(map).sort()).toEqual([
      "attestation_id",
      "external_nullifier",
      "merkle_root",
      "nullifier_hash",
    ]);
    expect(map.merkle_root.length).toBe(32);
  });
});

describe("pool binding", () => {
  it("deposit encodes [address, i128 value, bytes commitment, u64 index]", async () => {
    await new PrivacyPool(inv, C).deposit({
      value: 5_000_000n,
      commitment: bytes(32),
      expectedIndex: 3,
      signer,
    });
    expect(inv.last!.method).toBe("deposit");
    const a = decoded();
    expect(a[0]).toBe(PK);
    expect(a[1]).toBe(5_000_000n);
    expect((a[2] as Uint8Array).length).toBe(32);
    expect(a[3]).toBe(3n);
  });

  it("withdraw encodes 11 args ending in recipient, i128 fee, relayer", async () => {
    await new PrivacyPool(inv, C).withdraw({
      proofA: bytes(64),
      proofB: bytes(128),
      proofC: bytes(64),
      withdrawnValue: 4_000_000n,
      stateRoot: bytes(32),
      aspRoot: bytes(32),
      nullifierHash: bytes(32),
      newCommitment: bytes(32),
      recipient: DELEGATE,
      fee: 0n,
      relayer: PK,
      signer,
    });
    const a = decoded();
    expect(a.length).toBe(11);
    expect(a[3]).toBe(4_000_000n);
    expect(a[8]).toBe(DELEGATE);
    expect(a[9]).toBe(0n);
    expect(a[10]).toBe(PK);
  });

  it("updateRoot selects the method by kind", async () => {
    const pool = new PrivacyPool(inv, C);
    await pool.updateRoot({ kind: "state", root: bytes(32), datasetHash: bytes(32), signer });
    expect(inv.last!.method).toBe("update_state_root");
    await pool.updateRoot({ kind: "asp", root: bytes(32), datasetHash: bytes(32), signer });
    expect(inv.last!.method).toBe("update_asp_root");
  });

  it("getConfig decodes the on-chain PoolConfig struct", async () => {
    inv.reads.get_config = {
      admin: DELEGATE,
      groth16_verifier: "CGROTH16",
      native_sac: "CNATIVESAC",
      scope: 1,
      root_expiry_ledgers: 17_280,
    };
    const config = await new PrivacyPool(inv, C).getConfig(PK);
    expect(inv.lastRead).toEqual({ source: PK, contractId: C, method: "get_config", args: [] });
    expect(config).toEqual({
      admin: DELEGATE,
      groth16Verifier: "CGROTH16",
      nativeSac: "CNATIVESAC",
      scope: 1,
      rootExpiryLedgers: 17_280,
    });
  });

  it("getNativeAssetDecimals reads live config then the SAC's decimals", async () => {
    inv.reads.get_config = {
      admin: DELEGATE,
      groth16_verifier: "CGROTH16",
      native_sac: "CNATIVESAC",
      scope: 1,
      root_expiry_ledgers: 17_280,
    };
    inv.reads.decimals = 7;
    const decimals = await new PrivacyPool(inv, C).getNativeAssetDecimals(PK);
    expect(decimals).toBe(7);
    expect(inv.lastRead).toEqual({
      source: PK,
      contractId: "CNATIVESAC",
      method: "decimals",
      args: [],
    });
  });
});

describe("relayer binding", () => {
  it("createJob encodes [address, bytes id, bytes hash, u32 deadline, i128 fee]", async () => {
    await new RelayerRegistry(inv, C).createJob({
      jobId: bytes(32),
      payloadHash: bytes(32),
      deadlineLedger: 3_200_000,
      fee: 1_000_000n,
      signer,
    });
    expect(inv.last!.method).toBe("create_job");
    const a = decoded();
    expect(a[0]).toBe(PK);
    expect(a[3]).toBe(3_200_000);
    expect(a[4]).toBe(1_000_000n);
  });

  it("cancelJob and slashJob use the right method names", async () => {
    const reg = new RelayerRegistry(inv, C);
    await reg.cancelJob({ jobId: bytes(32), signer });
    expect(inv.last!.method).toBe("cancel_job");
    await reg.slashJob({ jobId: bytes(32), signer });
    expect(inv.last!.method).toBe("slash_job");
  });
});

describe("multisig-admin binding", () => {
  it("proposeCall encodes [address proposer, address target, symbol fn_name, vec args]", async () => {
    await new MultisigAdmin(inv, C).proposeCall({
      target: DELEGATE,
      fnName: "publish_root",
      args: [bytesToScVal(bytes(32)), u64ToScVal(42n)],
      signer,
    });
    expect(inv.last!.method).toBe("propose_call");
    expect(inv.last!.contractId).toBe(C);
    expect(inv.last!.source).toBe(PK);
    const a = decoded();
    expect(a[0]).toBe(PK);
    expect(a[1]).toBe(DELEGATE);
    expect(a[2]).toBe("publish_root");
    expect(Array.isArray(a[3])).toBe(true);
    expect((a[3] as unknown[]).length).toBe(2);
  });

  it("proposeRotation encodes [address proposer, vec new_signers, u32 new_threshold]", async () => {
    await new MultisigAdmin(inv, C).proposeRotation({
      newSigners: [PK, DELEGATE],
      newThreshold: 2,
      signer,
    });
    expect(inv.last!.method).toBe("propose_rotation");
    const a = decoded();
    expect(a[0]).toBe(PK);
    expect(a[1]).toEqual([PK, DELEGATE]);
    expect(a[2]).toBe(2);
  });

  it("approve encodes [address signer, bytesN proposal_id]", async () => {
    const proposalId = bytes(32, 9);
    await new MultisigAdmin(inv, C).approve({ proposalId, signer });
    expect(inv.last!.method).toBe("approve");
    const a = decoded();
    expect(a[0]).toBe(PK);
    expect((a[1] as Uint8Array).length).toBe(32);
  });

  it("getConfig decodes the on-chain MultisigConfig struct", async () => {
    inv.reads.get_config = { signers: [PK, DELEGATE], threshold: 2 };
    const config = await new MultisigAdmin(inv, C).getConfig(PK);
    expect(inv.lastRead).toEqual({ source: PK, contractId: C, method: "get_config", args: [] });
    expect(config).toEqual({ signers: [PK, DELEGATE], threshold: 2 });
  });

  it("getProposal decodes the on-chain Proposal struct", async () => {
    const id = bytes(32, 3);
    inv.reads.get_proposal = {
      id,
      is_rotation: false,
      target: DELEGATE,
      fn_name: "publish_root",
      new_signers: [],
      new_threshold: 0,
      proposer: PK,
      approvals: [PK],
      executed: false,
      created_at: 1234,
    };
    const proposal = await new MultisigAdmin(inv, C).getProposal(PK, id);
    expect(proposal.target).toBe(DELEGATE);
    expect(proposal.fnName).toBe("publish_root");
    expect(proposal.approvals).toEqual([PK]);
    expect(proposal.executed).toBe(false);
    expect(proposal.createdAt).toBe(1234);
  });

  it("isSigner reads is_signer for the given address", async () => {
    inv.reads.is_signer = true;
    const result = await new MultisigAdmin(inv, C).isSigner(PK, DELEGATE);
    expect(result).toBe(true);
    expect(inv.lastRead!.method).toBe("is_signer");
  });
});
