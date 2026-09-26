/**
 * Passphrase-encrypted persistent storage adapters implementing the SDK's
 * {@link NoteStore}/{@link VaultStore}/{@link ScanStore} interfaces (issue #833).
 *
 * Ports the frontend's PBKDF2 + AES-256-GCM scheme
 * (`frontend/src/lib/encryptedStorage.ts`) behind an injectable
 * {@link EncryptedStorageBackend} so the same encryption logic works against
 * `localStorage` in a browser or a file/in-memory backend in Node — the SDK
 * itself never touches `localStorage` or `fs` directly.
 *
 * Threat model: protects persisted data against read-only access to the
 * backend (localStorage exfiltration via XSS, a leaked backup file). It does
 * NOT protect against a passphrase captured at entry time, runtime memory
 * inspection while decrypted, or a fully compromised host.
 */
import { StorageError } from "../errors/index";
import type { PoolNote } from "../crypto/notes";
import type { GhostEntryLike } from "../crypto/backup";
import type { NoteStore, VaultStore, ScanStore } from "./index";

const PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const ENVELOPE_VERSION = 1;

interface EncryptedEnvelope {
  version: number;
  salt: string;
  iv: string;
  ciphertext: string;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i] ?? 0);
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(new TextEncoder().encode(password)),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: toArrayBuffer(salt), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    passwordKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptEnvelope(data: unknown, password: string): Promise<EncryptedEnvelope> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(password, salt);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: toArrayBuffer(iv) },
      key,
      new TextEncoder().encode(JSON.stringify(data)),
    ),
  );
  return {
    version: ENVELOPE_VERSION,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(ciphertext),
  };
}

async function decryptEnvelope<T>(raw: string, password: string): Promise<T> {
  let envelope: EncryptedEnvelope;
  try {
    envelope = JSON.parse(raw) as EncryptedEnvelope;
  } catch (cause) {
    throw new StorageError("Corrupt encrypted storage payload: not valid JSON.", "corrupt-payload", { cause });
  }
  if (
    envelope.version !== ENVELOPE_VERSION ||
    typeof envelope.salt !== "string" ||
    typeof envelope.iv !== "string" ||
    typeof envelope.ciphertext !== "string"
  ) {
    throw new StorageError("Corrupt encrypted storage payload: missing or unsupported envelope fields.", "corrupt-payload");
  }

  let salt: Uint8Array;
  let iv: Uint8Array;
  let ciphertext: Uint8Array;
  try {
    salt = base64ToBytes(envelope.salt);
    iv = base64ToBytes(envelope.iv);
    ciphertext = base64ToBytes(envelope.ciphertext);
  } catch (cause) {
    throw new StorageError("Corrupt encrypted storage payload: invalid base64.", "corrupt-payload", { cause });
  }

  const key = await deriveKey(password, salt);
  try {
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: toArrayBuffer(iv) }, key, toArrayBuffer(ciphertext));
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  } catch (cause) {
    // AES-GCM authentication failure (wrong key) and a truncated/tampered
    // ciphertext both surface as a generic DOMException from `decrypt` —
    // Web Crypto doesn't distinguish them, so neither can we.
    throw new StorageError("Failed to decrypt storage payload: wrong passphrase or corrupted data.", "wrong-passphrase", { cause });
  }
}

/** Low-level read/write of one opaque string blob. Implement this to target a new platform. */
export interface EncryptedStorageBackend {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
}

/** Browser backend: reads/writes `localStorage`. */
export function localStorageBackend(): EncryptedStorageBackend {
  return {
    async read(key) {
      if (typeof localStorage === "undefined") return null;
      return localStorage.getItem(key);
    },
    async write(key, value) {
      if (typeof localStorage === "undefined") {
        throw new StorageError("localStorage is not available in this environment.", "corrupt-payload");
      }
      localStorage.setItem(key, value);
    },
  };
}

