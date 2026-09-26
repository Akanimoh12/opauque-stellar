/**
 * Configurable RPC retry policy (#561).
 *
 * Transient Soroban/Horizon failures (429s, 5xx, socket timeouts) used to surface as
 * hard errors because the retry behaviour was hard-coded. This module makes the
 * behaviour a first-class, overridable option:
 *
 *   - attempts, backoff shape, and the retryable-code set are all configurable,
 *   - defaults retry idempotent reads only — transaction submission is NEVER retried,
 *   - a policy can be set process-wide or overridden per client instance,
 *   - exhausting the policy throws {@link RpcRetriesExhaustedError} whose `cause`
 *     is the last underlying error, so nothing is masked by the wrapper.
 *
 * @example
 * ```ts
 * // Per client instance
 * const server = getSorobanServer({
 *   retryPolicy: { attempts: 5, initialDelayMs: 200, retryableStatuses: [429, 503] },
 * });
 *
 * // Process-wide default
 * setDefaultRetryPolicy({ attempts: 2, jitter: false });
 * ```
 */

import { RpcRetriesExhaustedError, toOpaqueError } from "./errors";

/** Fully-resolved policy. Every field is required — see {@link RetryPolicyOptions}. */
export type RetryPolicy = {
  /** Total attempts per provider, including the first. `1` disables retrying. */
  attempts: number;
  /** Delay before the first retry. */
  initialDelayMs: number;
  /** Upper bound for any single backoff delay. */
  maxDelayMs: number;
  /** Exponential growth factor applied per retry. */
  backoffFactor: number;
  /** Spread delays over [50%, 100%] to avoid synchronised retry storms. */
  jitter: boolean;
  /** HTTP status codes considered transient. */
  retryableStatuses: readonly number[];
  /** Message pattern treated as transient when no status code is available. */
  retryableMessagePattern: RegExp;
  /** Per-attempt timeout. `0` disables the timeout race. */
  timeoutMs: number;
};

/** Partial override merged over {@link DEFAULT_RETRY_POLICY}. */
export type RetryPolicyOptions = Partial<RetryPolicy>;

/**
 * Defaults: three attempts with 350ms exponential backoff, capped at 4s, jittered.
 * Only the transient status codes below are retried; anything else (including a
 * 400 or a contract error) fails immediately.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({
  attempts: 3,
  initialDelayMs: 350,
  maxDelayMs: 4_000,
  backoffFactor: 2,
  jitter: true,
  retryableStatuses: Object.freeze([408, 425, 429, 500, 502, 503, 504]),
  retryableMessagePattern:
    /timeout|timed out|rate.?limit|too many requests|network|fetch failed|socket hang up|ECONNRESET|EAI_AGAIN/i,
  timeoutMs: 12_000,
});

/**
 * A policy that never retries. Used for anything that can move funds: a retried
 * submission risks a double-spend or a duplicate transaction, so it is off limits
 * regardless of what the caller configured.
 */
export const NO_RETRY_POLICY: RetryPolicy = Object.freeze({
  ...DEFAULT_RETRY_POLICY,
  attempts: 1,
  jitter: false,
});

/**
 * Methods that mutate ledger state. These are never retried and never subject to a
 * caller override — {@link policyForMethod} forces {@link NO_RETRY_POLICY} for them.
 */
export const NON_IDEMPOTENT_METHODS: ReadonlySet<string> = new Set([
  "sendTransaction",
  "_sendTransaction",
  "submitTransaction",
  "submitAsyncTransaction",
  "_submitTransaction",
]);

function positiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function nonNegative(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return value;
}

/** Merge a partial override over the defaults, clamping nonsense values. */
export function resolveRetryPolicy(
  options?: RetryPolicyOptions,
  base: RetryPolicy = DEFAULT_RETRY_POLICY,
): RetryPolicy {
  if (!options) return base;
  const maxDelayMs = nonNegative(options.maxDelayMs, base.maxDelayMs);
  return Object.freeze({
    attempts: positiveInt(options.attempts, base.attempts),
    initialDelayMs: Math.min(
      nonNegative(options.initialDelayMs, base.initialDelayMs),
      maxDelayMs,
    ),
    maxDelayMs,
    backoffFactor: Math.max(
      1,
      nonNegative(options.backoffFactor, base.backoffFactor),
    ),
    jitter: options.jitter ?? base.jitter,
    retryableStatuses: Object.freeze([
      ...(options.retryableStatuses ?? base.retryableStatuses),
    ]),
    retryableMessagePattern:
      options.retryableMessagePattern ?? base.retryableMessagePattern,
    timeoutMs: nonNegative(options.timeoutMs, base.timeoutMs),
  });
}

// ─── Process-wide default ───────────────────────────────────────────────────

let defaultPolicy: RetryPolicy = DEFAULT_RETRY_POLICY;

/** Override the policy every client uses unless it passes its own. */
export function setDefaultRetryPolicy(options?: RetryPolicyOptions): RetryPolicy {
  defaultPolicy = resolveRetryPolicy(options, DEFAULT_RETRY_POLICY);
  return defaultPolicy;
}

export function getDefaultRetryPolicy(): RetryPolicy {
  return defaultPolicy;
}

