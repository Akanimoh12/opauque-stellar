/**
 * Typed error hierarchy for the SDK. Every thrown error carries a stable,
 * machine-readable `code` so callers can branch without string-matching
 * messages. Soroban contract failures map to {@link ContractError} with the
 * decoded contract error code (and a name when the contract's error enum is
 * known to the SDK).
 */

export class OpaqueError extends Error {
  /** Stable, machine-readable error code (e.g. "CONFIG", "CONTRACT"). */
  readonly code: string;

  constructor(message: string, code: string, options?: { cause?: unknown }) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/** Configuration is missing or invalid (e.g. mainnet without RPC URLs). */
export class ConfigError extends OpaqueError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "CONFIG", options);
  }
}

/** A signer adapter failed to produce a signature. */
export class SignerError extends OpaqueError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "SIGNER", options);
  }
}

/** An RPC or Horizon request failed (network, timeout, or HTTP status). */
export class RpcError extends OpaqueError {
  readonly httpStatus?: number;
  constructor(
    message: string,
    options?: { httpStatus?: number; cause?: unknown },
  ) {
    super(message, "RPC", options);
    this.httpStatus = options?.httpStatus;
  }
}

/** A relayer gateway HTTP request failed (network, timeout, HTTP status, or abort). */
export class GatewayError extends OpaqueError {
  readonly httpStatus?: number;
  readonly gatewayUrl?: string;
  constructor(
    message: string,
    options?: { httpStatus?: number; gatewayUrl?: string; cause?: unknown },
  ) {
    super(message, "GATEWAY", options);
    this.httpStatus = options?.httpStatus;
    this.gatewayUrl = options?.gatewayUrl;
  }
}

/** A transaction failed during pre-flight simulation. */
export class SimulationError extends OpaqueError {
  readonly diagnostics?: string;
  constructor(
    message: string,
    options?: { diagnostics?: string; cause?: unknown },
  ) {
    super(message, "SIMULATION", options);
    this.diagnostics = options?.diagnostics;
  }
}

/** A Soroban contract invocation reverted with a contract error code. */
export class ContractError extends OpaqueError {
  readonly contract: string;
  readonly contractCode: number;
  /** Human-readable name when the contract's error enum is known. */
  readonly errorName?: string;
  constructor(opts: {
    contract: string;
    contractCode: number;
    errorName?: string;
    message?: string;
    cause?: unknown;
  }) {
    const label = opts.errorName
      ? `${opts.errorName} (#${opts.contractCode})`
      : `#${opts.contractCode}`;
    super(
      opts.message ?? `${opts.contract} reverted: ${label}`,
      "CONTRACT",
      { cause: opts.cause },
    );
    this.contract = opts.contract;
    this.contractCode = opts.contractCode;
    this.errorName = opts.errorName;
  }
}

/** The published reputation/pool root is unavailable or not yet indexed. */
export class RootUnavailableError extends OpaqueError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "ROOT_UNAVAILABLE", options);
  }
}

/** A circuit artifact failed to resolve or failed its integrity check. */
export class ArtifactError extends OpaqueError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "ARTIFACT", options);
  }
}

/** An encrypted storage adapter failed to read or decrypt its persisted data. */
export class StorageError extends OpaqueError {
  /** "wrong-passphrase": AES-GCM auth tag rejected the derived key. "corrupt-payload": the stored envelope is malformed or has an unsupported version. */
  readonly reason: "wrong-passphrase" | "corrupt-payload";
  constructor(
    message: string,
    reason: "wrong-passphrase" | "corrupt-payload",
    options?: { cause?: unknown },
  ) {
    super(message, "STORAGE", options);
    this.reason = reason;
  }
}

/** A serialized note failed to decode: unknown schema version or a missing/malformed field. */
export class NoteSchemaError extends OpaqueError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "NOTE_SCHEMA", options);
  }
}

