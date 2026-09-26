/**
 * Node-only entry point for test fixtures and recording/replay utilities.
 *
 * These utilities import `node:fs` and are not safe for browser bundles.
 * Import via `@opaquecash/stellar/node` instead of the main entry.
 */
export * from "./rpc/fixture";
