/** Décode un fichier texte : BOM UTF-8/UTF-16, sinon UTF-8 strict, sinon Windows-1252 (fichiers Windows anciens). */
export function decodeText(buffer: ArrayBuffer): string {
  const b = new Uint8Array(buffer);
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder('utf-8').decode(b.subarray(3));
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    return new TextDecoder('windows-1252').decode(b);
  }
}

/** Vrai si les premiers octets ressemblent à du texte (pas d'octet nul hors UTF-16 avec BOM). */
export function looksTextual(head: Uint8Array): boolean {
  if (head.length >= 2 && ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff))) return true;
  for (let i = 0; i < head.length; i++) if (head[i] === 0) return false;
  return true;
}
