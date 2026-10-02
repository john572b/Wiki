import JSZip from 'jszip';
import type { Block, DocumentModel, DocWarning, ImageAsset, Inline, ListBlock, TableCell } from '../model/types';
import { makeImageAsset } from '../util/image';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const PIC = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
const V = 'urn:schemas-microsoft-com:vml';

export const MAX_DOCX_UNCOMPRESSED = 500 * 1024 * 1024;
export const MAX_DOCX_RATIO = 200;

interface StyleInfo {
  id: string;
  name: string;
  basedOn?: string;
  outlineLvl?: number;
  numId?: string;
  ilvl?: number;
  bold?: boolean;
  italic?: boolean;
  font?: string;
  isCode?: boolean;
}

interface NumLevel { ordered: boolean; start: number }

interface RunStyle { bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; code?: boolean }

interface ParaInfo {
  kind: 'heading' | 'paragraph' | 'code' | 'title';
  level: number;
  num?: { numId: string; ilvl: number };
  inlines: Inline[];
  styleName: string;
  isCaption: boolean;
}

export interface DocxParseOptions {
  sourceFilename: string;
}

export async function parseDocx(buffer: ArrayBuffer, opts: DocxParseOptions): Promise<DocumentModel> {
  const zip = await JSZip.loadAsync(buffer);
  checkZip(zip, buffer.byteLength);
  const p = new DocxParser(zip, opts.sourceFilename);
  return p.parse();
}

