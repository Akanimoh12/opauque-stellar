/**
 * Browser wallet signer adapters for Freighter and Stellar Wallets Kit.
 *
 * These adapters wrap browser wallet APIs behind the {@link OpaqueSigner}
 * interface so the SDK can use them without knowing the underlying wallet.
 */
import {
  signTransaction as freighterSign,
  getAddress as freighterGetAddress,
  isAllowed as freighterIsAllowed,
  requestAccess as freighterRequestAccess,
} from "@stellar/freighter-api";
import type { OpaqueSigner, SignerContext } from "./index";

/**
 * Build an {@link OpaqueSigner} backed by the Freighter browser extension.
 *
 * If the user has not yet connected, `requestAccess()` is called on first
 * sign to prompt the connection dialog.
 */
export function freighterSigner(): OpaqueSigner {
  let cachedAddress: string | null = null;

  return {
    async publicKey() {
      if (cachedAddress) return cachedAddress;
      const allowed = await freighterIsAllowed();
      const isAllowed =
        typeof allowed === "boolean" ? allowed : allowed?.isAllowed;
      if (!isAllowed) {
        const result = await freighterRequestAccess();
        const addr =
          typeof result === "string"
            ? result
            : (result as { address?: string })?.address;
        if (!addr) throw new Error("Freighter: could not obtain address");
        cachedAddress = addr;
        return addr;
      }
      const addr = await freighterGetAddress();
      cachedAddress =
        typeof addr === "string" ? addr : (addr as { address: string }).address;
      return cachedAddress;
    },

    async signTransaction(xdr: string, ctx: SignerContext) {
      const signed = await freighterSign(xdr, {
        networkPassphrase: ctx.networkPassphrase,
      });
      return typeof signed === "string"
        ? signed
        : (signed as { signedTxXdr: string }).signedTxXdr;
    },
  };
}

/**
 * Build an {@link OpaqueSigner} from a Stellar Wallets Kit-compatible wallet.
 *
 * The `wallet` parameter must expose `requestAccess()`, `signTransaction()`,
 * and `getAddress()` methods matching the Stellar Wallets Kit interface.
 */
export function stellarWalletsKitSigner(wallet: {
  requestAccess: () => Promise<string | { address: string }>;
  signTransaction: (
    xdr: string,
    opts: { networkPassphrase: string },
  ) => Promise<string | { signedTxXdr: string }>;
  getAddress: () => Promise<string | { address: string }>;
}): OpaqueSigner {
  let cachedAddress: string | null = null;

  function extractAddress(res: string | { address: string }): string {
    return typeof res === "string" ? res : res.address;
  }

  return {
    async publicKey() {
      if (cachedAddress) return cachedAddress;
      const res = await wallet.requestAccess();
      cachedAddress = extractAddress(res);
      return cachedAddress;
    },

    async signTransaction(xdr: string, ctx: SignerContext) {
      const signed = await wallet.signTransaction(xdr, {
        networkPassphrase: ctx.networkPassphrase,
      });
      return typeof signed === "string"
        ? signed
        : (signed as { signedTxXdr: string }).signedTxXdr;
    },
  };
}
