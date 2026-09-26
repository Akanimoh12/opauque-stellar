/**
 * Stealth private payments. Derive an identity and meta-address, register it,
 * send a stealth XLM payment (one-time account + announcement), and sweep a
 * detected stealth account. `scan()` matches against a caller-supplied
 * announcement list; `scanIterator()` reads announcements from chain itself
 * and streams matches incrementally with a resumable cursor.
 */
import {
  computeStealthAddressAndViewTag,
  deriveKeysFromSignature,
  deriveStealthStellarKeypairFromStealthPrivKey,
  hexToBytes,
  keysToStealthMetaAddress,
  parseXlmToStroops,
  scanAnnouncements,
  stealthMetaAddressToHex,
  bytesToHex,
  type Hex,
  type ScanMatch,
  type StealthAnnouncement,
} from "../crypto/index";
import { keypairSigner } from "../signer/index";
import type { OpaqueClientContext } from "./context";

export interface StealthIdentity {
  viewingKey: Uint8Array;
  spendingKey: Uint8Array;
  metaAddress: Uint8Array;
  metaHex: Hex;
}

/**
 * The `ScanStore` key a scan for `identity` persists its cursor under.
 * Keyed by viewing key so one client can watch many identities without their
 * cursors colliding — identity A's scan can no longer resume past ledger N and
 * silently skip identity B's payments.
 */
export function scanCursorKey(
  identity: Pick<StealthIdentity, "viewingKey">,
): string {
  return `vk:${bytesToHex(identity.viewingKey)}`;
}

export class PaymentsService {
  constructor(private readonly ctx: OpaqueClientContext) {}

  /** Derive viewing/spending keys + meta-address from a wallet signature. */
  deriveIdentity(signatureHex: string): StealthIdentity {
    const { viewingKey, spendingKey } = deriveKeysFromSignature(signatureHex);
    const { metaAddress } = keysToStealthMetaAddress(viewingKey, spendingKey);
    return {
      viewingKey,
      spendingKey,
      metaAddress,
      metaHex: stealthMetaAddressToHex(metaAddress),
    };
  }

  /** Register a stealth meta-address for the signer's account. */
  async register(opts: { metaAddress: Uint8Array }): Promise<string> {
    return this.ctx.contracts.stealthRegistry.registerKeys({
      stealthMetaAddress: opts.metaAddress,
      signer: this.ctx.requireSigner(),
    });
  }

  /** Pure: compute a one-time stealth address + announcement params for a recipient. */
  prepareTransfer(recipientMetaHex: string) {
    return computeStealthAddressAndViewTag(recipientMetaHex);
  }

  /**
   * Send a stealth XLM payment: pay the one-time stealth Stellar account, then
   * publish the announcement so the recipient can detect and sweep it.
   */
  async send(opts: {
    to: string;
    amountXlm: string;
  }): Promise<{
    stealthStellarAddress: string;
    ephemeralPubKey: Uint8Array;
    paymentTxHash: string;
    announceTxHash: string;
  }> {
    const signer = this.ctx.requireSigner();
    const stealth = computeStealthAddressAndViewTag(opts.to);
    const amountStroops = parseXlmToStroops(opts.amountXlm);

    const paymentTxHash = await this.ctx.sendNativeTransfer({
      destination: stealth.stealthStellarAddress,
      amountStroops,
      signer,
    });
    const announceTxHash = await this.ctx.contracts.stealthAnnouncer.announce({
      stealthAddress: hexToBytes(stealth.stealthAddress),
      ephemeralPubKey: stealth.ephemeralPubKey,
      metadata: stealth.metadata,
      signer,
    });
    return {
      stealthStellarAddress: stealth.stealthStellarAddress,
      ephemeralPubKey: stealth.ephemeralPubKey,
      paymentTxHash,
      announceTxHash,
    };
  }

  /**
   * Sweep a detected stealth account to a destination. The stealth account signs
   * itself (derived from the one-time key), so the connected wallet is never the
   * source. `amountStroops` is the exact amount to move (compute the spendable
   * balance from Horizon, reserving fee + minimum balance).
   */
  async sweep(opts: {
    stealthPrivKey: Uint8Array;
    destination: string;
    amountStroops: bigint;
  }): Promise<string> {
    const keypair = deriveStealthStellarKeypairFromStealthPrivKey(opts.stealthPrivKey);
    return this.ctx.sendNativeTransfer({
      destination: opts.destination,
      amountStroops: opts.amountStroops,
      signer: keypairSigner(keypair),
    });
  }

