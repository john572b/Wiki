import type JSZip from 'jszip';
import type { Block, DocumentModel, ImageAsset, Inline, ListBlock, TableCell } from '../model/types';
import { emptyDocument } from '../model/types';
import { makeImageAsset } from '../util/image';
import { attr, isMonoFont, kids, openZip, readXml } from './ooxml';

interface TextStyle { parent?: string; bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; mono?: boolean; listStyle?: string; outline?: number }
interface RunStyle { bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; code?: boolean }

/** Document OpenDocument texte (LibreOffice, OnlyOffice…) → DocumentModel. */
export async function parseOdt(buffer: ArrayBuffer, opts: { sourceFilename: string }): Promise<DocumentModel> {
  const zip = await openZip(buffer);
  const mimetype = (await zip.file('mimetype')?.async('string'))?.trim();
  if (mimetype && mimetype !== 'application/vnd.oasis.opendocument.text') throw new Error('UNSUPPORTED_TYPE');
  const content = await readXml(zip, 'content.xml');
  if (!content) throw new Error('DOCX_NO_DOCUMENT');
  const doc = emptyDocument(opts.sourceFilename, 'odt');
  const p = new OdtParser(zip, doc);
  const stylesXml = await readXml(zip, 'styles.xml');
  if (stylesXml) p.loadStyles(stylesXml.documentElement);
  p.loadStyles(content.documentElement);
  const meta = await readXml(zip, 'meta.xml');
  const title = meta?.getElementsByTagNameNS('*', 'title')[0]?.textContent?.trim();
  if (title) doc.metadata.title = title;
  const body = content.getElementsByTagNameNS('*', 'text')[0];
  const officeText = Array.from(content.getElementsByTagNameNS('*', 'text')).find((e) => e.parentElement?.localName === 'body') ?? body;
  doc.blocks = await p.container(officeText);
  return doc;
}

class OdtParser {
  private styles = new Map<string, TextStyle>();
  private lists = new Map<string, Map<number, boolean>>(); // style de liste → niveau → numérotée ?
  private counter = 0;
  private cache = new Map<string, ImageAsset | null>();
  constructor(private zip: JSZip, private doc: DocumentModel) {}

  loadStyles(root: Element): void {
    for (const st of Array.from(root.getElementsByTagNameNS('*', 'style'))) {
      if (st.namespaceURI?.indexOf(':style:') === -1) continue;
      const name = attr(st, 'name');
      if (!name) continue;
      const tp = kids(st, 'text-properties')[0];
      const s: TextStyle = { parent: attr(st, 'parent-style-name') ?? undefined, listStyle: attr(st, 'list-style-name') ?? undefined };
      const ol = attr(st, 'default-outline-level');
      if (ol) s.outline = Number(ol);
      if (tp) {
        const w = attr(tp, 'font-weight');
        if (w) s.bold = w === 'bold' || Number(w) >= 600;
        const fs = attr(tp, 'font-style');
        if (fs) s.italic = fs === 'italic' || fs === 'oblique';
        const u = attr(tp, 'text-underline-style');
        if (u) s.underline = u !== 'none';
        const lt = attr(tp, 'text-line-through-style');
        if (lt) s.strike = lt !== 'none';
        const font = attr(tp, 'font-name') ?? attr(tp, 'font-family');
        if (font) s.mono = isMonoFont(font);
      }
      if (/preformatted|source|code/i.test(name)) s.mono = true;
      this.styles.set(name, s);
    }
    for (const ls of Array.from(root.getElementsByTagNameNS('*', 'list-style'))) {
      const name = attr(ls, 'name');
      if (!name) continue;
      const levels = new Map<number, boolean>();
      for (const lvl of kids(ls)) {
        const n = Number(attr(lvl, 'level') ?? '1');
        if (lvl.localName === 'list-level-style-number') levels.set(n, (attr(lvl, 'num-format') ?? '1') !== '');
        else if (lvl.localName === 'list-level-style-bullet' || lvl.localName === 'list-level-style-image') levels.set(n, false);
      }
      this.lists.set(name, levels);
    }
  }

