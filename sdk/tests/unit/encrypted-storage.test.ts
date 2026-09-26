/**
 * Encrypted storage adapters (issue #833): round-trip through the
 * NoteStore/VaultStore/ScanStore interfaces, and typed wrong-passphrase /
 * corrupt-payload failure behavior. `memoryBackend` covers Node; a stubbed
 * `localStorage` covers the browser target without needing a DOM test env.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  EncryptedNoteStore,
  EncryptedVaultStore,
  EncryptedScanStore,
  memoryBackend,
  localStorageBackend,
  StorageError,
  type PoolNote,
  type GhostEntryLike,
} from "../../src/index";

const NOTE: PoolNote = {
  cluster: "testnet",
  poolId: "CPOOL",
  commitment: "0xnote1",
  nullifier: "0xnull1",
  secret: "0xsecret1",
  value: "1000000",
  scope: 1,
  leafIndex: 0,
  spent: false,
  createdAt: 1_700_000_000,
};

const GHOST: GhostEntryLike = {
  cluster: "testnet",
  stealthAddress: "0xghost1",
  ephemeralPrivKeyHex: "0x" + "aa".repeat(32),
  createdAt: 1_700_000_000,
};

describe("EncryptedNoteStore", () => {
  it("round-trips add/list/markSpent through an in-memory backend", async () => {
    const store = new EncryptedNoteStore(memoryBackend(), "correct horse battery");
    expect(await store.list()).toEqual([]);

    await store.add(NOTE);
    expect(await store.list()).toEqual([NOTE]);

    await store.markSpent(NOTE.commitment);
    const [spent] = await store.list();
    expect(spent.spent).toBe(true);
  });

  it("persisted data is not readable as plaintext on the backend", async () => {
    const backend = memoryBackend();
    const store = new EncryptedNoteStore(backend, "pw");
    await store.add(NOTE);
    const raw = await backend.read("opaque:notes");
    expect(raw).not.toContain("0xnote1");
  });

  it("throws a typed StorageError with the wrong passphrase", async () => {
    const backend = memoryBackend();
    const store = new EncryptedNoteStore(backend, "right-pw");
    await store.add(NOTE);

    const wrongStore = new EncryptedNoteStore(backend, "wrong-pw");
    await expect(wrongStore.list()).rejects.toThrow(StorageError);
    try {
      await wrongStore.list();
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(StorageError);
      expect((err as StorageError).reason).toBe("wrong-passphrase");
    }
  });

  it("throws a typed StorageError on a corrupt payload", async () => {
    const backend = memoryBackend();
    await backend.write("opaque:notes", "not json");
    const store = new EncryptedNoteStore(backend, "pw");
    try {
      await store.list();
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(StorageError);
      expect((err as StorageError).reason).toBe("corrupt-payload");
    }
  });
});

describe("EncryptedVaultStore", () => {
  it("round-trips saveGhost/listGhosts and upserts by stealth address", async () => {
    const store = new EncryptedVaultStore(memoryBackend(), "pw");
    await store.saveGhost(GHOST);
    expect(await store.listGhosts()).toEqual([GHOST]);

    const updated = { ...GHOST, createdAt: 1_700_000_999 };
    await store.saveGhost(updated);
    const entries = await store.listGhosts();
    expect(entries).toHaveLength(1);
    expect(entries[0].createdAt).toBe(1_700_000_999);
  });
});

describe("EncryptedScanStore", () => {
  it("round-trips getCursor/setCursor, defaulting to null", async () => {
    const store = new EncryptedScanStore(memoryBackend(), "pw");
    expect(await store.getCursor()).toBeNull();
    await store.setCursor(123_456);
    expect(await store.getCursor()).toBe(123_456);
  });

  it("keeps one cursor per identity, with the unkeyed slot separate", async () => {
    const store = new EncryptedScanStore(memoryBackend(), "pw");
    await store.setCursor(10, "vk:aa");
    await store.setCursor(20, "vk:bb");
    expect(await store.getCursor("vk:aa")).toBe(10);
    expect(await store.getCursor("vk:bb")).toBe(20);
    // Unkeyed callers keep their own slot rather than colliding with either.
    expect(await store.getCursor()).toBeNull();
    await store.setCursor(30);
    expect(await store.getCursor("vk:aa")).toBe(10);
    expect(await store.getCursor()).toBe(30);
  });
});

describe("localStorageBackend (browser target)", () => {
  const items = new Map<string, string>();
  beforeEach(() => {
    items.clear();
    (globalThis as { localStorage?: Storage }).localStorage = {
      getItem: (k: string) => items.get(k) ?? null,
      setItem: (k: string, v: string) => {
        items.set(k, v);
      },
      removeItem: (k: string) => {
        items.delete(k);
      },
      clear: () => items.clear(),
      key: () => null,
      get length() {
        return items.size;
      },
    } as Storage;
  });

  it("round-trips notes through a stubbed localStorage", async () => {
    const store = new EncryptedNoteStore(localStorageBackend(), "pw");
    await store.add(NOTE);
    expect(await store.list()).toEqual([NOTE]);
    expect(items.get("opaque:notes")).toBeDefined();
  });
});