/** A deposit amount violates a pool constraint (bounds or precision). */
export class PoolValidationError extends OpaqueError {
  /** Name of the violated constraint, e.g. "non-positive" or "precision". */
  readonly constraint: string;
  constructor(
    message: string,
    constraint: string,
    options?: { cause?: unknown },
  ) {
    super(message, "POOL_VALIDATION", options);
    this.constraint = constraint;
  }
}

/**
 * A contract-event scan stopped at its page cap with events left unread. The
 * results are **incomplete** — a truncated announcement scan can miss payments
 * and a truncated state reconstruction can produce a wrong Merkle root — so
 * the SDK raises this instead of handing back partial data as if it were whole.
 *
 * Nothing at or below {@link lastScannedLedger} was skipped: resume there
 * (`lastScannedLedger + 1`) or continue raw cursor paging from
 * {@link continuationCursor}.
 */
export class EventTruncationError extends OpaqueError {
  /** What was being scanned, e.g. `"privacy-pool:Deposit"`. */
  readonly scope: string;
  /** `getEvents` pages actually read before the cap stopped the scan. */
  readonly pagesRead: number;
  /** The cap that was hit. */
  readonly pageCap: number;
  /** Highest ledger read in full. */
  readonly lastScannedLedger: number;
  /** Opaque `getEvents` cursor to continue from, when the scan was cursor-paged. */
  readonly continuationCursor?: string;

  constructor(opts: {
    scope: string;
    pagesRead: number;
    pageCap: number;
    lastScannedLedger: number;
    continuationCursor?: string;
    cause?: unknown;
  }) {
    super(
      `${opts.scope}: event scan stopped at the ${opts.pageCap}-page cap with events left ` +
        `unread (${opts.pagesRead} pages read); results are incomplete — resume from ledger ` +
        `${opts.lastScannedLedger + 1}.`,
      "EVENT_TRUNCATION",
      { cause: opts.cause },
    );
    this.scope = opts.scope;
    this.pagesRead = opts.pagesRead;
    this.pageCap = opts.pageCap;
    this.lastScannedLedger = opts.lastScannedLedger;
    this.continuationCursor = opts.continuationCursor;
  }
}

/**
 * A capability that depends on a layer not yet wired in this build (e.g. the
 * proving layer, the WASM scanner, or the relayer gateway client). Thrown so
 * the surface is discoverable and the failure is explicit rather than silent.
 */
export class NotWiredError extends OpaqueError {
  constructor(capability: string, hint?: string) {
    super(
      `${capability} is not wired in this build.` + (hint ? ` ${hint}` : ""),
      "NOT_WIRED",
    );
  }
}

/**
 * A Soroban contract interface version does not match the SDK's expected
 * version. Thrown at initialization so the caller can surface actionable
 * guidance before any transaction is built.
 */
export class CompatibilityError extends OpaqueError {
  readonly mismatches: Array<{ contract: string; contractId: string; expected: number; deployed: number }>;

  constructor(
    mismatches: Array<{ contract: string; contractId: string; expected: number; deployed: number }>,
  ) {
    const detail = mismatches
      .map(
        (m) =>
          `${m.contract} (${m.contractId}): expected v${m.expected}, deployed v${m.deployed}`,
      )
      .join("; ");
    super(`Contract version mismatch: ${detail}`, "COMPATIBILITY");
    this.mismatches = mismatches;
  }
}

/**
 * Known contract error enums, keyed by contract package name. Populated as the
 * SDK binds each contract; an unknown code still surfaces as a numeric
 * {@link ContractError}. Source of truth is each contract's `#[contracterror]`.
 *
 * Regenerate after contract error changes:
 *   npx tsx scripts/generate-error-mapping.ts
 */
import { CONTRACT_ERROR_NAMES as _CONTRACT_ERROR_NAMES } from "./contract-errors.generated";
export { _CONTRACT_ERROR_NAMES as CONTRACT_ERROR_NAMES };

/** Look up a contract error name for a code, if the SDK knows the enum. */
export function contractErrorName(
  contractPackage: string,
  code: number,
): string | undefined {
  return _CONTRACT_ERROR_NAMES[contractPackage]?.[code];
}