  private resolve(name: string | null): TextStyle {
    const out: TextStyle = {};
    const seen = new Set<string>();
    let cur = name ? this.styles.get(name) : undefined;
    let curName = name ?? '';
    while (cur && !seen.has(curName)) {
      seen.add(curName);
      for (const k of ['bold', 'italic', 'underline', 'strike', 'mono', 'listStyle', 'outline'] as const) {
        if (out[k] === undefined && cur[k] !== undefined) (out as Record<string, unknown>)[k] = cur[k];
      }
      curName = cur.parent ?? '';
      cur = cur.parent ? this.styles.get(cur.parent) : undefined;
    }
    return out;
  }

  async container(el: Element): Promise<Block[]> {
    const out: Block[] = [];
    let code: string[] = [];
    const flushCode = () => {
      if (code.length) out.push({ type: 'code', text: code.join('\n') });
      code = [];
    };
    for (const e of kids(el)) {
      const n = e.localName;
      if (n === 'p' || n === 'h') {
        const st = this.resolve(attr(e, 'style-name'));
        const isHeading = n === 'h' || (st.outline !== undefined && st.outline > 0);
        if (!isHeading && st.mono && !e.getElementsByTagNameNS('*', 'frame').length) {
          code.push(textContent(e));
          continue;
        }
        flushCode();
        const inlines = await this.inlines(e, { bold: st.bold, italic: st.italic, underline: st.underline, strike: st.strike });
        if (isHeading) {
          const level = Number(attr(e, 'outline-level') ?? st.outline ?? '1') || 1;
          const textOnly = inlines.filter((i) => !(i.type === 'text' && i.text?.startsWith('\u0001img:')));
          if (textOnly.length) out.push({ type: 'heading', level, inlines: textOnly });
          continue;
        }
        out.push(...splitImages(inlines));
      } else if (n === 'list') {
        flushCode();
        out.push(await this.list(e, attr(e, 'style-name'), 1));
      } else if (n === 'table') {
        flushCode();
        out.push(await this.table(e));
      } else if (n === 'section' || n === 'deletion' || n === 'change-start') {
        if (n === 'section') { flushCode(); out.push(...(await this.container(e))); }
      }
      // table-of-content, sequence-decls, forms, soft-page-break… : ignorés.
    }
    flushCode();
    return out;
  }

  private async list(e: Element, inherited: string | null, level: number): Promise<ListBlock> {
    const styleName = attr(e, 'style-name') ?? inherited;
    const ordered = (styleName ? this.lists.get(styleName)?.get(level) : undefined) ?? false;
    const items: { blocks: Block[] }[] = [];
    for (const it of kids(e)) {
      if (it.localName !== 'list-item' && it.localName !== 'list-header') continue;
      const blocks: Block[] = [];
      for (const c of kids(it)) {
        if (c.localName === 'list') blocks.push(await this.list(c, styleName, level + 1));
        else blocks.push(...(await this.container(wrap(c))));
      }
      items.push({ blocks });
    }
    return { type: 'list', ordered, items };
  }

  private async table(e: Element): Promise<Block> {
    const rows: { cells: TableCell[] }[] = [];
    const visit = async (parent: Element, header: boolean) => {
      for (const c of kids(parent)) {
        if (c.localName === 'table-header-rows') await visit(c, true);
        else if (c.localName === 'table-rows' || c.localName === 'table-row-group') await visit(c, header);
        else if (c.localName === 'table-row') {
          const cells: TableCell[] = [];
          for (const td of kids(c)) {
            if (td.localName !== 'table-cell') continue;
            cells.push({
              blocks: await this.container(td),
              header,
              colspan: Number(attr(td, 'number-columns-spanned') ?? '1') || 1,
              rowspan: Number(attr(td, 'number-rows-spanned') ?? '1') || 1,
            });
          }
          rows.push({ cells });
        }
      }
    };
    await visit(e, false);
    return { type: 'table', rows };
  }

