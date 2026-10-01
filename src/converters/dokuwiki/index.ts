import type { Block, DocumentModel, ImageAsset, Inline, ListBlock } from '../../model/types';
import { inlinesToPlainText } from '../../model/types';
import type { ConversionResult, Converter, ConverterOptions } from '../base';
import { renderGenericPreview, CALLOUT_CSS } from '../../preview/generic';

export interface DokuWikiOptions extends ConverterOptions {
  /** Espace de noms des images (ex. "wiki:procedures"), vide = racine. */
  namespace: string;
  /** Rendu des avertissements : citation portable, plugin note, ou plugin wrap. */
  admonitionStyle: 'quote' | 'note' | 'wrap';
}

const NOTE_KIND: Record<string, string> = { warning: 'warning', note: '', info: '', tip: 'tip' };
const WRAP_KIND: Record<string, string> = { warning: 'important', note: 'info', info: 'info', tip: 'tip' };
const LABELS: Record<string, string> = { warning: 'Attention', note: 'Note', info: 'Info', tip: 'Astuce' };

export class DokuWikiConverter implements Converter<DokuWikiOptions> {
  readonly id = 'dokuwiki';
  readonly label = 'DokuWiki';
  readonly extension = 'txt';
  readonly description = 'Syntaxe DokuWiki native';
  readonly available = true;

  defaultOptions(): DokuWikiOptions {
    return { imagePrefix: '', namespace: '', admonitionStyle: 'quote' };
  }

  convert(doc: DocumentModel, options: DokuWikiOptions): ConversionResult {
    const main = new Renderer(doc, options).render();
    const names = doc.images.map((im) => options.imagePrefix + im.filename);
    const notes: string[] = [];
    if (names.length) notes.push(`Téléversez ${names.length} image(s) dans le gestionnaire de médias${options.namespace ? ` (espace de noms ${options.namespace})` : ''} : ${names.join(', ')}`);
    if (options.admonitionStyle !== 'quote' && doc.blocks.some((b) => b.type === 'admonition')) notes.push(`Les avertissements utilisent le plugin ${options.admonitionStyle === 'note' ? 'Note' : 'Wrap'} ; installez-le ou choisissez le style « citation ».`);
    const css = `body{font-family:Arial,Helvetica,sans-serif;color:#333;font-size:14px}h1{font-size:2em;border-bottom:1px solid #ccc}h2{font-size:1.5em;border-bottom:1px solid #ccc}h3{font-size:1.25em}
table{border-collapse:collapse}th,td{border:1px solid #ccc;padding:3px 8px}th{background:#eee}pre.code{background:#f5f5f5;border:1px solid #ddd;padding:8px;font-family:monospace}code{font-family:monospace;background:#f5f5f5}a{color:#2b73b7}blockquote{border-left:2px solid #999;margin:0;padding-left:10px}${CALLOUT_CSS}`;
    return {
      main,
      mainFilename: 'dokuwiki.txt',
      mimeType: 'text/plain; charset=utf-8',
      extraFiles: {},
      clipboard: { 'text/plain': main },
      previewHtml: renderGenericPreview(doc, options.imagePrefix, css),
      notes,
    };
  }
}

