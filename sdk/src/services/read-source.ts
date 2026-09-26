/**
 * The account a read-only call is simulated from. A Soroban read still needs
 * *some* funded account to build the simulation transaction, but it does not
 * need the user's key: a read-only client with no signer at all can pass an
 * explicit `source` and query the chain.
 */
import { SignerError } from "../errors/index";
import type { OpaqueClientContext } from "./context";

/**
 * Resolve the account to simulate a read from: the caller's explicit `source`,
 * else the connected signer, else a typed error explaining what to pass.
 * Never throws for the (common) read-only case where a `source` is supplied.
 */
export async function resolveReadSource(
  ctx: OpaqueClientContext,
  explicit?: string,
): Promise<string> {
  if (explicit) return explicit;
  if (ctx.signer) return ctx.signer.publicKey();
  throw new SignerError(
    "This read needs an account to simulate from. Construct OpaqueClient with { signer } " +
      "or pass an explicit `source` account.",
  );
}
