import type JSZip from 'jszip';
import type { Block, DocumentModel, ImageAsset, Inline, ListBlock, TableCell } from '../model/types';
import { emptyDocument } from '../model/types';
import { makeImageAsset } from '../util/image';
import { attr, desc, descAll, isMonoFont, kid, kids, openZip, readRels, readXml, relAttr } from './ooxml';

interface Shape { y: number; x: number; el: Element }
interface Para { lvl: number; bullet: null | 'bullet' | 'number'; noBullet: boolean; inlines: Inline[]; size: number; mono: boolean }

/** Présentation PowerPoint → titre par diapositive, puces imbriquées, tableaux, images, liens. Les notes sont ignorées. */
export async function parsePptx(buffer: ArrayBuffer, opts: { sourceFilename: string }): Promise<DocumentModel> {
  const zip = await openZip(buffer);
  const doc = emptyDocument(opts.sourceFilename, 'pptx');
  const pres = await readXml(zip, 'ppt/presentation.xml');
  if (!pres) throw new Error('DOCX_NO_DOCUMENT');
  const presRels = await readRels(zip, 'ppt/presentation.xml');
  const slidePaths = descAll(pres.documentElement, 'sldId').map((s) => presRels.get(relAttr(s) ?? '')?.target).filter((p): p is string => !!p);
  doc.metadata.pageCount = slidePaths.length;
  const p = new PptxParser(zip, doc);
  for (let i = 0; i < slidePaths.length; i++) doc.blocks.push(...(await p.slide(slidePaths[i], i)));
  return doc;
}

class PptxParser {
  private counter = 0;
  private cache = new Map<string, ImageAsset | null>();
  constructor(private zip: JSZip, private doc: DocumentModel) {}

  async slide(path: string, index: number): Promise<Block[]> {
    const xml = await readXml(this.zip, path);
    if (!xml) return [];
    const sld = xml.documentElement;
    if (attr(sld, 'show') === '0') return [];
    const rels = await readRels(this.zip, path);
    const tree = desc(sld, 'spTree');
    const shapes = this.flatten(tree);
    shapes.sort((a, b) => (Math.abs(a.y - b.y) < 200000 ? a.x - b.x : a.y - b.y));
    const out: Block[] = [];
    let hasTitle = false;
    for (const s of shapes) {
      const tag = s.el.localName;
      if (tag === 'sp') {
        const ph = desc(kid(s.el, 'nvSpPr'), 'ph');
        const phType = attr(ph, 'type');
        if (phType === 'sldNum' || phType === 'dt' || phType === 'ftr') continue;
        const paras = this.paragraphs(kid(s.el, 'txBody'), rels);
        if (!paras.length) continue;
        if (phType === 'title' || phType === 'ctrTitle') {
          hasTitle = true;
          out.unshift({ type: 'heading', level: index === 0 || phType === 'ctrTitle' ? 1 : 2, inlines: joinParas(paras) });
          continue;
        }
        const bodyDefault = !!ph && (phType === 'body' || phType === null || phType === 'obj');
        out.push(...this.textBlocks(paras, bodyDefault));
      } else if (tag === 'pic') {
        const img = await this.picture(s.el, rels);
        if (img) out.push(img);
      } else if (tag === 'graphicFrame') {
        const tbl = desc(s.el, 'tbl');
        if (tbl) out.push(this.table(tbl, rels));
      }
    }
    // Diapositive sans espace réservé de titre : un premier paragraphe court en grande police devient le titre.
    if (!hasTitle && out[0]?.type === 'paragraph') {
      const firstShape = shapes.find((s) => s.el.localName === 'sp');
      const paras = firstShape ? this.paragraphs(kid(firstShape.el, 'txBody'), new Map()) : [];
      if (paras.length === 1 && paras[0].size >= 24) out[0] = { type: 'heading', level: index === 0 ? 1 : 2, inlines: out[0].inlines };
    }
    return out;
  }