  /**
   * Scan announcements for transfers addressed to `identity`, returning each
   * match with its reconstructed one-time key and Stellar account. The caller
   * supplies the announcements (read from the stealth-announcer contract events).
   */
  scan(opts: {
    announcements: StealthAnnouncement[];
    identity: Pick<StealthIdentity, "viewingKey" | "spendingKey">;
  }): ScanMatch[] {
    return scanAnnouncements({
      announcements: opts.announcements,
      viewingKey: opts.identity.viewingKey,
      spendingKey: opts.identity.spendingKey,
    });
  }

  /**
   * Stream announcement matches from chain instead of waiting for the full
   * range to resolve: each match yields as soon as it is found, and the scan
   * position persists to the configured `ScanStore` after every page so a
   * caller can resume later without re-reading (and re-yielding) events already
   * seen. Stop early (`break` out of the `for await`) to release the scan
   * without reading further pages.
   *
   * The cursor is **per identity** (keyed by viewing key, see
   * {@link scanCursorKey}), so several identities can be watched from one
   * client without one identity's scan resuming past another's.
   *
   * The cursor also advances through ranges that hold no announcements: a page
   * that comes back quiet still counts as scanned, and the last page of a
   * drained scan persists `endLedger` — the end of the whole scanned range, not
   * just the last transfer in it. Without that, a quiet range would be re-read
   * on every single run, forever.
   *
   * @throws EventTruncationError when the event page cap is hit with events
   * left unread (transfers may be missing). The persisted cursor is left at
   * the last fully-read page, so the next run resumes exactly there. Pass
   * `allowTruncation` to accept a partial scan instead of failing.
   */
  async *scanIterator(
    opts: ScanIteratorOptions,
  ): AsyncGenerator<ScanMatch & { ledger: number }> {
    const cursorKey = opts.cursorKey ?? scanCursorKey(opts.identity);
    let startLedger = opts.startLedger;
    if (startLedger == null && !opts.skipCursor) {
      const cursor = await this.ctx.scanStore.getCursor(cursorKey);
      // The stored cursor is the last *processed* ledger; resume after it so
      // its events are not re-fetched (`getEvents`' startLedger is inclusive).
      if (cursor != null) startLedger = cursor + 1;
    }

    for await (const page of this.ctx.contracts.stealthAnnouncer.scanEvents({
      startLedger,
      maxPages: opts.maxPages,
      throwOnTruncation: !opts.allowTruncation,
    })) {
      for (const match of scanAnnouncements({
        announcements: page.announcements,
        viewingKey: opts.identity.viewingKey,
        spendingKey: opts.identity.spendingKey,
      })) {
        yield { ...match, ledger: page.ledger };
      }
      if (!opts.skipCursor) {
        // A page that drained the scan read every ledger up to `endLedger` —
        // quiet ones included — so persist that rather than the last transfer's
        // ledger, and the next run starts after the whole range.
        await this.ctx.scanStore.setCursor(
          page.complete ? page.endLedger : page.ledger,
          cursorKey,
        );
      }
    }
  }
}

/** Options for {@link PaymentsService.scanIterator}. */
export interface ScanIteratorOptions {
  identity: Pick<StealthIdentity, "viewingKey" | "spendingKey">;
  /** Resume from this ledger instead of the persisted cursor. */
  startLedger?: number;
  /** Skip reading/writing the persisted cursor (default false). */
  skipCursor?: boolean;
  /**
   * Cursor key to persist under. Defaults to this identity's own key
   * ({@link scanCursorKey}); override only to share one cursor across
   * identities that scan the same range.
   */
  cursorKey?: string;
  /** Event page cap before the scan is treated as truncated (default 200). */
  maxPages?: number;
  /**
   * Return a partial scan instead of throwing {@link EventTruncationError} when
   * the page cap is hit (default false). Only safe when the caller can detect
   * the gap some other way — a truncated scan may have missed transfers.
   */
  allowTruncation?: boolean;
}
