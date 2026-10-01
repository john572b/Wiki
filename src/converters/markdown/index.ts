import type { Block, DocumentModel, ImageAsset, Inline, ListBlock } from '../../model/types';
import { inlinesToPlainText } from '../../model/types';
import type { ConversionResult, Converter, ConverterOptions } from '../base';
import { renderGenericPreview, CALLOUT_CSS } from '../../preview/generic';

export interface MarkdownOptions extends ConverterOptions {
  /** Chemin préfixé aux images dans les liens (ex. "images/" ou "uploads/"). */
  imagePath: string;
  /** Avertissements : alertes GitHub/GitLab (`> [!WARNING]`) ou citation simple. */
  admonitionStyle: 'alert' | 'quote';
}

const ALERT: Record<string, string> = { warning: 'WARNING', note: 'NOTE', info: 'NOTE', tip: 'TIP' };
const LABELS: Record<string, string> = { warning: 'Attention', note: 'Note', info: 'Info', tip: 'Astuce' };

export class MarkdownConverter implements Converter<MarkdownOptions> {
  readonly id = 'markdown';
  readonly label = 'Markdown';
  readonly extension = 'md';
  readonly description = 'Markdown GFM : GitHub Wiki, GitLab Wiki, Wiki.js, Gitea, Outline…';
  readonly available = true;

  defaultOptions(): MarkdownOptions {
    return { imagePrefix: '', imagePath: 'images/', admonitionStyle: 'alert' };
  }

