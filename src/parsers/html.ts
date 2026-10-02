import type { AdmonitionKind, Block, DocumentModel, ImageAsset, Inline, ListBlock, TableCell } from '../model/types';
import { emptyDocument, type SourceKind } from '../model/types';
import { makeImageAsset } from '../util/image';

export interface HtmlParseOptions {
  sourceFilename: string;
  sourceKind?: SourceKind;
}

const SKIP = new Set(['script', 'style', 'template', 'noscript', 'iframe', 'object', 'embed', 'head', 'meta', 'link', 'button', 'input', 'select', 'textarea', 'form', 'svg', 'canvas', 'video', 'audio']);
const BLOCK = new Set(['p', 'div', 'section', 'article', 'main', 'header', 'footer', 'aside', 'nav', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'pre', 'blockquote', 'hr', 'figure', 'figcaption', 'dl', 'dt', 'dd', 'address', 'center', 'details', 'summary']);
const ADMONITION_CLASS: [RegExp, AdmonitionKind][] = [
  [/\b(warning|danger|caution|error|important|alert-danger|alert-warning)\b/i, 'warning'],
  [/\b(tip|success|hint|alert-success)\b/i, 'tip'],
  [/\b(info|information|alert-info)\b/i, 'info'],
  [/\b(note|notice|admonition|callout|alert)\b/i, 'note'],
];
const GH_ALERT_RE = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i;
const GH_ALERT_KIND: Record<string, AdmonitionKind> = { NOTE: 'note', TIP: 'tip', IMPORTANT: 'warning', WARNING: 'warning', CAUTION: 'warning' };

interface InlineStyle { bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; code?: boolean }

/**
 * Parseur HTML → DocumentModel. Le HTML est analysé par DOMParser (aucun script exécuté, aucune ressource chargée).
 * Les images ne sont reprises que si elles sont embarquées (data:) : aucune image distante n'est téléchargée.
 */
export async function parseHtml(html: string, opts: HtmlParseOptions): Promise<DocumentModel> {
  const dom = new DOMParser().parseFromString(html, 'text/html');
  const doc = emptyDocument(opts.sourceFilename, opts.sourceKind ?? 'html');
  const p = new HtmlParser(doc);
  doc.blocks = await p.container(dom.body);
  const title = dom.querySelector('title')?.textContent?.trim();
  if (title) doc.metadata.title = title;
  if (p.externalImages) doc.metadata.warnings.push({ code: 'IMAGE_EXTERNAL', message: `${p.externalImages} image(s) liée(s) à un fichier ou une adresse externe non incluse(s) : seules les images embarquées dans le document sont reprises.` });
  return doc;
}

class HtmlParser {
  externalImages = 0;
  private counter = 0;
  constructor(private doc: DocumentModel) {}