  private async inlines(e: Element, style: RunStyle): Promise<Inline[]> {
    const out: Inline[] = [];
    for (const node of Array.from(e.childNodes)) {
      if (node.nodeType === 3) {
        const t = (node.textContent ?? '').replace(/\s+/g, ' ');
        if (t) out.push(mk(t, style));
        continue;
      }
      if (node.nodeType !== 1) continue;
      const c = node as Element;
      switch (c.localName) {
        case 's': out.push(mk(' '.repeat(Number(attr(c, 'c') ?? '1') || 1), style)); break;
        case 'tab': out.push(mk('\t', style)); break;
        case 'line-break': out.push({ type: 'br' }); break;
        case 'span': {
          const st = this.resolve(attr(c, 'style-name'));
          out.push(...(await this.inlines(c, {
            bold: st.bold ?? style.bold, italic: st.italic ?? style.italic, underline: st.underline ?? style.underline,
            strike: st.strike ?? style.strike, code: st.mono ?? style.code,
          })));
          break;
        }
        case 'a': {
          const href = attr(c, 'href') ?? '';
          const children = await this.inlines(c, style);
          if (/^(https?:|mailto:|ftp:)/i.test(href)) out.push({ type: 'link', href, children });
          else out.push(...children);
          break;
        }
        case 'frame': {
          const img = await this.image(c);
          if (img) out.push(img);
          break;
        }
        case 'note': case 'bookmark': case 'bookmark-start': case 'bookmark-end': case 'soft-page-break': case 'annotation': case 'annotation-end':
          break;
        default:
          out.push(...(await this.inlines(c, style)));
      }
    }
    return out;
  }

  private async image(frame: Element): Promise<Inline | null> {
    const img = kids(frame, 'image')[0];
    if (!img) return null;
    const href = attr(img, 'href') ?? '';
    const alt = kids(frame, 'title')[0]?.textContent ?? kids(frame, 'desc')[0]?.textContent ?? '';
    if (/^[a-z]+:/i.test(href)) {
      this.doc.metadata.warnings.push({ code: 'IMAGE_EXTERNAL', message: 'Une image liée (externe au document) a été ignorée.' });
      return null;
    }
    const path = href.replace(/^\.\//, '');
    let asset = this.cache.get(path);
    if (asset === undefined) {
      asset = null;
      const f = this.zip.file(path);
      if (f) {
        this.counter++;
        try {
          asset = await makeImageAsset(`img-${this.counter}`, await f.async('uint8array'), undefined, { index: this.counter });
        } catch { asset = null; }
        if (asset) {
          const dup = this.doc.images.find((im) => im.sha256 === asset!.sha256);
          if (dup) asset = dup; else this.doc.images.push(asset);
        } else {
          this.doc.metadata.warnings.push({ code: 'IMAGE_UNREADABLE', message: `Image ${path.split('/').pop()} illisible ou dans un format non pris en charge.` });
        }
      }
      this.cache.set(path, asset);
    }
    return asset ? { type: 'text', text: `\u0001img:${asset.id}\u0002${alt}` } : null;
  }
}

/** Un élément isolé devient un conteneur à un seul enfant. */
function wrap(e: Element): Element {
  const w = e.ownerDocument.createElementNS(e.namespaceURI, 'wrap');
  w.appendChild(e.cloneNode(true));
  return w;
}

function splitImages(inlines: Inline[]): Block[] {
  const out: Block[] = [];
  let buf: Inline[] = [];
  const flush = () => {
    if (buf.some((i) => i.type === 'link' || (i.text ?? '').trim())) out.push({ type: 'paragraph', inlines: buf });
    buf = [];
  };
  for (const i of inlines) {
    if (i.type === 'text' && i.text?.startsWith('\u0001img:')) {
      flush();
      const [id, alt] = i.text.slice('\u0001img:'.length).split('\u0002');
      out.push({ type: 'image', imageId: id, alt: alt ?? '' });
    } else buf.push(i);
  }
  flush();
  return out;
}

function mk(t: string, s: RunStyle): Inline {
  const i: Inline = { type: 'text', text: t };
  if (s.bold) i.bold = true;
  if (s.italic) i.italic = true;
  if (s.underline) i.underline = true;
  if (s.strike) i.strike = true;
  if (s.code) i.code = true;
  return i;
}

function textContent(e: Element): string {
  let s = '';
  for (const n of Array.from(e.childNodes)) {
    if (n.nodeType === 3) s += n.textContent ?? '';
    else if (n.nodeType === 1) {
      const c = n as Element;
      if (c.localName === 's') s += ' '.repeat(Number(attr(c, 'c') ?? '1') || 1);
      else if (c.localName === 'tab') s += '\t';
      else if (c.localName === 'line-break') s += '\n';
      else s += textContent(c);
    }
  }
  return s;
}