  convert(doc: DocumentModel, options: MarkdownOptions): ConversionResult {
    const r = new Renderer(doc, options);
    const main = r.render();
    const names = doc.images.map((im) => options.imagePrefix + im.filename);
    const notes: string[] = [];
    if (names.length) notes.push(`Ajoutez les images au dépôt/wiki sous ${options.imagePath || './'} : ${names.join(', ')}`);
    if (r.tableWarnings) notes.push('Les tableaux Markdown ne gèrent pas les cellules fusionnées : elles ont été dépliées.');
    const css = `body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1f2328;font-size:15px;line-height:1.6}h1,h2{border-bottom:1px solid #d1d9e0;padding-bottom:.3em}
table{border-collapse:collapse}th,td{border:1px solid #d1d9e0;padding:6px 13px}th{background:#f6f8fa}tr:nth-child(2n) td{background:#f6f8fa}pre.code{background:#f6f8fa;padding:12px;border-radius:6px;font-size:85%;font-family:ui-monospace,Menlo,monospace}code{background:#f0f1f3;border-radius:4px;padding:.1em .3em;font-size:85%}a{color:#0969da}blockquote{border-left:4px solid #d1d9e0;margin:0;padding:0 1em;color:#59636e}${CALLOUT_CSS}`;
    return {
      main,
      mainFilename: 'markdown.md',
      mimeType: 'text/markdown; charset=utf-8',
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
  constructor(private doc: DocumentModel, private o: MarkdownOptions) {
    this.images = new Map(doc.images.map((im) => [im.id, im]));
  }
  render(): string {
    return this.doc.blocks.map((b) => this.block(b)).filter(Boolean).join('\n\n').trim() + '\n';
  }
  block(b: Block): string {
    switch (b.type) {
      case 'heading': return `${'#'.repeat(Math.min(b.level, 6))} ${this.inlines(b.inlines)}`;
      case 'paragraph': return this.inlines(b.inlines).replace(/^(\s*)([#>+\-*]|\d+[.)]|\|)/, '$1\\$2');
      case 'list': return this.list(b, 0);
      case 'table': return this.table(b);
      case 'image': return this.image(b.imageId, b.alt, b.caption);
      case 'code': {
        const fence = b.text.includes('```') ? '~~~~' : '```';
        return `${fence}${b.language ? b.language.replace(/[^a-z0-9+#-]/gi, '') : ''}\n${b.text}\n${fence}`;
      }
      case 'admonition': {
        const inner = b.blocks.map((x) => this.block(x)).join('\n\n');
        const title = b.title ?? LABELS[b.kind];
        const body = inner.split('\n').map((l) => `> ${l}`.trimEnd()).join('\n');
        if (this.o.admonitionStyle === 'alert') return `> [!${ALERT[b.kind]}]\n${body}`;
        return body.replace(/^> /, `> **${title}** `);
      }
      case 'quote': return b.blocks.map((x) => this.block(x)).join('\n\n').split('\n').map((l) => `> ${l}`.trimEnd()).join('\n');
      case 'hr': return '---';
    }
  }
  list(b: ListBlock, depth: number): string {
    const indent = '    '.repeat(depth);
    const lines: string[] = [];
    b.items.forEach((item, idx) => {
      const marker = b.ordered ? `${(b.start ?? 1) + idx}.` : '-';
      const text: string[] = [];
      const nested: string[] = [];
      for (const blk of item.blocks) {
        if (blk.type === 'list') nested.push(this.list(blk, depth + 1));
        else if (blk.type === 'paragraph') text.push(this.inlines(blk.inlines));
        else nested.push(this.block(blk).split('\n').map((l) => `${indent}    ${l}`).join('\n'));
      }
      lines.push(`${indent}${marker} ${text.join('<br>')}`.trimEnd());
      lines.push(...nested);
    });
    return lines.join('\n');
  }
  table(b: Extract<Block, { type: 'table' }>): string {
    if (!b.rows.length) return '';
    const grid: string[][] = [];
    const cols = Math.max(...b.rows.map((r) => r.cells.reduce((s, c) => s + c.colspan, 0)));
    // Déplie les fusions : la cellule d'origine occupe la première case, les autres sont vides.
    const occupied: boolean[][] = [];
    b.rows.forEach((row, ri) => {
      grid[ri] = grid[ri] ?? [];
      occupied[ri] = occupied[ri] ?? [];
      let col = 0;
      for (const c of row.cells) {
        while (occupied[ri][col]) col++;
        const content = c.blocks.map((x) => (x.type === 'paragraph' ? this.inlines(x.inlines) : this.block(x))).join('<br>').replace(/\n/g, '<br>').replace(/\|/g, '\\|');
        for (let r = 0; r < c.rowspan; r++) for (let k = 0; k < c.colspan; k++) {
          occupied[ri + r] = occupied[ri + r] ?? [];
          grid[ri + r] = grid[ri + r] ?? [];
          occupied[ri + r][col + k] = true;
          grid[ri + r][col + k] = r === 0 && k === 0 ? content : '';
        }
        if (c.colspan > 1 || c.rowspan > 1) this.tableWarnings = true;
        col += c.colspan;
      }
    });
    const headerIsFirst = b.rows[0].cells.some((c) => c.header);
    const lines: string[] = [];
    const rowLine = (cells: string[]) => `| ${Array.from({ length: cols }, (_, i) => cells[i] ?? '').join(' | ')} |`;
    const rows = grid.filter((r) => r);
    if (headerIsFirst) {
      lines.push(rowLine(rows[0]));
      lines.push(`|${' --- |'.repeat(cols)}`);
      rows.slice(1).forEach((r) => lines.push(rowLine(r)));
    } else {
      lines.push(rowLine(Array(cols).fill('')));
      lines.push(`|${' --- |'.repeat(cols)}`);
      rows.forEach((r) => lines.push(rowLine(r)));
    }
    if (b.caption?.length) lines.unshift(`*${this.inlines(b.caption)}*\n`);
    return lines.join('\n');
  }
  image(id: string, alt: string, caption?: Inline[]): string {
    const im = this.images.get(id);
    if (!im) return '';
    const name = this.o.imagePrefix + im.filename;
    const cap = caption?.length ? inlinesToPlainText(caption) : alt;
    const md = `![${cap.replace(/[[\]]/g, '')}](${this.o.imagePath}${encodeURI(name)})`;
    return caption?.length ? `${md}\n\n*${this.inlines(caption)}*` : md;
  }
  inlines(inlines: Inline[]): string {
    return inlines.map((i) => this.inline(i)).join('');
  }
  inline(i: Inline): string {
    if (i.type === 'br') return '<br>';
    if (i.type === 'link') {
      const label = this.inlines(i.children ?? []);
      const href = (i.href ?? '').trim();
      if (!href) return label;
      return `[${label || href}](${href.replace(/[()\s]/g, encodeURIComponent)})`;
    }
    if (i.code) {
      const t = i.text ?? '';
      const ticks = t.includes('`') ? '``' : '`';
      return `${ticks}${t}${ticks}`;
    }
    let t = escapeMd(i.text ?? '');
    if (i.bold) t = `**${t}**`;
    if (i.italic) t = `*${t}*`;
    if (i.underline) t = `<u>${t}</u>`;
    if (i.strike) t = `~~${t}~~`;
    return t;
  }
}

export function escapeMd(s: string): string {
  return s.replace(/([\\`*_{}[\]<>~|])/g, '\\$1').replace(/&/g, '&amp;');
}