function checkZip(zip: JSZip, compressedSize: number): void {
  let total = 0;
  for (const [name, f] of Object.entries(zip.files)) {
    if (name.includes('..') || name.startsWith('/') || /^[a-z]:/i.test(name)) throw new Error('ZIP_PATH_TRAVERSAL');
    const sz = (f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
    total += Math.max(0, sz);
  }
  if (total > MAX_DOCX_UNCOMPRESSED || (compressedSize > 0 && total / compressedSize > MAX_DOCX_RATIO && total > 50 * 1024 * 1024)) {
    throw new Error('ZIP_BOMB');
  }
}

class DocxParser {
  private styles = new Map<string, StyleInfo>();
  private numbering = new Map<string, Map<number, NumLevel>>();
  private rels = new Map<string, { target: string; mode: string; type: string }>();
  private images: ImageAsset[] = [];
  private imageCache = new Map<string, ImageAsset | null>();
  private warnings: DocWarning[] = [];
  private imageCounter = 0;
  private xml = new DOMParser();

  constructor(private zip: JSZip, private sourceFilename: string) {}

  async parse(): Promise<DocumentModel> {
    const docXml = await this.readXml('word/document.xml');
    if (!docXml) throw new Error('DOCX_NO_DOCUMENT');
    await this.loadStyles();
    await this.loadNumbering();
    await this.loadRels();
    const title = await this.readCoreTitle();
    const body = docXml.getElementsByTagNameNS(W, 'body')[0];
    const blocks = body ? await this.parseBlockContainer(body) : [];
    return {
      schemaVersion: '1',
      metadata: {
        title: title || null,
        sourceFilename: this.sourceFilename,
        sourceKind: 'docx',
        pageCount: null,
        ocr: { used: false, pages: [] },
        language: null,
        warnings: this.warnings,
      },
      images: this.images,
      blocks,
    };
  }

  private async readXml(path: string): Promise<Document | null> {
    const f = this.zip.file(path);
    if (!f) return null;
    const s = await f.async('string');
    const d = this.xml.parseFromString(s, 'application/xml');
    if (d.getElementsByTagName('parsererror').length) throw new Error('DOCX_XML_INVALID');
    return d;
  }

  private async readCoreTitle(): Promise<string> {
    const d = await this.readXml('docProps/core.xml');
    if (!d) return '';
    const t = d.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', 'title')[0];
    return t?.textContent?.trim() ?? '';
  }

  private async loadStyles(): Promise<void> {
    const d = await this.readXml('word/styles.xml');
    if (!d) return;
    for (const st of Array.from(d.getElementsByTagNameNS(W, 'style'))) {
      const id = st.getAttributeNS(W, 'styleId') ?? '';
      const info: StyleInfo = { id, name: attrVal(child(st, 'name')) ?? id };
      info.basedOn = attrVal(child(st, 'basedOn')) ?? undefined;
      const pPr = child(st, 'pPr');
      if (pPr) {
        const ol = attrVal(child(pPr, 'outlineLvl'));
        if (ol != null) info.outlineLvl = parseInt(ol, 10);
        const numPr = child(pPr, 'numPr');
        if (numPr) {
          info.numId = attrVal(child(numPr, 'numId')) ?? undefined;
          const il = attrVal(child(numPr, 'ilvl'));
          info.ilvl = il != null ? parseInt(il, 10) : 0;
        }
      }
      const rPr = child(st, 'rPr');
      if (rPr) {
        info.bold = isOn(child(rPr, 'b'));
        info.italic = isOn(child(rPr, 'i'));
        const rf = child(rPr, 'rFonts');
        info.font = rf?.getAttributeNS(W, 'ascii') ?? rf?.getAttributeNS(W, 'hAnsi') ?? undefined;
      }
      info.isCode = /\b(code|source|console|html|preformatted|verbatim)\b/i.test(info.name) || isMonoFont(info.font);
      this.styles.set(id, info);
    }
  }

  private async loadNumbering(): Promise<void> {
    const d = await this.readXml('word/numbering.xml');
    if (!d) return;
    const abstracts = new Map<string, Map<number, NumLevel>>();
    for (const an of Array.from(d.getElementsByTagNameNS(W, 'abstractNum'))) {
      const id = an.getAttributeNS(W, 'abstractNumId') ?? '';
      const levels = new Map<number, NumLevel>();
      for (const lvl of Array.from(an.getElementsByTagNameNS(W, 'lvl'))) {
        const ilvl = parseInt(lvl.getAttributeNS(W, 'ilvl') ?? '0', 10);
        const fmt = attrVal(child(lvl, 'numFmt')) ?? 'decimal';
        const start = parseInt(attrVal(child(lvl, 'start')) ?? '1', 10);
        levels.set(ilvl, { ordered: fmt !== 'bullet' && fmt !== 'none', start: isNaN(start) ? 1 : start });
      }
      abstracts.set(id, levels);
    }
    for (const num of Array.from(d.getElementsByTagNameNS(W, 'num'))) {
      const numId = num.getAttributeNS(W, 'numId') ?? '';
      const absId = attrVal(child(num, 'abstractNumId')) ?? '';
      const levels = new Map(abstracts.get(absId) ?? []);
      for (const ov of Array.from(num.getElementsByTagNameNS(W, 'lvlOverride'))) {
        const ilvl = parseInt(ov.getAttributeNS(W, 'ilvl') ?? '0', 10);
        const lvl = child(ov, 'lvl');
        if (lvl) {
          const fmt = attrVal(child(lvl, 'numFmt')) ?? 'decimal';
          levels.set(ilvl, { ordered: fmt !== 'bullet' && fmt !== 'none', start: 1 });
        }
        const so = attrVal(child(ov, 'startOverride'));
        if (so != null && levels.has(ilvl)) levels.get(ilvl)!.start = parseInt(so, 10) || 1;
      }
      this.numbering.set(numId, levels);
    }
  }

  private async loadRels(): Promise<void> {
    const d = await this.readXml('word/_rels/document.xml.rels');
    if (!d) return;
    for (const rel of Array.from(d.getElementsByTagName('Relationship'))) {
      this.rels.set(rel.getAttribute('Id') ?? '', {
        target: rel.getAttribute('Target') ?? '',
        mode: rel.getAttribute('TargetMode') ?? 'Internal',
        type: rel.getAttribute('Type') ?? '',
      });
    }
  }

  /** Parcourt les enfants d'un conteneur de blocs (body, tc, sdtContent…) dans l'ordre réel. */
  private async parseBlockContainer(container: Element): Promise<Block[]> {
    const blocks: Block[] = [];
    const paras: ParaInfo[] = [];
    const flushParas = () => {
      blocks.push(...this.parasToBlocks(paras));
      paras.length = 0;
    };
    for (const el of Array.from(container.childNodes)) {
      if (el.nodeType !== 1) continue;
      const e = el as Element;
      if (e.namespaceURI !== W) continue;
      switch (e.localName) {
        case 'p':
          paras.push(await this.parseParagraph(e));
          break;
        case 'tbl':
          flushParas();
          blocks.push(await this.parseTable(e));
          break;
        case 'sdt': {
          const content = child(e, 'sdtContent');
          if (content) {
            flushParas();
            blocks.push(...(await this.parseBlockContainer(content)));
          }
          break;
        }
        default:
          break;
      }
    }
    flushParas();
    return blocks;
  }

  /** Convertit une suite de paragraphes en blocs : listes imbriquées, blocs de code, légendes. */
  private parasToBlocks(paras: ParaInfo[]): Block[] {
    const out: Block[] = [];
    let i = 0;
    while (i < paras.length) {
      const p = paras[i];
      if (p.num) {
        // Regroupe les paragraphes de liste consécutifs.
        const group: ParaInfo[] = [];
        while (i < paras.length && paras[i].num) group.push(paras[i++]);
        out.push(...this.buildLists(group));
        continue;
      }
      if (p.kind === 'code') {
        const lines: string[] = [];
        while (i < paras.length && paras[i].kind === 'code') lines.push(plain(paras[i++].inlines));
        out.push({ type: 'code', text: lines.join('\n') });
        continue;
      }
      if (p.kind === 'title') {
        out.push({ type: 'heading', level: 1, inlines: p.inlines });
        i++;
        continue;
      }
      if (p.kind === 'heading') {
        out.push({ type: 'heading', level: p.level + 1, inlines: p.inlines });
        i++;
        continue;
      }
      // Paragraphe ordinaire ; une image seule suivie d'une légende → légende attachée.
      const imgOnly = p.inlines.length === 1 && p.inlines[0].type === 'text' && p.inlines[0].text?.startsWith('\u0001img:');
      const blocksForPara = this.paragraphToBlocks(p.inlines);
      if (imgOnly && i + 1 < paras.length && paras[i + 1].isCaption && blocksForPara.length === 1 && blocksForPara[0].type === 'image') {
        blocksForPara[0].caption = paras[i + 1].inlines;
        i++;
      }
      out.push(...blocksForPara);
      i++;
    }
    return out;
  }

  /** Les images sont transportées dans les inlines sous forme de marqueurs ; on les extrait en blocs. */
  private paragraphToBlocks(inlines: Inline[]): Block[] {
    const out: Block[] = [];
    let buf: Inline[] = [];
    const flush = () => {
      if (buf.length) out.push({ type: 'paragraph', inlines: buf });
      buf = [];
    };
    for (const inl of inlines) {
      if (inl.type === 'text' && inl.text?.startsWith('\u0001img:')) {
        flush();
        const [id, alt] = inl.text.slice('\u0001img:'.length).split('\u0002');
        out.push({ type: 'image', imageId: id, alt: alt ?? '' });
      } else {
        buf.push(inl);
      }
    }
    flush();
    return out;
  }

  private buildLists(group: ParaInfo[]): Block[] {
    const root: ListBlock[] = [];
    // pile de (niveau, liste)
    const stack: { ilvl: number; list: ListBlock }[] = [];
    for (const p of group) {
      const { numId, ilvl } = p.num!;
      const lvlInfo = this.numbering.get(numId)?.get(ilvl) ?? { ordered: false, start: 1 };
      while (stack.length && stack[stack.length - 1].ilvl > ilvl) stack.pop();
      let current = stack.length ? stack[stack.length - 1] : undefined;
      if (!current || current.ilvl < ilvl) {
        const list: ListBlock = { type: 'list', ordered: lvlInfo.ordered, start: lvlInfo.start !== 1 ? lvlInfo.start : undefined, items: [] };
        if (current) {
          // Imbriquer dans le dernier item de la liste parente.
          const parentItems = current.list.items;
          if (!parentItems.length) parentItems.push({ blocks: [] });
          parentItems[parentItems.length - 1].blocks.push(list);
        } else {
          root.push(list);
        }
        stack.push({ ilvl, list });
        current = stack[stack.length - 1];
      } else if (current.list.ordered !== lvlInfo.ordered && stack.length === 1) {
        // Changement de type de liste au même niveau racine → nouvelle liste.
        const list: ListBlock = { type: 'list', ordered: lvlInfo.ordered, items: [] };
        root.push(list);
        stack.length = 0;
        stack.push({ ilvl, list });
        current = stack[0];
      }
      current.list.items.push({ blocks: this.paragraphToBlocks(p.inlines) });
    }
    return root;
  }

  private resolveStyle(id: string | null): StyleInfo[] {
    const chain: StyleInfo[] = [];
    let cur = id ? this.styles.get(id) : undefined;
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      chain.push(cur);
      cur = cur.basedOn ? this.styles.get(cur.basedOn) : undefined;
    }
    return chain;
  }

  private async parseParagraph(p: Element): Promise<ParaInfo> {
    const pPr = child(p, 'pPr');
    const styleId = attrVal(child(pPr, 'pStyle'));
    const chain = this.resolveStyle(styleId);
    const styleName = chain[0]?.name ?? '';
    let outlineLvl: number | undefined;
    const direct = attrVal(child(pPr, 'outlineLvl'));
    if (direct != null) outlineLvl = parseInt(direct, 10);
    else outlineLvl = chain.find((s) => s.outlineLvl != null)?.outlineLvl;
    let num: ParaInfo['num'];
    const numPr = child(pPr, 'numPr');
    if (numPr) {
      const numId = attrVal(child(numPr, 'numId'));
      const ilvl = parseInt(attrVal(child(numPr, 'ilvl')) ?? '0', 10) || 0;
      if (numId && numId !== '0') num = { numId, ilvl };
    } else {
      const s = chain.find((x) => x.numId);
      if (s && s.numId && s.numId !== '0' && outlineLvl == null) num = { numId: s.numId, ilvl: s.ilvl ?? 0 };
    }
    const styleBold = chain.find((s) => s.bold != null)?.bold ?? false;
    const styleItalic = chain.find((s) => s.italic != null)?.italic ?? false;
    const styleCode = chain.some((s) => s.isCode);
    const inlines = await this.parseRuns(p, { bold: styleBold, italic: styleItalic, code: styleCode });

    let kind: ParaInfo['kind'] = 'paragraph';
    let level = 0;
    const isTitle = /^(title|titre|titel)$/i.test(styleName) || /^(Title|Titre)$/.test(styleId ?? '');
    const m = /^(heading|titre|überschrift|overskrift|encabezado)\s*(\d)$/i.exec(styleName) ?? /^(Heading|Titre)(\d)$/.exec(styleId ?? '');
    if (isTitle) kind = 'title';
    else if (outlineLvl != null && outlineLvl < 9 && !num) {
      kind = 'heading';
      level = outlineLvl;
    } else if (m) {
      kind = 'heading';
      level = parseInt(m[2], 10) - 1;
    } else if (styleCode && !inlines.some((i) => i.text?.startsWith('\u0001img:'))) {
      kind = 'code';
    } else if (inlines.length && inlines.every((i) => i.type !== 'text' || i.code) && inlines.some((i) => i.type === 'text' && i.code)) {
      kind = 'code';
    }
    if (kind === 'heading' && num) num = undefined;
    const isCaption = /^(caption|légende|legende|beschriftung)$/i.test(styleName);
    return { kind, level, num, inlines, styleName, isCaption };
  }

  private async parseRuns(container: Element, inherited: RunStyle): Promise<Inline[]> {
    const out: Inline[] = [];
    for (const node of Array.from(container.childNodes)) {
      if (node.nodeType !== 1) continue;
      const e = node as Element;
      if (e.namespaceURI === W) {
        switch (e.localName) {
          case 'r':
            out.push(...(await this.parseRun(e, inherited)));
            break;
          case 'hyperlink': {
            const rid = e.getAttributeNS(R, 'id');
            const anchor = e.getAttributeNS(W, 'anchor');
            const children = await this.parseRuns(e, inherited);
            const rel = rid ? this.rels.get(rid) : undefined;
            const href = rel && rel.mode === 'External' ? rel.target : anchor ? `#${anchor}` : '';
            if (href && !href.startsWith('#')) out.push({ type: 'link', href, children });
            else out.push(...children);
            break;
          }
          case 'ins':
          case 'smartTag':
          case 'sdt':
          case 'sdtContent':
          case 'fldSimple':
            out.push(...(await this.parseRuns(e, inherited)));
            break;
          case 'del':
          case 'pPr':
          case 'proofErr':
          case 'bookmarkStart':
          case 'bookmarkEnd':
          default:
            break;
        }
      }
    }
    return out;
  }

  private async parseRun(r: Element, inherited: RunStyle): Promise<Inline[]> {
    const rPr = child(r, 'rPr');
    const st: RunStyle = { ...inherited };
    if (rPr) {
      const rs = attrVal(child(rPr, 'rStyle'));
      const chain = this.resolveStyle(rs);
      const cb = chain.find((s) => s.bold != null)?.bold;
      const ci = chain.find((s) => s.italic != null)?.italic;
      if (cb != null) st.bold = cb;
      if (ci != null) st.italic = ci;
      if (chain.some((s) => s.isCode)) st.code = true;
      const b = child(rPr, 'b');
      if (b) st.bold = isOn(b);
      const i = child(rPr, 'i');
      if (i) st.italic = isOn(i);
      const u = child(rPr, 'u');
      if (u) st.underline = (u.getAttributeNS(W, 'val') ?? 'single') !== 'none';
      const strike = child(rPr, 'strike');
      if (strike) st.strike = isOn(strike);
      const rf = child(rPr, 'rFonts');
      const font = rf?.getAttributeNS(W, 'ascii') ?? rf?.getAttributeNS(W, 'hAnsi');
      if (font && isMonoFont(font)) st.code = true;
      const vanish = child(rPr, 'vanish');
      if (vanish && isOn(vanish)) return [];
    }
    const out: Inline[] = [];
    let skipFieldText = false;
    for (const node of Array.from(r.childNodes)) {
      if (node.nodeType !== 1) continue;
      const e = node as Element;
      if (e.namespaceURI === W) {
        switch (e.localName) {
          case 't':
            if (!skipFieldText) out.push(mk(e.textContent ?? '', st));
            break;
          case 'tab':
            out.push(mk('\t', st));
            break;
          case 'br':
            if (e.getAttributeNS(W, 'type') !== 'page') out.push({ type: 'br' });
            break;
          case 'cr':
            out.push({ type: 'br' });
            break;
          case 'sym': {
            const ch = e.getAttributeNS(W, 'char');
            if (ch) out.push(mk(String.fromCodePoint(parseInt(ch, 16) & 0xff), st));
            break;
          }
          case 'drawing': {
            const img = await this.parseDrawing(e);
            if (img) out.push(img);
            break;
          }
          case 'pict':
          case 'object': {
            const img = await this.parseVmlPict(e);
            if (img) out.push(img);
            break;
          }
          case 'fldChar': {
            // Champs (TOC, PAGE…) : on garde le résultat affiché, on ignore l'instruction.
            const t = e.getAttributeNS(W, 'fldCharType');
            if (t === 'begin') skipFieldText = true;
            if (t === 'separate' || t === 'end') skipFieldText = false;
            break;
          }
          case 'instrText':
          case 'footnoteReference':
          case 'endnoteReference':
          case 'commentReference':
          default:
            break;
        }
      }
    }
    return out;
  }

  private async parseDrawing(d: Element): Promise<Inline | null> {
    const blip = d.getElementsByTagNameNS(A, 'blip')[0];
    if (!blip) return null;
    const rid = blip.getAttributeNS(R, 'embed') ?? blip.getAttributeNS(R, 'link');
    if (!rid) return null;
    const docPr = d.getElementsByTagNameNS(WP, 'docPr')[0];
    const alt = docPr?.getAttribute('descr') || docPr?.getAttribute('title') || '';
    const cNvPr = d.getElementsByTagNameNS(PIC, 'cNvPr')[0];
    const alt2 = cNvPr?.getAttribute('descr') || '';
    const asset = await this.imageForRel(rid);
    if (!asset) return null;
    return { type: 'text', text: `\u0001img:${asset.id}\u0002${alt || alt2}` };
  }

  private async parseVmlPict(p: Element): Promise<Inline | null> {
    const imagedata = p.getElementsByTagNameNS(V, 'imagedata')[0];
    if (!imagedata) return null;
    const rid = imagedata.getAttributeNS(R, 'id');
    if (!rid) return null;
    const asset = await this.imageForRel(rid);
    if (!asset) return null;
    return { type: 'text', text: `\u0001img:${asset.id}\u0002${imagedata.getAttributeNS(null, 'title') ?? ''}` };
  }

  private async imageForRel(rid: string): Promise<ImageAsset | null> {
    if (this.imageCache.has(rid)) return this.imageCache.get(rid)!;
    const rel = this.rels.get(rid);
    let asset: ImageAsset | null = null;
    if (rel && rel.mode !== 'External') {
      const path = rel.target.startsWith('/') ? rel.target.slice(1) : 'word/' + rel.target.replace(/^\.\//, '');
      const f = this.zip.file(path);
      if (f) {
        const data = await f.async('uint8array');
        const ext = path.split('.').pop()?.toLowerCase() ?? '';
        if (['emf', 'wmf', 'svg'].includes(ext)) {
          this.warnings.push({ code: 'IMAGE_FORMAT_UNSUPPORTED', message: `Image ${path.split('/').pop()} au format ${ext.toUpperCase()} ignorée (non convertible dans le navigateur).` });
        } else {
          this.imageCounter++;
          try {
            asset = await makeImageAsset(`img-${this.imageCounter}`, data, undefined, { index: this.imageCounter });
          } catch (e) {
            this.warnings.push({ code: 'IMAGE_TOO_LARGE', message: `Image ${path.split('/').pop()} trop grande, ignorée.` });
          }
          if (!asset) this.warnings.push({ code: 'IMAGE_UNREADABLE', message: `Image ${path.split('/').pop()} illisible, ignorée.` });
        }
      }
    } else if (rel && rel.mode === 'External') {
      this.warnings.push({ code: 'IMAGE_EXTERNAL', message: 'Une image liée (externe au document) a été ignorée.' });
    }
    if (asset) {
      // Dédoublonnage par contenu.
      const dup = this.images.find((im) => im.sha256 === asset!.sha256);
      if (dup) asset = dup;
      else this.images.push(asset);
    }
    this.imageCache.set(rid, asset);
    return asset;
  }

  private async parseTable(tbl: Element): Promise<Block> {
    const rows: { cells: TableCell[] }[] = [];
    // Suivi des fusions verticales : colonne de grille → cellule d'origine.
    const vmergeOrigin = new Map<number, TableCell>();
    const trs = Array.from(tbl.childNodes).filter((n) => n.nodeType === 1 && (n as Element).localName === 'tr') as Element[];
    for (const tr of trs) {
      const trPr = child(tr, 'trPr');
      const isHeaderRow = isOn(child(trPr, 'tblHeader'));
      const cells: TableCell[] = [];
      let gridCol = 0;
      const tcs = Array.from(tr.childNodes).filter((n) => n.nodeType === 1 && (n as Element).localName === 'tc') as Element[];
      for (const tc of tcs) {
        const tcPr = child(tc, 'tcPr');
        const span = parseInt(attrVal(child(tcPr, 'gridSpan')) ?? '1', 10) || 1;
        const vm = child(tcPr, 'vMerge');
        const vmVal = vm ? (vm.getAttributeNS(W, 'val') ?? 'continue') : null;
        if (vmVal === 'continue') {
          const origin = vmergeOrigin.get(gridCol);
          if (origin) origin.rowspan += 1;
          gridCol += span;
          continue;
        }
        const blocks = await this.parseBlockContainer(tc);
        const cell: TableCell = { blocks, header: isHeaderRow, colspan: span, rowspan: 1 };
        if (vmVal === 'restart') vmergeOrigin.set(gridCol, cell);
        else vmergeOrigin.delete(gridCol);
        cells.push(cell);
        gridCol += span;
      }
      rows.push({ cells });
    }
    // Première ligne entièrement en gras → en-tête.
    if (rows.length && !rows[0].cells.some((c) => c.header)) {
      const allBold = rows[0].cells.every((c) =>
        c.blocks.length > 0 && c.blocks.every((b) => b.type === 'paragraph' && b.inlines.length > 0 && b.inlines.every((i) => i.type !== 'text' || i.bold || !i.text?.trim())),
      );
      if (allBold && rows.length > 1) rows[0].cells.forEach((c) => (c.header = true));
    }
    const caption = findCaption(tbl);
    return { type: 'table', rows, caption };
  }
}

function findCaption(tbl: Element): Inline[] | undefined {
  const tblPr = child(tbl, 'tblPr');
  const cap = attrVal(child(tblPr, 'tblCaption'));
  return cap ? [{ type: 'text', text: cap }] : undefined;
}

function child(el: Element | null | undefined, localName: string): Element | null {
  if (!el) return null;
  for (const n of Array.from(el.childNodes)) {
    if (n.nodeType === 1 && (n as Element).localName === localName && (n as Element).namespaceURI === W) return n as Element;
  }
  return null;
}

function attrVal(el: Element | null): string | null {
  if (!el) return null;
  return el.getAttributeNS(W, 'val') ?? el.getAttribute('w:val');
}

function isOn(el: Element | null): boolean {
  if (!el) return false;
  const v = el.getAttributeNS(W, 'val') || el.getAttribute('w:val');
  return !v || v === '1' || v === 'true' || v === 'on';
}

function isMonoFont(font?: string): boolean {
  return !!font && /courier|consolas|mono|menlo|lucida console|monaco|source code|fira code|cascadia/i.test(font);
}

function mk(t: string, st: RunStyle): Inline {
  const i: Inline = { type: 'text', text: t };
  if (st.bold) i.bold = true;
  if (st.italic) i.italic = true;
  if (st.underline) i.underline = true;
  if (st.strike) i.strike = true;
  if (st.code) i.code = true;
  return i;
}

function plain(inlines: Inline[]): string {
  return inlines.map((i) => (i.type === 'br' ? '\n' : i.type === 'link' ? plain(i.children ?? []) : i.text ?? '')).join('');
}