/** In-memory backend: works anywhere (Node, tests), not persisted across process restarts. */
export function memoryBackend(): EncryptedStorageBackend {
  const map = new Map<string, string>();
  return {
    async read(key) {
      return map.get(key) ?? null;
    },
    async write(key, value) {
      map.set(key, value);
    },
  };
}

/** Node backend: reads/writes one JSON file per key under `dir`. */
export function fileBackend(dir: string): EncryptedStorageBackend {
  return {
    async read(key) {
      const { readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      try {
        return await readFile(join(dir, `${key}.json`), "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },
    async write(key, value) {
      const { mkdir, writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${key}.json`), value, "utf8");
    },
  };
}

/** Encrypted {@link NoteStore}: the full note list is stored as one encrypted blob per write. */
export class EncryptedNoteStore implements NoteStore {
  constructor(
    private readonly backend: EncryptedStorageBackend,
    private readonly password: string,
    private readonly key = "opaque:notes",
  ) {}

  private async load(): Promise<PoolNote[]> {
    const raw = await this.backend.read(this.key);
    if (!raw) return [];
    return decryptEnvelope<PoolNote[]>(raw, this.password);
  }

  private async save(notes: PoolNote[]): Promise<void> {
    await this.backend.write(this.key, JSON.stringify(await encryptEnvelope(notes, this.password)));
  }

  async list(): Promise<PoolNote[]> {
    return this.load();
  }

  async add(note: PoolNote): Promise<void> {
    const notes = await this.load();
    notes.push(note);
    await this.save(notes);
  }

  async markSpent(commitment: string): Promise<void> {
    const notes = await this.load();
    const updated = notes.map((n) => (n.commitment === commitment ? { ...n, spent: true } : n));
    await this.save(updated);
  }
}

/** Encrypted {@link VaultStore}: the full ghost-entry list is stored as one encrypted blob per write. */
export class EncryptedVaultStore implements VaultStore {
  constructor(
    private readonly backend: EncryptedStorageBackend,
    private readonly password: string,
    private readonly key = "opaque:vault",
  ) {}

  private async load(): Promise<GhostEntryLike[]> {
    const raw = await this.backend.read(this.key);
    if (!raw) return [];
    return decryptEnvelope<GhostEntryLike[]>(raw, this.password);
  }

  private async save(entries: GhostEntryLike[]): Promise<void> {
    await this.backend.write(this.key, JSON.stringify(await encryptEnvelope(entries, this.password)));
  }

  async listGhosts(): Promise<GhostEntryLike[]> {
    return this.load();
  }

  async saveGhost(entry: GhostEntryLike): Promise<void> {
    const entries = await this.load();
    const idx = entries.findIndex((e) => e.stealthAddress === entry.stealthAddress);
    if (idx >= 0) entries[idx] = entry;
    else entries.push(entry);
    await this.save(entries);
  }
}

/**
 * Encrypted {@link ScanStore}: the cursor map is stored as one encrypted blob
 * per write, keyed per identity so a client watching several stealth
 * identities keeps each one's position separately.
 */
export class EncryptedScanStore implements ScanStore {
  constructor(
    private readonly backend: EncryptedStorageBackend,
    private readonly password: string,
    private readonly key = "opaque:scan-cursor",
  ) {}

  private async load(): Promise<Record<string, number>> {
    const raw = await this.backend.read(this.key);
    if (!raw) return {};
    const stored = await decryptEnvelope<Record<string, number> | number | null>(
      raw,
      this.password,
    );
    // A pre-keying store persisted a bare number; keep it readable as the
    // unkeyed cursor rather than failing the scan that resumes from it.
    if (typeof stored === "number") return { "": stored };
    if (typeof stored === "object" && stored !== null) return stored;
    return {};
  }

  async getCursor(identity = ""): Promise<number | null> {
    const cursors = await this.load();
    return cursors[identity] ?? null;
  }

  async setCursor(ledger: number, identity = ""): Promise<void> {
    const cursors = await this.load();
    cursors[identity] = ledger;
    await this.backend.write(this.key, JSON.stringify(await encryptEnvelope(cursors, this.password)));
  }
}
