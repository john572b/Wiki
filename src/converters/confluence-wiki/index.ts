import type { Block, DocumentModel, ImageAsset, Inline, ListBlock } from '../../model/types';
import { inlinesToPlainText } from '../../model/types';
import type { ConversionResult, Converter, ConverterOptions } from '../base';
import { renderGenericPreview } from '../../preview/generic';

export type ConfluenceWikiOptions = ConverterOptions;

const PANEL: Record<string, string> = { warning: 'warning', note: 'note', info: 'info', tip: 'tip' };

/**
 * Confluence « wiki markup » : boîte Insérer > Balisage de Confluence Server / Data Center,
 * et représentation `wiki` de l'API REST. Non supporté par le nouvel éditeur Cloud (utiliser le format Confluence).
 */
export class ConfluenceWikiConverter implements Converter<ConfluenceWikiOptions> {
  readonly id = 'confluence-wiki';
  readonly label = 'Confluence wiki markup';
  readonly extension = 'txt';
  readonly description = 'Balisage wiki pour Confluence Server / Data Center (Insérer > Balisage)';
  readonly available = true;

  defaultOptions(): ConfluenceWikiOptions {
    return { imagePrefix: '' };
  }

  convert(doc: DocumentModel, options: ConfluenceWikiOptions): ConversionResult {
    const r = new Renderer(doc, options);
    const main = r.render();
    const names = doc.images.map((im) => options.imagePrefix + im.filename);
    const notes = ['Dans Confluence Server/Data Center : Insérer > Balisage > Confluence Wiki, puis collez. Le nouvel éditeur Confluence Cloud ne l’accepte pas : utilisez le format Confluence.'];
    if (names.length) notes.push(`Joignez les images à la page avec exactement ces noms : ${names.join(', ')}`);
    if (r.tableWarnings) notes.push('Le balisage wiki ne gère pas les cellules fusionnées : elles ont été dépliées.');
    const css = `body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#172b4d;font-size:14px}h1{font-size:24px;font-weight:500}h2{font-size:20px;font-weight:500}h3{font-size:16px;font-weight:600}
table{border:1px solid #c1c7d0}th,td{border:1px solid #c1c7d0;padding:7px 10px}th{background:#f4f5f7;text-align:left}pre.code{background:#f4f5f7;border-radius:3px;padding:12px;font-family:Menlo,Consolas,monospace;font-size:12px}code{background:#f4f5f7;padding:1px 4px;font-family:Menlo,Consolas,monospace;font-size:12px}a{color:#0052cc}
.callout{border-radius:3px;padding:12px 16px;margin:12px 0}.callout-title{font-weight:600}.callout.info{background:#deebff}.callout.note{background:#eae6ff}.callout.warning{background:#ffebe6}.callout.tip{background:#e3fcef}`;
    return {
      main,
      mainFilename: 'confluence-wiki.txt',
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
  tableWarnings = false;
  constructor(private doc: DocumentModel, private o: ConfluenceWikiOptions) {
    this.images = new Map(doc.images.map((im) => [im.id, im]));
  }
  render(): string {
    return this.doc.blocks.map((b) => this.block(b)).filter(Boolean).join('\n\n').trim() + '\n';
  }
  block(b: Block): string {
    switch (b.type) {
      case 'heading': return `h${Math.min(b.level, 6)}. ${this.inlines(b.inlines)}`;
      case 'paragraph': return this.inlines(b.inlines).replace(/^(h\d\.|bq\.|[*#-]\s|\|)/, '\\$1');
      case 'list': return this.list(b, '');
      case 'table': return this.table(b);
      case 'image': return this.image(b.imageId, b.alt, b.caption);
      case 'code': return `{code${b.language ? ':language=' + b.language.replace(/[^a-z0-9+#-]/gi, '') : ''}}\n${b.text.replace(/\{code\}/g, '{code }')}\n{code}`;
      case 'admonition': {
        const inner = b.blocks.map((x) => this.block(x)).join('\n\n');
        const kind = PANEL[b.kind];
        return `{${kind}${b.title ? ':title=' + b.title.replace(/[{}|]/g, '') : ''}}\n${inner}\n{${kind}}`;
      }
      case 'quote': return `{quote}\n${b.blocks.map((x) => this.block(x)).join('\n\n')}\n{quote}`;
      case 'hr': return '----';
    }
  }
  list(b: ListBlock, prefix: string): string {
    const p = prefix + (b.ordered ? '#' : '*');
    const lines: string[] = [];
    for (const item of b.items) {
      const text: string[] = [];
      const nested: string[] = [];
      for (const blk of item.blocks) {
        if (blk.type === 'list') nested.push(this.list(blk, p));
        else if (blk.type === 'paragraph') text.push(this.inlines(blk.inlines));
        else text.push(this.block(blk).replace(/\n/g, ' \\\\ '));
      }
      lines.push(`${p} ${text.join(' \\\\ ')}`);
      lines.push(...nested);
    }
    return lines.join('\n');
  }
  table(b: Extract<Block, { type: 'table' }>): string {
    const lines: string[] = [];
    const cols = Math.max(...b.rows.map((r) => r.cells.reduce((s, c) => s + c.colspan, 0)));
    const occupied: boolean[][] = [];
    const grid: { text: string; header: boolean }[][] = [];
    b.rows.forEach((row, ri) => {
      let col = 0;
      occupied[ri] = occupied[ri] ?? [];
      grid[ri] = grid[ri] ?? [];
      for (const c of row.cells) {
        while (occupied[ri][col]) col++;
        const text = c.blocks.map((x) => (x.type === 'paragraph' ? this.inlines(x.inlines) : this.block(x))).join(' \\\\ ').replace(/\n/g, ' \\\\ ').replace(/\|/g, '\\|');
        for (let r = 0; r < c.rowspan; r++) for (let k = 0; k < c.colspan; k++) {
          occupied[ri + r] = occupied[ri + r] ?? [];
          grid[ri + r] = grid[ri + r] ?? [];
          occupied[ri + r][col + k] = true;
          grid[ri + r][col + k] = { text: r === 0 && k === 0 ? text : ' ', header: c.header };
        }
        if (c.colspan > 1 || c.rowspan > 1) this.tableWarnings = true;
        col += c.colspan;
      }
    });
    for (const row of grid.filter((r) => r)) {
      let line = '';
      for (let i = 0; i < cols; i++) {
        const cell = row[i] ?? { text: ' ', header: false };
        line += cell.header ? `||${cell.text || ' '}` : `|${cell.text || ' '}`;
      }
      line += row[cols - 1]?.header ? '||' : '|';
      lines.push(line);
    }
    return lines.join('\n');
  }
  image(id: string, alt: string, caption?: Inline[]): string {
    const im = this.images.get(id);
    if (!im) return '';
    const name = this.o.imagePrefix + im.filename;
    const cap = caption?.length ? inlinesToPlainText(caption) : alt;
    const tag = `!${name}${cap ? '|alt=' + cap.replace(/[!|,]/g, ' ') : ''}!`;
    return caption?.length ? `${tag}\n_${this.inlines(caption)}_` : tag;
  }
  inlines(inlines: Inline[]): string {
    return inlines.map((i) => this.inline(i)).join('');
  }
  inline(i: Inline): string {
    if (i.type === 'br') return ' \\\\ ';
    if (i.type === 'link') {
      const label = inlinesToPlainText(i.children ?? []).replace(/[[\]|]/g, ' ');
      const href = (i.href ?? '').trim();
      if (!href) return this.inlines(i.children ?? []);
      return label && label !== href ? `[${label}|${href}]` : `[${href}]`;
    }
    if (i.code) return `{{${(i.text ?? '').replace(/\}\}/g, '} }')}}}`;
    let t = escapeCwiki(i.text ?? '');
    if (i.bold) t = `*${t}*`;
    if (i.italic) t = `_${t}_`;
    if (i.underline) t = `+${t}+`;
    if (i.strike) t = `-${t}-`;
    return t;
  }
}

export function escapeCwiki(s: string): string {
  return s.replace(/([\\[\]{}!^~])/g, '\\$1').replace(/(^|\s)([*_+-])(?=\S)/g, '$1\\$2').replace(/(\S)([*_+-])(?=\s|$)/g, '$1\\$2');
}