  /** Aplatit les groupes de formes en conservant leur position. */
  private flatten(tree: Element | null): Shape[] {
    const out: Shape[] = [];
    for (const el of kids(tree)) {
      const n = el.localName;
      if (n === 'grpSp') { out.push(...this.flatten(el)); continue; }
      if (n !== 'sp' && n !== 'pic' && n !== 'graphicFrame') continue;
      const off = desc(el, 'off');
      out.push({ el, x: Number(attr(off, 'x') ?? 0), y: Number(attr(off, 'y') ?? 0) });
    }
    return out;
  }

  private paragraphs(txBody: Element | null, rels: Map<string, { target: string; external: boolean }>): Para[] {
    const out: Para[] = [];
    for (const p of kids(txBody, 'p')) {
      const pPr = kid(p, 'pPr');
      let bullet: Para['bullet'] = null;
      if (kid(pPr, 'buAutoNum')) bullet = 'number';
      else if (kid(pPr, 'buChar') || kid(pPr, 'buBlip')) bullet = 'bullet';
      else if (kid(pPr, 'buNone')) bullet = null;
      const inlines: Inline[] = [];
      let size = 0, monoChars = 0, chars = 0;
      for (const r of kids(p)) {
        if (r.localName === 'br') { inlines.push({ type: 'br' }); continue; }
        if (r.localName !== 'r' && r.localName !== 'fld') continue;
        if (r.localName === 'fld' && attr(r, 'type') === 'slidenum') continue;
        const rPr = kid(r, 'rPr');
        const text = kid(r, 't')?.textContent ?? '';
        if (!text) continue;
        const font = attr(kid(rPr, 'latin'), 'typeface');
        const mono = isMonoFont(font);
        chars += text.length;
        if (mono) monoChars += text.length;
        size = Math.max(size, Number(attr(rPr, 'sz') ?? 0) / 100);
        const inl: Inline = { type: 'text', text };
        if (attr(rPr, 'b') === '1') inl.bold = true;
        if (attr(rPr, 'i') === '1') inl.italic = true;
        const u = attr(rPr, 'u');
        if (u && u !== 'none') inl.underline = true;
        if ((attr(rPr, 'strike') ?? 'noStrike') !== 'noStrike') inl.strike = true;
        if (mono) inl.code = true;
        const link = kid(rPr, 'hlinkClick');
        const rel = link ? rels.get(relAttr(link) ?? '') : undefined;
        if (rel?.external && /^(https?:|mailto:)/i.test(rel.target)) inlines.push({ type: 'link', href: rel.target, children: [inl] });
        else inlines.push(inl);
      }
      if (!inlines.some((i) => i.type !== 'br')) continue;
      out.push({ lvl: Number(attr(pPr, 'lvl') ?? '0'), bullet, noBullet: !!kid(pPr, 'buNone'), inlines, size, mono: chars > 0 && monoChars === chars });
    }
    return out;
  }

  /** Paragraphes d'une zone de texte → listes imbriquées, blocs de code ou paragraphes. */
  private textBlocks(paras: Para[], bulletsByDefault: boolean): Block[] {
    const out: Block[] = [];
    if (paras.every((p) => p.mono)) {
      return [{ type: 'code', text: paras.map((p) => p.inlines.map((i) => i.text ?? (i.type === 'br' ? '\n' : '')).join('')).join('\n') }];
    }
    let run: Para[] = [];
    const isItem = (p: Para) => p.bullet !== null || (bulletsByDefault && !p.noBullet && paras.length > 1);
    const flush = () => {
      if (run.length) out.push(...buildList(run));
      run = [];
    };
    for (const p of paras) {
      if (isItem(p)) run.push(p);
      else {
        flush();
        out.push({ type: 'paragraph', inlines: p.inlines });
      }
    }
    flush();
    return out;
  }

