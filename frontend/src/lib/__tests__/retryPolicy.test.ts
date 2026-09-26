/**
 * Configurable RPC retry policy tests (#561).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { RpcRetriesExhaustedError } from "../errors";
import {
  DEFAULT_RETRY_POLICY,
  NON_IDEMPOTENT_METHODS,
  NO_RETRY_POLICY,
  backoffDelayMs,
  extractStatus,
  getDefaultRetryPolicy,
  isNotFoundError,
  isRetryableRpcError,
  policyForMethod,
  resetDefaultRetryPolicy,
  resolveRetryPolicy,
  runWithRetryPolicy,
  setDefaultRetryPolicy,
  underlyingError,
} from "../retryPolicy";

/** Deterministic no-op sleep so tests never actually wait. */
const noSleep = () => Promise.resolve();

function httpError(status: number, message = `HTTP ${status}`): Error {
  return Object.assign(new Error(message), { response: { status } });
}

beforeEach(() => {
  resetDefaultRetryPolicy();
});

describe("resolveRetryPolicy (#561)", () => {
  it("returns the base policy untouched when nothing is overridden", () => {
    expect(resolveRetryPolicy()).toBe(DEFAULT_RETRY_POLICY);
  });

  it("merges a partial override over the defaults", () => {
    const policy = resolveRetryPolicy({ attempts: 7, jitter: false });
    expect(policy.attempts).toBe(7);
    expect(policy.jitter).toBe(false);
    expect(policy.initialDelayMs).toBe(DEFAULT_RETRY_POLICY.initialDelayMs);
    expect(policy.retryableStatuses).toEqual(DEFAULT_RETRY_POLICY.retryableStatuses);
  });

  it("clamps nonsense values instead of trusting them", () => {
    const policy = resolveRetryPolicy({
      attempts: 0,
      backoffFactor: -3,
      initialDelayMs: -100,
      timeoutMs: Number.NaN,
    });
    expect(policy.attempts).toBe(1);
    expect(policy.backoffFactor).toBeGreaterThanOrEqual(1);
    expect(policy.initialDelayMs).toBe(DEFAULT_RETRY_POLICY.initialDelayMs);
    expect(policy.timeoutMs).toBe(DEFAULT_RETRY_POLICY.timeoutMs);
  });

  it("never lets the first delay exceed the cap", () => {
    const policy = resolveRetryPolicy({ initialDelayMs: 90_000, maxDelayMs: 1_000 });
    expect(policy.initialDelayMs).toBe(1_000);
  });
});

describe("per-instance vs process-wide policy (#561)", () => {
  it("overrides the default for every client once set", () => {
    setDefaultRetryPolicy({ attempts: 5 });
    expect(getDefaultRetryPolicy().attempts).toBe(5);
    resetDefaultRetryPolicy();
    expect(getDefaultRetryPolicy()).toBe(DEFAULT_RETRY_POLICY);
  });

  it("lets one instance's policy differ from the process default", () => {
    setDefaultRetryPolicy({ attempts: 2 });
    const instance = resolveRetryPolicy({ attempts: 9 }, getDefaultRetryPolicy());
    expect(instance.attempts).toBe(9);
    expect(getDefaultRetryPolicy().attempts).toBe(2);
  });
});

