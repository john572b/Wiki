import { sniffImageMime } from '../detect/detect';
import { sha256Hex } from './hash';
import type { ImageAsset } from '../model/types';

export const MAX_IMAGE_PIXELS = 50_000_000;

export interface DecodedImage {
  bitmap: ImageBitmap;
  width: number;
  height: number;
}

/** Décode une image via le navigateur (échoue proprement hors navigateur). */
export async function decodeImage(data: Uint8Array, mime: string): Promise<DecodedImage | null> {
  if (typeof createImageBitmap !== 'function') return null;
  try {
    const bitmap = await createImageBitmap(new Blob([data as BlobPart], { type: mime }));
    if (bitmap.width * bitmap.height > MAX_IMAGE_PIXELS) {
      bitmap.close();
      throw new Error('IMAGE_TOO_LARGE');
    }
    return { bitmap, width: bitmap.width, height: bitmap.height };
  } catch (e) {
    if (e instanceof Error && e.message === 'IMAGE_TOO_LARGE') throw e;
    return null;
  }
}

export function makeCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

export async function canvasToPng(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<Uint8Array> {
  let blob: Blob;
  if ('convertToBlob' in canvas) blob = await canvas.convertToBlob({ type: 'image/png' });
  else blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('toBlob'))), 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

/** Ré-encode une image en PNG (supprime les métadonnées EXIF/GPS) ; conserve les JPEG tels quels sauf si demandé. */
export async function reencodeImage(data: Uint8Array, mime: string, forcePng = false): Promise<{ data: Uint8Array; mime: string; width: number; height: number } | null> {
  const dec = await decodeImage(data, mime);
  if (!dec) return null;
  try {
    if (mime === 'image/jpeg' && !forcePng) {
      // Ré-encodage JPEG pour retirer les métadonnées, qualité élevée.
      const c = makeCanvas(dec.width, dec.height);
      const ctx = c.getContext('2d') as CanvasRenderingContext2D;
      ctx.drawImage(dec.bitmap, 0, 0);
      let blob: Blob;
      if ('convertToBlob' in c) blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
      else blob = await new Promise<Blob>((res, rej) => (c as HTMLCanvasElement).toBlob((b) => (b ? res(b) : rej(new Error('toBlob'))), 'image/jpeg', 0.92));
      return { data: new Uint8Array(await blob.arrayBuffer()), mime: 'image/jpeg', width: dec.width, height: dec.height };
    }
    const c = makeCanvas(dec.width, dec.height);
    const ctx = c.getContext('2d') as CanvasRenderingContext2D;
    ctx.drawImage(dec.bitmap, 0, 0);
    return { data: await canvasToPng(c), mime: 'image/png', width: dec.width, height: dec.height };
  } finally {
    dec.bitmap.close();
  }
}

/** Construit un ImageAsset à partir d'octets bruts (mime détecté, dimensions lues si possible). */
export async function makeImageAsset(id: string, data: Uint8Array, mimeHint?: string, origin?: ImageAsset['origin']): Promise<ImageAsset | null> {
  const mime = sniffImageMime(data) ?? mimeHint ?? 'application/octet-stream';
  if (!['image/png', 'image/jpeg', 'image/gif', 'image/bmp', 'image/webp', 'image/tiff'].includes(mime)) return null;
  let width = 0, height = 0;
  let out = data;
  let outMime = mime;
  const re = await reencodeImage(data, mime, mime === 'image/bmp' || mime === 'image/tiff' || mime === 'image/webp');
  if (re) {
    out = re.data; outMime = re.mime; width = re.width; height = re.height;
  } else {
    const dims = readDimensions(data, mime);
    if (dims) ({ width, height } = dims);
  }
  return { id, filename: '', mime: outMime, width, height, sha256: await sha256Hex(out), data: out, origin };
}

/** Lecture des dimensions sans décodage (PNG, JPEG, GIF) pour les environnements sans canvas. */
export function readDimensions(b: Uint8Array, mime: string): { width: number; height: number } | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (mime === 'image/png' && b.length >= 24) return { width: dv.getUint32(16), height: dv.getUint32(20) };
  if (mime === 'image/gif' && b.length >= 10) return { width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
  if (mime === 'image/jpeg') {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: dv.getUint16(i + 5), width: dv.getUint16(i + 7) };
      }
      const len = dv.getUint16(i + 2);
      i += 2 + len;
    }
  }
  return null;
}
