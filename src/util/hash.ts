export async function sha256Hex(data: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const buf = await subtle.digest('SHA-256', data as BufferSource);
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // Repli (environnements sans WebCrypto) : FNV-1a 64 bits, suffisant pour dédoublonner.
  let h1 = 0xcbf29ce4, h2 = 0x84222325;
  for (let i = 0; i < data.length; i++) {
    h1 ^= data[i]; h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= data[i]; h2 = Math.imul(h2, 0x0100019b) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}
