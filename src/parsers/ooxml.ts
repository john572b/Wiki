import JSZip from 'jszip';

/** Utilitaires communs aux formats bureautiques zippés (OOXML et OpenDocument). */
export const MAX_ZIP_UNCOMPRESSED = 500 * 1024 * 1024;

export async function openZip(buffer: ArrayBuffer): Promise<JSZip> {
  const zip = await JSZip.loadAsync(buffer);
  let total = 0;
  for (const [name, f] of Object.entries(zip.files)) {
    if (name.includes('..') || name.startsWith('/') || /^[a-z]:/i.test(name)) throw new Error('ZIP_PATH_TRAVERSAL');
    total += Math.max(0, (f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0);
  }
  if (total > MAX_ZIP_UNCOMPRESSED || (buffer.byteLength > 0 && total / buffer.byteLength > 200 && total > 50 * 1024 * 1024)) throw new Error('ZIP_BOMB');
  return zip;
}

export async function readXml(zip: JSZip, path: string): Promise<Document | null> {
  const f = zip.file(path);
  if (!f) return null;
  const d = new DOMParser().parseFromString(await f.async('string'), 'application/xml');
  if (d.getElementsByTagName('parsererror').length) throw new Error('DOCX_XML_INVALID');
  return d;
}

/** Relations OOXML d'une partie : Id → { cible résolue, externe ? }. */
export async function readRels(zip: JSZip, partPath: string): Promise<Map<string, { target: string; external: boolean; type: string }>> {
  const dir = partPath.replace(/[^/]+$/, '');
  const relsPath = `${dir}_rels/${partPath.split('/').pop()}.rels`;
  const map = new Map<string, { target: string; external: boolean; type: string }>();
  const d = await readXml(zip, relsPath);
  if (!d) return map;
  for (const r of Array.from(d.getElementsByTagName('Relationship'))) {
    const external = r.getAttribute('TargetMode') === 'External';
    const t = r.getAttribute('Target') ?? '';
    map.set(r.getAttribute('Id') ?? '', { target: external ? t : resolvePath(dir, t), external, type: r.getAttribute('Type') ?? '' });
  }
  return map;
}

export function resolvePath(dir: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = (dir + target).split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p !== '.' && p !== '') out.push(p);
  }
  return out.join('/');
}

/** Enfants directs d'un élément ayant ce nom local (indépendant du préfixe). */
export function kids(el: Element | null | undefined, localName?: string): Element[] {
  if (!el) return [];
  return Array.from(el.children).filter((c) => !localName || c.localName === localName);
}

export function kid(el: Element | null | undefined, localName: string): Element | null {
  return kids(el, localName)[0] ?? null;
}

/** Premier descendant ayant ce nom local. */
export function desc(el: Element | null | undefined, localName: string): Element | null {
  if (!el) return null;
  return (el.getElementsByTagNameNS('*', localName)[0] as Element | undefined) ?? null;
}

export function descAll(el: Element | null | undefined, localName: string): Element[] {
  if (!el) return [];
  return Array.from(el.getElementsByTagNameNS('*', localName));
}

/** Attribut par nom local, quel que soit l'espace de noms. */
export function attr(el: Element | null | undefined, localName: string): string | null {
  if (!el) return null;
  for (const a of Array.from(el.attributes)) if (a.localName === localName) return a.value;
  return null;
}

export function isMonoFont(font?: string | null): boolean {
  return !!font && /courier|consolas|mono|menlo|lucida console|monaco|source code|fira code|cascadia/i.test(font);
}

const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** Identifiant de relation (r:id, r:embed…) : attribut dans l'espace de noms des relations OOXML. */
export function relAttr(el: Element | null | undefined, localName = 'id'): string | null {
  if (!el) return null;
  return el.getAttributeNS(REL_NS, localName) || null;
}