  /** Parcourt un conteneur : les inlines consécutifs forment des paragraphes, les éléments de bloc leurs propres blocs. */
  async container(el: Element): Promise<Block[]> {
    const out: Block[] = [];
    let buf: Inline[] = [];
    const flush = () => {
      if (buf.some((i) => i.type !== 'br' && (i.type === 'link' || (i.text ?? '').trim()))) out.push({ type: 'paragraph', inlines: trimBr(buf) });
      buf = [];
    };
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === 3) {
        buf.push({ type: 'text', text: collapse(node.textContent ?? '') });
        continue;
      }
      if (node.nodeType !== 1) continue;
      const e = node as Element;
      const tag = e.tagName.toLowerCase();
      if (SKIP.has(tag)) continue;
      if (tag === 'img') {
        flush();
        const b = await this.image(e);
        if (b) out.push(b);
        continue;
      }
      if (!BLOCK.has(tag)) {
        // Inline pouvant contenir des images : on les sort en blocs.
        if (e.querySelector('img') && !e.closest('a')) {
          flush();
          out.push(...(await this.container(e)));
          continue;
        }
        buf.push(...this.inlines(e, {}));
        continue;
      }
      flush();
      out.push(...(await this.block(e, tag)));
    }
    flush();
    return out;
  }

  async block(e: Element, tag: string): Promise<Block[]> {
    switch (tag) {
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
        const inlines = this.inlinesOf(e);
        return inlines.length ? [{ type: 'heading', level: Number(tag[1]), inlines }] : [];
      }
      case 'p': case 'address': case 'center': case 'summary': case 'dt': case 'figcaption': {
        if (e.querySelector('img')) return this.container(e);
        const inlines = this.inlinesOf(e, tag === 'dt' ? { bold: true } : {});
        return inlines.length ? [{ type: 'paragraph', inlines }] : [];
      }
      case 'ul': case 'ol': return [await this.list(e, tag === 'ol')];
      case 'li': return this.container(e);
      case 'table': return [await this.table(e)];
      case 'pre': {
        const code = e.querySelector('code');
        const lang = /(?:language|lang)-([\w+#-]+)/.exec((code ?? e).getAttribute('class') ?? '')?.[1];
        const text = (e.textContent ?? '').replace(/\n$/, '');
        return text.trim() ? [{ type: 'code', language: lang, text }] : [];
      }
      case 'blockquote': {
        const inner = await this.container(e);
        const first = inner[0];
        if (first && first.type === 'paragraph' && first.inlines[0]?.type === 'text') {
          const m = GH_ALERT_RE.exec(first.inlines[0].text ?? '');
          if (m) {
            first.inlines[0] = { ...first.inlines[0], text: (first.inlines[0].text ?? '').slice(m[0].length) };
            if (first.inlines[0].text === '') first.inlines.shift();
            while (first.inlines[0]?.type === 'br') first.inlines.shift();
            if (!first.inlines.length) inner.shift();
            return [{ type: 'admonition', kind: GH_ALERT_KIND[m[1].toUpperCase()], blocks: inner }];
          }
        }
        return inner.length ? [{ type: 'quote', blocks: inner }] : [];
      }
      case 'hr': return [{ type: 'hr' }];
      case 'figure': {
        const blocks = await this.container(e);
        const caption = e.querySelector('figcaption');
        const img = blocks.find((b) => b.type === 'image');
        if (img && img.type === 'image' && caption) {
          img.caption = this.inlinesOf(caption);
          return blocks.filter((b) => !(b.type === 'paragraph' && plain(b.inlines) === plain(img.caption ?? [])));
        }
        return blocks;
      }
      case 'dl': case 'dd': case 'details':
        return this.container(e);
      default: {
        // div, section… : encadré si la classe l'indique, sinon simple conteneur.
        const cls = `${e.getAttribute('class') ?? ''} ${e.getAttribute('role') ?? ''}`;
        const kind = ADMONITION_CLASS.find(([re]) => re.test(cls))?.[1];
        const inner = await this.container(e);
        if (kind && inner.length && !inner.some((b) => b.type === 'heading' || b.type === 'table')) return [{ type: 'admonition', kind, blocks: inner }];
        return inner;
      }
    }
  }

  async list(e: Element, ordered: boolean): Promise<ListBlock> {
    const start = ordered ? Number(e.getAttribute('start') ?? '1') || 1 : undefined;
    const items: { blocks: Block[] }[] = [];
    for (const li of Array.from(e.children)) {
      const tag = li.tagName.toLowerCase();
      if (tag === 'li') {
        // Case à cocher GFM : « [ ] » / « [x] ».
        const box = li.querySelector(':scope > input[type=checkbox], :scope > p > input[type=checkbox]');
        const blocks = await this.container(li);
        if (box && blocks[0]?.type === 'paragraph') blocks[0].inlines.unshift({ type: 'text', text: box.hasAttribute('checked') ? '☑ ' : '☐ ' });
        items.push({ blocks });
      } else if (tag === 'ul' || tag === 'ol') {
        // Liste imbriquée placée directement dans la liste (HTML invalide mais courant).
        const nested = await this.list(li, tag === 'ol');
        if (items.length) items[items.length - 1].blocks.push(nested);
        else items.push({ blocks: [nested] });
      }
    }
    return { type: 'list', ordered, start: start !== 1 ? start : undefined, items };
  }

  async table(e: Element): Promise<Block> {
    const rows: { cells: TableCell[] }[] = [];
    const trs = Array.from(e.querySelectorAll('tr')).filter((tr) => tr.closest('table') === e);
    for (const tr of trs) {
      const inHead = tr.parentElement?.tagName.toLowerCase() === 'thead';
      const cells: TableCell[] = [];
      for (const td of Array.from(tr.children)) {
        const t = td.tagName.toLowerCase();
        if (t !== 'td' && t !== 'th') continue;
        cells.push({
          blocks: await this.container(td),
          header: t === 'th' || inHead,
          colspan: Math.max(1, Number(td.getAttribute('colspan') ?? '1') || 1),
          rowspan: Math.max(1, Number(td.getAttribute('rowspan') ?? '1') || 1),
        });
      }
      if (cells.length) rows.push({ cells });
    }
    const cap = e.querySelector('caption');
    return { type: 'table', rows, caption: cap && cap.closest('table') === e ? this.inlinesOf(cap) : undefined };
  }

  async image(e: Element): Promise<Block | null> {
    const src = e.getAttribute('src') ?? '';
    const alt = e.getAttribute('alt') ?? e.getAttribute('title') ?? '';
    const m = /^data:(image\/[a-z+.-]+);base64,(.*)$/is.exec(src.trim());
    if (!m) {
      if (src) this.externalImages++;
      return null;
    }
    let bytes: Uint8Array;
    try {
      const bin = atob(m[2].replace(/\s+/g, ''));
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } catch {
      return null;
    }
    this.counter++;
    let asset: ImageAsset | null = null;
    try {
      asset = await makeImageAsset(`img-${this.counter}`, bytes, m[1], { index: this.counter });
    } catch {
      asset = null;
    }
    if (!asset) {
      this.doc.metadata.warnings.push({ code: 'IMAGE_UNREADABLE', message: 'Une image embarquée est illisible ou dans un format non pris en charge.' });
      return null;
    }
    const dup = this.doc.images.find((im) => im.sha256 === asset!.sha256);
    if (dup) asset = dup;
    else this.doc.images.push(asset);
    return { type: 'image', imageId: asset.id, alt };
  }

  inlinesOf(e: Element, style: InlineStyle = {}): Inline[] {
    return trimBr(this.inlines(e, style));
  }

  inlines(e: Element, style: InlineStyle): Inline[] {
    const out: Inline[] = [];
    for (const node of Array.from(e.childNodes)) {
      if (node.nodeType === 3) {
        const t = collapse(node.textContent ?? '');
        if (t) out.push(withStyle(t, style));
        continue;
      }
      if (node.nodeType !== 1) continue;
      const c = node as Element;
      const tag = c.tagName.toLowerCase();
      if (SKIP.has(tag) || tag === 'img') continue;
      const s: InlineStyle = { ...style };
      if (tag === 'b' || tag === 'strong') s.bold = true;
      if (tag === 'i' || tag === 'em' || tag === 'cite') s.italic = true;
      if (tag === 'u' || tag === 'ins') s.underline = true;
      if (tag === 's' || tag === 'strike' || tag === 'del') s.strike = true;
      if (tag === 'code' || tag === 'kbd' || tag === 'samp' || tag === 'tt') s.code = true;
      const css = (c.getAttribute('style') ?? '').toLowerCase();
      if (/font-weight\s*:\s*(bold|[6-9]00)/.test(css)) s.bold = true;
      if (/font-style\s*:\s*italic/.test(css)) s.italic = true;
      if (/font-family\s*:[^;]*(courier|mono|consolas)/.test(css)) s.code = true;
      if (tag === 'br') { out.push({ type: 'br' }); continue; }
      if (tag === 'a') {
        const href = (c.getAttribute('href') ?? '').trim();
        const children = this.inlines(c, s);
        if (/^(https?:|mailto:|ftp:)/i.test(href)) out.push({ type: 'link', href, children });
        else out.push(...children);
        continue;
      }
      if (tag === 'input' && c.getAttribute('type') === 'checkbox') continue;
      out.push(...this.inlines(c, s));
    }
    return out;
  }
}

function withStyle(text: string, s: InlineStyle): Inline {
  const i: Inline = { type: 'text', text };
  if (s.bold) i.bold = true;
  if (s.italic) i.italic = true;
  if (s.underline) i.underline = true;
  if (s.strike) i.strike = true;
  if (s.code) i.code = true;
  return i;
}

function collapse(s: string): string {
  return s.replace(/[\s ]+/g, ' ');
}

function trimBr(inlines: Inline[]): Inline[] {
  const out = [...inlines];
  while (out.length && out[0].type === 'br') out.shift();
  while (out.length && out[out.length - 1].type === 'br') out.pop();
  return out;
}

function plain(inlines: Inline[]): string {
  return inlines.map((i) => (i.type === 'link' ? plain(i.children ?? []) : i.text ?? '')).join('').trim();
}
