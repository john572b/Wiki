export type FileKind = 'pdf' | 'docx' | 'image' | 'doc' | 'zip' | 'unknown';

export interface Detection {
  kind: FileKind;
  mime: string;
  /** Vrai si l'extension et les octets magiques sont cohérents. */
  consistent: boolean;
}

export const ACCEPTED_EXTENSIONS = ['pdf', 'docx', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff'];

export function extensionOf(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? m[1].toLowerCase() : '';
}

export function sniffImageMime(b: Uint8Array): string | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (b.length >= 4 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a))) return 'image/tiff';
  if (b.length >= 4 && b[0] === 0x01 && b[1] === 0x00 && b[2] === 0x00 && b[3] === 0x00) return 'image/emf';
  if (b.length >= 4 && b[0] === 0xd7 && b[1] === 0xcd && b[2] === 0xc6 && b[3] === 0x9a) return 'image/wmf';
  if (b.length >= 5) {
    const head = new TextDecoder('latin1').decode(b.subarray(0, Math.min(b.length, 256))).trimStart();
    if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
  }
  return null;
}

/** Détermine le type d'un fichier à partir de ses premiers octets et de son extension. */
export function detect(name: string, head: Uint8Array): Detection {
  const ext = extensionOf(name);
  let kind: FileKind = 'unknown';
  let mime = 'application/octet-stream';
  if (head.length >= 5 && head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46 && head[4] === 0x2d) {
    kind = 'pdf';
    mime = 'application/pdf';
  } else if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05 || head[2] === 0x07)) {
    kind = ext === 'docx' ? 'docx' : 'zip';
    mime = ext === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/zip';
  } else if (head.length >= 8 && head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) {
    kind = 'doc';
    mime = 'application/msword';
  } else {
    const im = sniffImageMime(head);
    if (im && !['image/emf', 'image/wmf', 'image/svg+xml'].includes(im)) {
      kind = 'image';
      mime = im;
    }
  }
  const expected: Record<string, FileKind> = {
    pdf: 'pdf', docx: 'docx', doc: 'doc', png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image', bmp: 'image', tif: 'image', tiff: 'image',
  };
  const consistent = expected[ext] === kind;
  return { kind, mime, consistent };
}