  private async picture(el: Element, rels: Map<string, { target: string; external: boolean }>): Promise<Block | null> {
    const blip = desc(el, 'blip');
    const rid = relAttr(blip, 'embed');
    const rel = rid ? rels.get(rid) : undefined;
    if (!rel || rel.external) return null;
    const alt = attr(desc(el, 'cNvPr'), 'descr') ?? '';
    let asset = this.cache.get(rel.target);
    if (asset === undefined) {
      asset = null;
      const f = this.zip.file(rel.target);
      const ext = rel.target.split('.').pop()?.toLowerCase() ?? '';
      if (f && ['emf', 'wmf', 'svg'].includes(ext)) {
        this.doc.metadata.warnings.push({ code: 'IMAGE_FORMAT_UNSUPPORTED', message: `Image ${rel.target.split('/').pop()} au format ${ext.toUpperCase()} ignorée.` });
      } else if (f) {
        this.counter++;
        try {
          asset = await makeImageAsset(`img-${this.counter}`, await f.async('uint8array'), undefined, { index: this.counter });
        } catch { asset = null; }
        if (asset) {
          const dup = this.doc.images.find((im) => im.sha256 === asset!.sha256);
          if (dup) asset = dup; else this.doc.images.push(asset);
        }
      }
      this.cache.set(rel.target, asset);
    }
    return asset ? { type: 'image', imageId: asset.id, alt } : null;
  }

  private table(tbl: Element, rels: Map<string, { target: string; external: boolean }>): Block {
    const firstRow = attr(kid(tbl, 'tblPr'), 'firstRow') === '1';
    const rows: { cells: TableCell[] }[] = [];
    kids(tbl, 'tr').forEach((tr, ri) => {
      const cells: TableCell[] = [];
      for (const tc of kids(tr, 'tc')) {
        if (attr(tc, 'hMerge') === '1' || attr(tc, 'vMerge') === '1') continue;
        const paras = this.paragraphs(kid(tc, 'txBody'), rels);
        cells.push({
          blocks: paras.map((p) => ({ type: 'paragraph' as const, inlines: p.inlines })),
          header: firstRow && ri === 0,
          colspan: Number(attr(tc, 'gridSpan') ?? '1') || 1,
          rowspan: Number(attr(tc, 'rowSpan') ?? '1') || 1,
        });
      }
      rows.push({ cells });
    });
    if (rows.length > 1 && !firstRow) {
      const allBold = rows[0].cells.every((c) => c.blocks.length && c.blocks.every((b) => b.type === 'paragraph' && b.inlines.every((i) => i.type !== 'text' || i.bold)));
      if (allBold) rows[0].cells.forEach((c) => (c.header = true));
    }
    return { type: 'table', rows };
  }
}

function joinParas(paras: Para[]): Inline[] {
  const out: Inline[] = [];
  paras.forEach((p, i) => {
    if (i) out.push({ type: 'text', text: ' ' });
    out.push(...p.inlines.map((x) => (x.type === 'br' ? { type: 'text' as const, text: ' ' } : x)));
  });
  return out;
}

function buildList(items: Para[]): Block[] {
  const root: ListBlock[] = [];
  const stack: { lvl: number; list: ListBlock }[] = [];
  for (const it of items) {
    while (stack.length && stack[stack.length - 1].lvl > it.lvl) stack.pop();
    let cur = stack[stack.length - 1];
    const ordered = it.bullet === 'number';
    if (!cur || cur.lvl < it.lvl) {
      const list: ListBlock = { type: 'list', ordered, items: [] };
      if (cur) {
        if (!cur.list.items.length) cur.list.items.push({ blocks: [] });
        cur.list.items[cur.list.items.length - 1].blocks.push(list);
      } else root.push(list);
      stack.push({ lvl: it.lvl, list });
      cur = stack[stack.length - 1];
    }
    cur.list.items.push({ blocks: [{ type: 'paragraph', inlines: it.inlines }] });
  }
  return root;
}
