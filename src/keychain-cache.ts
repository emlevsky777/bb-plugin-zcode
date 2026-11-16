import { createHash } from 'node:crypto';

export class KeychainAccessError extends Error {
  constructor() {
    super('Keychain access unavailable. Stop affected ZCode threads. Reload ZCode Provider to retry; automatic retries are disabled.');
  }
}

// A process-local key cache shared by every auth reader and plan. Login tokens
// still come from the credential file on every read. Nothing is persisted here.
export function createKeychainReader(load: (path: string) => Buffer) {
  type Entry = { attempted: Set<string>; blocked: boolean; fingerprint?: string; key?: Buffer };
  const entries = new Map<string, Entry>();
  return (path: string, fingerprint: string): Buffer => {
    let entry = entries.get(path);
    if (!entry) { entry = { attempted: new Set(), blocked: false }; entries.set(path, entry); }
    if (entry.blocked) throw new KeychainAccessError();
    if (entry.fingerprint === fingerprint && entry.key) return entry.key;
    // Mixed/stale ciphertext must not make a retired fingerprint prompt again.
    if (entry.attempted.has(fingerprint)) throw new KeychainAccessError();
    entry.attempted.add(fingerprint);
    entry.key?.fill(0);
    delete entry.key;
    delete entry.fingerprint;
    try {
      const key = load(path);
      if (key.length !== 32 || createHash('sha256').update(key).digest('hex').slice(0, 24) !== fingerprint) {
        key.fill(0);
        throw new Error();
      }
      entry.key = key;
      entry.fingerprint = fingerprint;
      return key;
    } catch {
      // Cancellation/failure blocks the whole store, including other reported
      // fingerprints, until an explicit worker restart. Never auto-reprompt.
      entry.blocked = true;
      throw new KeychainAccessError();
    }
  };
}
