// Adapted from zai-org/ZCode, commit 29628c9acdb81b703bbd4080c207a0e7ce5e276e,
// packages/shared/src/zcode-protocol-v4/wire-binary.ts, crc32WireBytes.
// Apache-2.0; see NOTICE and LICENSES/Apache-2.0.txt. Changes: exported name only.
export function crc32(bytes: Uint8Array): string {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}