class Renderer {
  private images: Map<string, ImageAsset>;
  constructor(private doc: DocumentModel, private o: DokuWikiOptions) {
    this.images = new Map(doc.images.map((im) => [im.id, im]));
  }
  render(): string {
    return this.doc.blocks.map((b) => this.block(b)).filter(Boolean).join('\n\n').trim() + '\n';
  }
  block(b: Block): string {
    switch (b.type) {
      case 'heading': {
        const n = Math.max(2, 7 - Math.min(b.level, 5));
        const eq = '='.repeat(n);
        return `${eq} ${this.inlines(b.inlines)} ${eq}`;
      }
      case 'paragraph': return this.inlines(b.inlines).replace(/^(\s{2,}[*-]|[>|^])/, '%%$1%%');
      case 'list': return this.list(b, 1);
      case 'table': return this.table(b);
      case 'image': return this.image(b.imageId, b.alt, b.caption);
      case 'code': return `<code${b.language ? ' ' + b.language.replace(/[^a-z0-9+#-]/gi, '') : ''}>\n${b.text}\n</code>`;
      case 'admonition': {
        const inner = b.blocks.map((x) => this.block(x)).join('\n\n');
        const title = b.title ?? LABELS[b.kind];
        if (this.o.admonitionStyle === 'note') return `<note${NOTE_KIND[b.kind] ? ' ' + NOTE_KIND[b.kind] : ''}>\n**${title}** ${inner}\n</note>`;
        if (this.o.admonitionStyle === 'wrap') return `<WRAP ${WRAP_KIND[b.kind]}>\n**${title}** ${inner}\n</WRAP>`;
        return inner.split('\n').map((l) => `> ${l}`.trimEnd()).join('\n').replace(/^> /, `> **${title}** `);
      }
      case 'quote': return b.blocks.map((x) => this.block(x)).join('\n\n').split('\n').map((l) => `> ${l}`.trimEnd()).join('\n');
      case 'hr': return '----';
    }
  }
  list(b: ListBlock, depth: number): string {
    const marker = b.ordered ? '-' : '*';
    const indent = '  '.repeat(depth);
    const lines: string[] = [];
    for (const item of b.items) {
      const text: string[] = [];
      const nested: string[] = [];
      for (const blk of item.blocks) {
        if (blk.type === 'list') nested.push(this.list(blk, depth + 1));
        else if (blk.type === 'paragraph') text.push(this.inlines(blk.inlines));
        else text.push(this.block(blk).replace(/\n/g, ' \\\\ '));
      }
      lines.push(`${indent}${marker} ${text.join(' \\\\ ')}`);
      lines.push(...nested);
    }
    return lines.join('\n');
  }
  table(b: Extract<Block, { type: 'table' }>): string {
    const lines: string[] = [];
    // Suivi des fusions verticales : colonne → lignes restantes à remplir par ':::'
    const rowspanLeft = new Map<number, number>();
    for (const row of b.rows) {
      let out = '';
      let col = 0;
      const cells = [...row.cells];
      let ci = 0;
      // Nombre de colonnes de la ligne (en comptant les colspans)
      const totalCols = Math.max(...b.rows.map((r) => r.cells.reduce((s, c) => s + c.colspan, 0)));
      while (col < totalCols) {
        if ((rowspanLeft.get(col) ?? 0) > 0) {
          out += '| ::: ';
          rowspanLeft.set(col, rowspanLeft.get(col)! - 1);
          col++;
          continue;
        }
        const c = cells[ci++];
        if (!c) break;
        const sep = c.header ? '^' : '|';
        const content = c.blocks.map((x) => (x.type === 'paragraph' ? this.inlines(x.inlines) : this.block(x))).join(' \\\\ ').replace(/\n/g, ' ').replace(/\|/g, '%%|%%').replace(/\^/g, '%%^%%');
        out += `${sep} ${content} ` + (c.colspan > 1 ? sep.repeat(c.colspan - 1) : '');
        if (c.rowspan > 1) for (let k = 0; k < c.colspan; k++) rowspanLeft.set(col + k, c.rowspan - 1);
        col += c.colspan;
      }
      const last = row.cells.length && row.cells[row.cells.length - 1].header ? '^' : '|';
      lines.push(out + last);
    }
    if (b.caption?.length) lines.unshift(`//${this.inlines(b.caption)}//`);
    return lines.join('\n');
  }
  image(id: string, alt: string, caption?: Inline[]): string {
    const im = this.images.get(id);
    if (!im) return '';
    const name = this.o.imagePrefix + im.filename;
    const ns = this.o.namespace ? `${this.o.namespace.replace(/^:|:$/g, '')}:` : '';
    const cap = caption?.length ? inlinesToPlainText(caption) : alt;
    return `{{:${ns}${name}${cap ? '|' + cap.replace(/[|}]/g, ' ') : ''}}}`;
  }
  inlines(inlines: Inline[]): string {
    return inlines.map((i) => this.inline(i)).join('');
  }
  inline(i: Inline): string {
    if (i.type === 'br') return '\\\\ ';
    if (i.type === 'link') {
      const label = this.inlines(i.children ?? []);
      const href = (i.href ?? '').trim();
      if (!href) return label;
      return `[[${href.replace(/\|/g, '%7C')}|${label || href}]]`;
    }
    let t = escapeDoku(i.text ?? '');
    if (i.code) t = `''${t}''`;
    if (i.bold) t = `**${t}**`;
    if (i.italic) t = `//${t}//`;
    if (i.underline) t = `__${t}__`;
    if (i.strike) t = `<del>${t}</del>`;
    return t;
  }
}

export function escapeDoku(s: string): string {
  return s.replace(/(\*\*|\/\/|__|''|\[\[|\]\]|\{\{|\}\}|<[a-zA-Z/]|\\\\ |~~|\(c\)|\(r\)|\(tm\)|(?:https?|ftp):\/\/\S+)/g, '%%$1%%');
}
