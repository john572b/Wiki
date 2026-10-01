import type { DocumentModel } from '../model/types';

/**
 * Remplace les références `images/<nom>` de l'aperçu par des URL `data:` (base64).
 * Les URL `blob:` ne sont pas accessibles depuis une iframe sandbox (origine opaque) ; les URL `data:` le sont.
 */
export function inlinePreviewImages(previewHtml: string, doc: DocumentModel, imagePrefix: string): { html: string; urls: string[] } {
  let html = previewHtml;
  for (const im of doc.images) {
    const name = imagePrefix + im.filename;
    const url = `data:${im.mime};base64,${toBase64(im.data)}`;
    const enc = encodeURIComponent(name);
    html = html.split(`images/${enc}`).join(url).split(`images/${name}`).join(url);
  }
  return { html, urls: [] };
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  return btoa(s);
}
