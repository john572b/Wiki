import type { Block, DocumentModel, Inline } from '../model/types';
import { escape, previewShell } from './shell';

/**
 * Aperçu HTML générique produit depuis le DocumentModel, habillé d'une feuille de style propre à chaque format.
 * Utilisé par les formats dont la syntaxe ne se prête pas à un rendu direct dans le navigateur.
 */
export function renderGenericPreview(doc: DocumentModel, imagePrefix: string, css: string, opts: { admonitionLabels?: Record<string, string> } = {}): string {
  const r = new HtmlRenderer(doc, imagePrefix, opts.admonitionLabels ?? { warning: 'Attention', note: 'Note', info: 'Info', tip: 'Astuce' });
  return previewShell(doc.metadata.title ?? doc.metadata.sourceFilename, css, r.render());
}

export class HtmlRenderer {
  private names = new Map<string, string>();
  constructor(private doc: DocumentModel, imagePrefix: string, private labels: Record<string, string>, imageBase = 'images/') {
    for (const im of doc.images) this.names.set(im.id, imageBase + imagePrefix + im.filename);
  }
  render(): string {
    return this.doc.blocks.map((b) => this.block(b)).join('\n');
  }
  block(b: Block): string {
    switch (b.type) {
      case 'heading': return `<h${Math.min(b.level, 6)}>${this.inlines(b.inlines)}</h${Math.min(b.level, 6)}>`;
      case 'paragraph': return `<p>${this.inlines(b.inlines)}</p>`;
      case 'list': {
        const tag = b.ordered ? 'ol' : 'ul';
        const start = b.ordered && b.start && b.start !== 1 ? ` start="${b.start}"` : '';
        return `<${tag}${start}>${b.items.map((it) => `<li>${it.blocks.map((x) => (x.type === 'paragraph' ? this.inlines(x.inlines) : this.block(x))).join('')}</li>`).join('')}</${tag}>`;
      }
      case 'table': {
        const rows = b.rows.map((r) => `<tr>${r.cells.map((c) => {
          const tag = c.header ? 'th' : 'td';
          const attrs = (c.colspan > 1 ? ` colspan="${c.colspan}"` : '') + (c.rowspan > 1 ? ` rowspan="${c.rowspan}"` : '');
          return `<${tag}${attrs}>${c.blocks.map((x) => (x.type === 'paragraph' ? this.inlines(x.inlines) : this.block(x))).join('<br>')}</${tag}>`;
        }).join('')}</tr>`).join('');
        const caption = b.caption?.length ? `<caption>${this.inlines(b.caption)}</caption>` : '';
        return `<table>${caption}<tbody>${rows}</tbody></table>`;
      }
      case 'image': {
        const src = this.names.get(b.imageId);
        if (!src) return '';
        const cap = b.caption?.length ? `<figcaption>${this.inlines(b.caption)}</figcaption>` : '';
        return `<figure><img src="${escape(src)}" alt="${escape(b.alt)}">${cap}</figure>`;
      }
      case 'code': return `<pre class="code" data-lang="${escape(b.language ?? '')}"><code>${escape(b.text)}</code></pre>`;
      case 'admonition': return `<div class="callout ${b.kind}"><div class="callout-title">${escape(b.title ?? this.labels[b.kind] ?? b.kind)}</div>${b.blocks.map((x) => this.block(x)).join('')}</div>`;
      case 'quote': return `<blockquote>${b.blocks.map((x) => this.block(x)).join('')}</blockquote>`;
      case 'hr': return '<hr>';
    }
  }
  inlines(inlines: Inline[]): string {
    return inlines.map((i) => this.inline(i)).join('');
  }
  inline(i: Inline): string {
    if (i.type === 'br') return '<br>';
    if (i.type === 'link') return `<a href="${escape(i.href ?? '')}">${this.inlines(i.children ?? [])}</a>`;
    let t = escape(i.text ?? '');
    if (i.code) t = `<code>${t}</code>`;
    if (i.bold) t = `<strong>${t}</strong>`;
    if (i.italic) t = `<em>${t}</em>`;
    if (i.underline) t = `<u>${t}</u>`;
    if (i.strike) t = `<s>${t}</s>`;
    return t;
  }
}

export const CALLOUT_CSS = `
.callout{border-left:4px solid #999;background:#f5f5f5;padding:8px 14px;margin:12px 0;border-radius:3px}
.callout-title{font-weight:600;margin-bottom:4px}
.callout.warning{border-color:#d9534f;background:#fdecea}.callout.note{border-color:#5b6ee1;background:#eef0fc}
.callout.info{border-color:#3498db;background:#eaf4fb}.callout.tip{border-color:#27ae60;background:#e9f7ef}
figure{margin:12px 0}figcaption{font-size:90%;color:#666}
`;
