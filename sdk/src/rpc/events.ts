/**
 * Shared `getEvents` pagination for the SDK's contract-event loops (announcement
 * scanning and privacy-pool state reconstruction). Both walk the same protocol —
 * a ledger-range first page, then opaque cursors until one stops advancing — so
 * the mechanics live here once: the retained-window retry, the page cap, and
 * truncation reporting.
 *
 * Truncation is never silent. A loop that just stops at the cap returns an
 * incomplete scan (missed stealth payments) or an incomplete tree (a wrong
 * Merkle root) that is indistinguishable from a complete one. Every page
 * therefore says whether it is the last one, and a caller can ask for an
 * {@link EventTruncationError} instead of a truncated marker.
 */
import type { rpc } from "@stellar/stellar-sdk";
import { EventTruncationError } from "../errors/index";
import { parseOldestLedgerFromRangeError } from "./diagnostics";

/**
 * Default cap on `getEvents` pages per topic per scan (~20k events at the
 * 100-event page size). A scan that reaches it is reported as truncated.
 */
export const EVENT_PAGE_LIMIT = 200;

/** Events requested per `getEvents` page. */
export const EVENT_PAGE_SIZE = 100;

/** Ledgers a topic is scanned back over when the caller gives no start ledger. */
export const EVENT_LOOKBACK_LEDGERS = 16_000;

/** One `getEvents` response, plus how far the scan can be trusted to have read. */
export interface ContractEventPage {
  /** Events from this response, undecoded — each caller decodes its own shape. */
  events: rpc.Api.EventResponse[];
  /** Highest ledger represented in `events` (the scan's start ledger when empty). */
  ledger: number;
  /**
   * Highest ledger the scan has read through. On the final page of a drained
   * scan this covers the quiet ledgers after the last event, so a cursor
   * persisted from it resumes past them instead of rescanning them forever.
   */
  endLedger: number;
  /** True on the last page of a fully drained scan — nothing was left unread. */
  complete: boolean;
  /** True when the page cap stopped the scan with events still unread. */
  truncated: boolean;
  /** Opaque `getEvents` cursor to continue the truncated scan from. */
  continuationCursor?: string;
}

export interface PaginateContractEventsOptions {
  /** Needs only `getEvents` + `getLatestLedger`, so stubs can drive it. */
  invoker: {
    getEvents(request: rpc.Server.GetEventsRequest): Promise<rpc.Api.GetEventsResponse>;
    getLatestLedger(): Promise<number>;
  };
  filters: rpc.Api.EventFilter[];
  /** Label used in truncation errors, e.g. `"privacy-pool:Deposit"`. */
  scope: string;
  /** First ledger to read (inclusive). Defaults to `latest - lookback`. */
  startLedger?: number;
  /** Lookback when no `startLedger` (default {@link EVENT_LOOKBACK_LEDGERS}). */
  lookback?: number;
  /** Events per page (default {@link EVENT_PAGE_SIZE}). */
  pageSize?: number;
  /** Page cap (default {@link EVENT_PAGE_LIMIT}); hitting it is truncation. */
  maxPages?: number;
  /** Raise {@link EventTruncationError} at the cap instead of yielding a marker. */
  throwOnTruncation?: boolean;
}

/**
 * Page through one event topic, yielding one page per `getEvents` response —
 * including the empty ones, which is what lets a caller advance a scan cursor
 * through a quiet range instead of rescanning it on every run.
 *
 * The scan drains when the RPC stops handing back an advancing cursor; the
 * response's `latestLedger` (falling back to the ledger the scan started at) is
 * what `endLedger` reports on that final page.
 *
 * The first page is retried from the oldest retained ledger when the RPC
 * rejects the requested range as outside the retention window.
 */
export async function* paginateContractEvents(
  opts: PaginateContractEventsOptions,
): AsyncGenerator<ContractEventPage, void, unknown> {
  const maxPages = Math.max(1, opts.maxPages ?? EVENT_PAGE_LIMIT);
  const pageSize = opts.pageSize ?? EVENT_PAGE_SIZE;
  const latest = await opts.invoker.getLatestLedger();
  let startLedger =
    opts.startLedger && opts.startLedger > 0
      ? opts.startLedger
      : Math.max(1, latest - (opts.lookback ?? EVENT_LOOKBACK_LEDGERS));

  const filters = opts.filters;
  let cursor: string | undefined;
  let prevCursor: string | undefined;
  // Highest ledger covered by a page read so far; the floor for the next page
  // so a quiet page never walks a yielded ledger backwards.
  let covered = startLedger;

  for (let page = 0; page < maxPages; page++) {
    let res: rpc.Api.GetEventsResponse;
    try {
      res = await opts.invoker.getEvents(
        cursor ? { cursor, filters, limit: pageSize } : { startLedger, filters, limit: pageSize },
      );
    } catch (err) {
      // getEvents pages ~10k ledgers at a time and can return empty pages
      // before the ones holding events; a start ledger older than the
      // retention window is rejected outright, so retry from its floor.
      const oldest = parseOldestLedgerFromRangeError(err);
      if (cursor || oldest == null || startLedger >= oldest) throw err;
      startLedger = oldest;
      covered = Math.max(covered, oldest);
      res = await opts.invoker.getEvents({ startLedger, filters, limit: pageSize });
    }

    const events = res.events ?? [];
    let ledger = covered;
    for (const ev of events) ledger = Math.max(ledger, Number(ev.ledger));
    covered = ledger;
    const endLedger = Math.max(ledger, Number(res.latestLedger ?? 0), latest);

    const nextCursor = res.cursor;
    const drained = !nextCursor || nextCursor === prevCursor;
    if (drained) {
      yield { events, ledger, endLedger, complete: true, truncated: false };
      return;
    }
    if (page + 1 >= maxPages) {
      if (opts.throwOnTruncation) {
        throw new EventTruncationError({
          scope: opts.scope,
          pagesRead: maxPages,
          pageCap: maxPages,
          lastScannedLedger: ledger,
          continuationCursor: nextCursor,
        });
      }
      yield {
        events,
        ledger,
        endLedger,
        complete: false,
        truncated: true,
        continuationCursor: nextCursor,
      };
      return;
    }
    prevCursor = nextCursor;
    cursor = nextCursor;
    yield { events, ledger, endLedger, complete: false, truncated: false };
  }
}