describe("submission is never retried (#561)", () => {
  it("pins every non-idempotent method to the no-retry policy", () => {
    for (const method of NON_IDEMPOTENT_METHODS) {
      expect(policyForMethod(method, resolveRetryPolicy({ attempts: 10 }))).toBe(
        NO_RETRY_POLICY,
      );
    }
  });

  it("still retries idempotent reads", () => {
    const policy = resolveRetryPolicy({ attempts: 4 });
    expect(policyForMethod("getEvents", policy)).toBe(policy);
    expect(policyForMethod("getLatestLedger", policy)).toBe(policy);
    expect(policyForMethod("simulateTransaction", policy)).toBe(policy);
  });

  it("calls sendTransaction exactly once even under a generous policy", async () => {
    const fn = vi.fn().mockRejectedValue(httpError(503));
    await expect(
      runWithRetryPolicy(fn, {
        label: "rpc.sendTransaction",
        method: "sendTransaction",
        policy: resolveRetryPolicy({ attempts: 8 }),
        sleep: noSleep,
      }),
    ).rejects.toBeInstanceOf(RpcRetriesExhaustedError);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("error classification (#561)", () => {
  it("reads a status off every shape stellar-sdk throws", () => {
    expect(extractStatus(httpError(429))).toBe(429);
    expect(extractStatus(Object.assign(new Error("x"), { status: 500 }))).toBe(500);
    expect(extractStatus(Object.assign(new Error("x"), { statusCode: 502 }))).toBe(502);
    expect(extractStatus(new Error("no status"))).toBeNull();
    expect(extractStatus(null)).toBeNull();
  });

  it("retries the configured transient statuses only", () => {
    expect(isRetryableRpcError(httpError(429))).toBe(true);
    expect(isRetryableRpcError(httpError(503))).toBe(true);
    expect(isRetryableRpcError(httpError(400))).toBe(false);
    expect(isRetryableRpcError(httpError(404))).toBe(false);
  });

  it("lets a status code override a misleading message", () => {
    // Reads "network" but is a hard 400: a retry would fail identically.
    expect(isRetryableRpcError(httpError(400, "network rejected the request"))).toBe(false);
  });

  it("falls back to the message pattern when there is no status", () => {
    expect(isRetryableRpcError(new Error("request timed out"))).toBe(true);
    expect(isRetryableRpcError(new Error("socket hang up"))).toBe(true);
    expect(isRetryableRpcError(new Error("invalid nullifier"))).toBe(false);
  });

  it("honours a caller-supplied retryable set", () => {
    const policy = resolveRetryPolicy({ retryableStatuses: [418] });
    expect(isRetryableRpcError(httpError(418), policy)).toBe(true);
    expect(isRetryableRpcError(httpError(503), policy)).toBe(false);
  });
});

describe("backoff (#561)", () => {
  it("grows exponentially and respects the cap", () => {
    const policy = resolveRetryPolicy({
      initialDelayMs: 100,
      backoffFactor: 3,
      maxDelayMs: 1_000,
      jitter: false,
    });
    expect(backoffDelayMs(0, policy)).toBe(100);
    expect(backoffDelayMs(1, policy)).toBe(300);
    expect(backoffDelayMs(2, policy)).toBe(900);
    expect(backoffDelayMs(3, policy)).toBe(1_000);
  });

  it("jitters into the [50%, 100%] band", () => {
    const policy = resolveRetryPolicy({ initialDelayMs: 1_000, jitter: true });
    expect(backoffDelayMs(0, policy, () => 0)).toBe(500);
    expect(backoffDelayMs(0, policy, () => 1)).toBe(1_000);
  });
});

describe("runWithRetryPolicy (#561)", () => {
  it("returns the first success without sleeping", async () => {
    const sleep = vi.fn(noSleep);
    const result = await runWithRetryPolicy(async () => "ok", {
      label: "rpc.getEvents",
      method: "getEvents",
      sleep,
    });
    expect(result).toBe("ok");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries a transient failure and then succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(httpError(503))
      .mockResolvedValueOnce("recovered");
    const result = await runWithRetryPolicy(fn, {
      label: "rpc.getEvents",
      method: "getEvents",
      policy: resolveRetryPolicy({ attempts: 3 }),
      sleep: noSleep,
    });
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("propagates a non-retryable error immediately and unwrapped", async () => {
    const hard = httpError(400, "bad request");
    const fn = vi.fn().mockRejectedValue(hard);
    await expect(
      runWithRetryPolicy(fn, {
        label: "rpc.getEvents",
        method: "getEvents",
        policy: resolveRetryPolicy({ attempts: 5 }),
        sleep: noSleep,
      }),
    ).rejects.toBe(hard);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("stops after exactly `attempts` tries", async () => {
    const fn = vi.fn().mockRejectedValue(httpError(503));
    await expect(
      runWithRetryPolicy(fn, {
        label: "rpc.getEvents",
        method: "getEvents",
        policy: resolveRetryPolicy({ attempts: 4 }),
        sleep: noSleep,
      }),
    ).rejects.toBeInstanceOf(RpcRetriesExhaustedError);
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("surfaces the LAST underlying error on exhaustion", async () => {
    const first = httpError(503, "first failure");
    const last = httpError(429, "final failure");
    const fn = vi.fn().mockRejectedValueOnce(first).mockRejectedValue(last);

    const err = await runWithRetryPolicy(fn, {
      label: "rpc.getEvents",
      method: "getEvents",
      policy: resolveRetryPolicy({ attempts: 3 }),
      sleep: noSleep,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RpcRetriesExhaustedError);
    const exhausted = err as RpcRetriesExhaustedError;
    expect(exhausted.cause).toBe(last);
    expect(exhausted.lastError).toBe(last);
    expect(exhausted.cause).not.toBe(first);
    expect(underlyingError(exhausted)).toBe(last);
    expect(exhausted.message).toContain("final failure");
    expect(exhausted.context.attempts).toBe(3);
  });

  it("reports retry attempts through onRetry", async () => {
    const onRetry = vi.fn();
    const fn = vi.fn().mockRejectedValue(httpError(503));
    await runWithRetryPolicy(fn, {
      label: "rpc.getEvents",
      method: "getEvents",
      policy: resolveRetryPolicy({ attempts: 3, jitter: false }),
      sleep: noSleep,
      onRetry,
    }).catch(() => undefined);
    // Two sleeps for three attempts: no delay follows the final failure.
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0][0].attempt).toBe(0);
  });

  it("treats a per-attempt timeout as a retryable failure", async () => {
    const fn = vi
      .fn()
      .mockImplementationOnce(() => new Promise(() => {})) // never settles
      .mockResolvedValueOnce("second try");
    const result = await runWithRetryPolicy(fn, {
      label: "rpc.getEvents",
      method: "getEvents",
      policy: resolveRetryPolicy({ attempts: 2, timeoutMs: 5 }),
      sleep: noSleep,
    });
    expect(result).toBe("second try");
  });

  it("leaves a non-retry error untouched when passed through underlyingError", () => {
    const plain = new Error("plain");
    expect(underlyingError(plain)).toBe(plain);
  });
});

describe("isNotFoundError (#999)", () => {
  it("reports a 404 as a definitive not-found", () => {
    expect(isNotFoundError(httpError(404))).toBe(true);
    expect(isNotFoundError(Object.assign(new Error("404"), { status: 404 }))).toBe(true);
  });

  it("unwraps a retry envelope, whose own status is absent", () => {
    const exhausted = new RpcRetriesExhaustedError({
      message: "Horizon.loadAccount failed across 1 provider(s): HTTP 404",
      method: "loadAccount",
      attempts: 3,
      providersTried: 1,
      elapsedMs: 12,
      cause: httpError(404, "Account not found"),
    });
    expect(extractStatus(exhausted)).toBeNull();
    expect(isNotFoundError(exhausted)).toBe(true);
  });

  // The regression that motivated #999: these are *unknowns*, not negatives.
  it.each([429, 500, 502, 503, 504, 408, 400])(
    "does not treat HTTP %i as a not-found",
    (status) => {
      expect(isNotFoundError(httpError(status))).toBe(false);
    },
  );

  it("does not treat a transport failure as a not-found", () => {
    expect(isNotFoundError(new Error("network request failed"))).toBe(false);
    expect(isNotFoundError(new Error("request timed out"))).toBe(false);
    expect(isNotFoundError("nope")).toBe(false);
    expect(isNotFoundError(undefined)).toBe(false);
    expect(isNotFoundError(null)).toBe(false);
  });
});
