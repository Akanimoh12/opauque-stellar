/**
 * Bindings for the stealth-registry and stealth-announcer contracts: publish a
 * meta-address and announce a one-time stealth transfer.
 */
import { scValToNative, xdr } from "@stellar/stellar-sdk";
import type { ContractInvoker } from "../rpc/client";
import type { OpaqueSigner } from "../signer/index";
import { addressToScVal, bytesToScVal, u64ToScVal } from "../rpc/scval";
import { parseOldestLedgerFromRangeError } from "../rpc/diagnostics";
import type { StealthAnnouncement } from "../crypto/index";
import { assertValidStealthMetaAddress } from "../crypto/dksap";

/** secp256k1 stealth scheme id, as registered on-chain. */
export const SCHEME_ID_SECP256K1 = 1n;

const ANNOUNCEMENT_EVENT_LOOKBACK = 16_000;
const ANNOUNCEMENT_TOPIC = xdr.ScVal.scvSymbol("Announcement").toXDR("base64");

/** A page of `Announcement` events, plus the highest ledger it covered. */
export interface AnnouncementPage {
  announcements: StealthAnnouncement[];
  /** Highest ledger seen in this page — a resumable cursor for the next scan. */
  ledger: number;
}

export class StealthRegistry {
  constructor(
    private readonly rpc: ContractInvoker,
    readonly contractId: string,
  ) {}

  /** Read the deployed contract interface version. */
  async version(source: string): Promise<number> {
    return Number(
      await this.rpc.readNative<number>({
        source,
        contractId: this.contractId,
        method: "version",
        args: [],
      }),
    );
  }

  /** Register a stealth meta-address for the signer's account. */
  async registerKeys(opts: {
    stealthMetaAddress: Uint8Array;
    schemeId?: bigint;
    signer: OpaqueSigner;
  }): Promise<string> {
    // Reject a malformed/off-curve key before it ever reaches the chain
    // (#736). The on-chain registry only checks length + prefix byte; a
    // garbage key that passes that check would register successfully and
    // be silently unusable to anyone who later tries to send to it.
    assertValidStealthMetaAddress(opts.stealthMetaAddress);
    const source = await opts.signer.publicKey();
    return this.rpc.invoke({
      source,
      contractId: this.contractId,
      method: "register_keys",
      contractPackage: "stealth-registry",
      args: [
        addressToScVal(source),
        u64ToScVal(opts.schemeId ?? SCHEME_ID_SECP256K1),
        bytesToScVal(opts.stealthMetaAddress),
      ],
      signer: opts.signer,
    });
  }

  /**
   * Resolve a registered G-address to its stealth meta-address.
   *
   * Returns the meta-address bytes if the address has registered keys,
   * or `null` if no registration exists.
   */
  async resolve(opts: {
    address: string;
    source: string;
  }): Promise<Uint8Array | null> {
    try {
      const result = await this.rpc.readNative<Uint8Array>({
        source: opts.source,
        contractId: this.contractId,
        method: "resolve",
        args: [addressToScVal(opts.address)],
      });
      return result ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Resolve a registered G-address at a historical ledger.
   *
   * Returns the meta-address bytes if the address had registered keys
   * at the given ledger, or `null` otherwise.
   */
  async resolveHistorical(opts: {
    address: string;
    source: string;
    ledger: number;
  }): Promise<Uint8Array | null> {
    try {
      const result = await this.rpc.readNative<Uint8Array>({
        source: opts.source,
        contractId: this.contractId,
        method: "resolve_historical",
        args: [addressToScVal(opts.address), u64ToScVal(BigInt(opts.ledger))],
      });
      return result ?? null;
    } catch {
      return null;
    }
  }
}

export class StealthAnnouncer {
  constructor(
    private readonly rpc: ContractInvoker,
    readonly contractId: string,
  ) {}

  /** Read the deployed contract interface version. */
  async version(source: string): Promise<number> {
    return Number(
      await this.rpc.readNative<number>({
        source,
        contractId: this.contractId,
        method: "version",
        args: [],
      }),
    );
  }

  /** Announce a one-time stealth transfer (stealth id + ephemeral key + view tag). */
  async announce(opts: {
    stealthAddress: Uint8Array;
    ephemeralPubKey: Uint8Array;
    metadata: Uint8Array;
    schemeId?: bigint;
    signer: OpaqueSigner;
  }): Promise<string> {
    const source = await opts.signer.publicKey();
    return this.rpc.invoke({
      source,
      contractId: this.contractId,
      method: "announce",
      contractPackage: "stealth-announcer",
      args: [
        addressToScVal(source),
        u64ToScVal(opts.schemeId ?? SCHEME_ID_SECP256K1),
        bytesToScVal(opts.stealthAddress),
        bytesToScVal(opts.ephemeralPubKey),
        bytesToScVal(opts.metadata),
      ],
      signer: opts.signer,
    });
  }

  /**
   * Stream `Announcement` events page-by-page instead of resolving only after
   * scanning the full range. `startLedger` is inclusive (as with the
   * underlying `getEvents` call) — pass `ledger + 1` from a previous page to
   * resume without re-reading (and re-yielding) its events. Stopping
   * iteration early (`break` in a `for await`, or calling `.return()`) stops
   * further `getEvents` calls — no dangling requests keep running after the
   * consumer walks away.
   */
  async *scanEvents(opts?: {
    startLedger?: number;
  }): AsyncGenerator<AnnouncementPage, void, unknown> {
    const latest = await this.rpc.getLatestLedger();
    let startLedger =
      opts?.startLedger && opts.startLedger > 0
        ? opts.startLedger
        : Math.max(1, latest - ANNOUNCEMENT_EVENT_LOOKBACK);

    const filters = [
      {
        type: "contract" as const,
        contractIds: [this.contractId],
        topics: [[ANNOUNCEMENT_TOPIC, "*"]],
      },
    ];

    let cursor: string | undefined;
    let prevCursor: string | undefined;
    for (let page = 0; page < 200; page++) {
      let res;
      try {
        res = await this.rpc.getEvents(
          cursor ? { cursor, filters, limit: 100 } : { startLedger, filters, limit: 100 },
        );
      } catch (err) {
        const oldest = parseOldestLedgerFromRangeError(err);
        if (!cursor && oldest != null && startLedger < oldest) {
          startLedger = oldest;
          res = await this.rpc.getEvents({ startLedger, filters, limit: 100 });
        } else {
          throw err;
        }
      }

      const announcements: StealthAnnouncement[] = [];
      let ledger = startLedger;
      for (const ev of res.events ?? []) {
        const data = scValToNative(ev.value) as unknown[];
        const stealthAddress = Buffer.from(data[1] as Uint8Array).toString("hex");
        const ephemeralPubKey = Uint8Array.from(data[3] as Uint8Array);
        const metadata = data[4] as Uint8Array;
        announcements.push({
          stealthAddress: "0x" + stealthAddress,
          ephemeralPubKey,
          viewTag: metadata[0] ?? 0,
        });
        ledger = Math.max(ledger, ev.ledger);
      }

      if (announcements.length > 0) yield { announcements, ledger };

      cursor = res.cursor;
      if (!cursor || cursor === prevCursor) break;
      prevCursor = cursor;
    }
  }
}