/** Restore the shipped defaults (used by tests and the settings UI). */
export function resetDefaultRetryPolicy(): void {
  defaultPolicy = DEFAULT_RETRY_POLICY;
}

/**
 * Resolve the policy for a specific RPC method. Submission methods are pinned to
 * {@link NO_RETRY_POLICY}; everything else gets the caller's policy.
 */
export function policyForMethod(
  method: string,
  policy: RetryPolicy = getDefaultRetryPolicy(),
): RetryPolicy {
  return NON_IDEMPOTENT_METHODS.has(method) ? NO_RETRY_POLICY : policy;
}

// ─── Classification ─────────────────────────────────────────────────────────

/** Pull an HTTP status off the many shapes stellar-sdk / fetch errors take. */
export function extractStatus(err: unknown): number | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
  };
  for (const candidate of [e.status, e.statusCode, e.response?.status]) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
  }
  return null;
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "";
}

/**
 * Whether `err` is a *definitive* "the resource does not exist" answer (HTTP 404).
 *
 * This is deliberately narrower than `!isRetryableRpcError(err)`: a 429, a 5xx, a
 * timeout, or a dropped socket is an **unknown**, not a negative. Callers use this
 * to choose between two mutually exclusive on-ledger branches, so mistaking a
 * transient failure for "absent" silently builds the wrong one.
 *
 * Retry envelopes are unwrapped first, because a provider-fallback layer reports
 * its verdict on the wrapper (which carries no HTTP status) rather than on the
 * transport error that actually decided the outcome.
 */
export function isNotFoundError(err: unknown): boolean {
  return extractStatus(underlyingError(err)) === 404;
}

/**
 * Decide whether `err` is transient under `policy`. A recognised status code wins
 * outright: a 400 is a real rejection even if its message happens to say "network".
 */
export function isRetryableRpcError(
  err: unknown,
  policy: RetryPolicy = getDefaultRetryPolicy(),
): boolean {
  const status = extractStatus(err);
  if (status !== null) return policy.retryableStatuses.includes(status);
  return policy.retryableMessagePattern.test(messageOf(err));
}

/**
 * Backoff for the retry that follows attempt `attempt` (0-based).
 * `random` is injectable so tests can assert exact delays.
 */
export function backoffDelayMs(
  attempt: number,
  policy: RetryPolicy = getDefaultRetryPolicy(),
  random: () => number = Math.random,
): number {
  const raw = policy.initialDelayMs * Math.pow(policy.backoffFactor, attempt);
  const capped = Math.min(raw, policy.maxDelayMs);
  if (!policy.jitter) return Math.round(capped);
  // Full-range-halved jitter: [50%, 100%] of the capped delay.
  return Math.round(capped * (0.5 + random() * 0.5));
}

// ─── Execution ──────────────────────────────────────────────────────────────

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  if (timeoutMs <= 0) return work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type RetryRunOptions = {
  /** Human-readable label used in timeout and exhaustion messages. */
  label: string;
  /** RPC method name; drives the non-idempotent guard. */
  method: string;
  policy?: RetryPolicy;
  /** Number of providers tried, for the exhaustion report. */
  providersTried?: number;
  /** Called before each sleep, for logging/metrics. */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

/**
 * Run `fn` under `policy`.
 *
 * Non-retryable errors propagate immediately and unwrapped. Only when a retryable
 * error consumes every attempt is it wrapped in {@link RpcRetriesExhaustedError} —
 * with the last underlying error on `cause`, per the issue's acceptance criteria.
 */
export async function runWithRetryPolicy<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryRunOptions,
): Promise<T> {
  const policy = policyForMethod(
    options.method,
    options.policy ?? getDefaultRetryPolicy(),
  );
  const sleep = options.sleep ?? defaultSleep;
  const startedAt = Date.now();
  let lastError: unknown;

  for (let attempt = 0; attempt < policy.attempts; attempt += 1) {
    try {
      return await withTimeout(
        Promise.resolve(fn(attempt)),
        policy.timeoutMs,
        options.label,
      );
    } catch (err) {
      lastError = err;
      if (!isRetryableRpcError(err, policy)) throw err;
      const isLast = attempt + 1 >= policy.attempts;
      if (isLast) break;
      const delayMs = backoffDelayMs(attempt, policy, options.random);
      options.onRetry?.({ attempt, delayMs, error: err });
      await sleep(delayMs);
    }
  }

  throw new RpcRetriesExhaustedError({
    message:
      `${options.label} failed after ${policy.attempts} attempt(s): ` +
      `${messageOf(lastError) || "unknown error"}`,
    cause: lastError,
    method: options.method,
    attempts: policy.attempts,
    providersTried: options.providersTried ?? 1,
    elapsedMs: Date.now() - startedAt,
  });
}

/**
 * Unwrap a retry wrapper down to the failure that actually happened. Callers that
 * want to inspect the transport error rather than the retry envelope use this.
 */
export function underlyingError(err: unknown): unknown {
  if (err instanceof RpcRetriesExhaustedError) {
    return err.lastError ?? err;
  }
  return err;
}

/** Normalise anything thrown by an RPC call into the typed hierarchy (#562). */
export function asRpcError(err: unknown, label: string): Error {
  return toOpaqueError(err, { message: `${label} failed`, stage: "rpc" });
}
