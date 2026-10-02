import type { Block, DocumentModel, ImageAsset, Inline } from '../../model/types';
import { inlinesToPlainText } from '../../model/types';
import type { ConversionResult, Converter, ConverterOptions } from '../base';
import { renderMediaWikiPreview } from '../../preview/mediawiki';

export interface MediaWikiOptions extends ConverterOptions {
  /** Espace de noms des fichiers : "File" ou "Fichier". */
  fileNamespace: string;
  /** Utiliser <syntaxhighlight> (extension) ou <pre>. */
  syntaxHighlight: boolean;
  /** Catégories ajoutées en fin de page. */
  categories: string[];
  /** Largeur des vignettes en px (0 = pas de contrainte). */
  thumbWidth: number;
  /** Rendu des admonitions : "div" (portable) ou "template" avec nom de modèle. */
  admonitionStyle: 'div' | 'template';
  admonitionTemplates: Record<string, string>;
  toc: 'auto' | 'force' | 'none';
}

const ADMONITION_COLORS: Record<string, { border: string; bg: string; label: string }> = {
  warning: { border: '#d33', bg: '#fee7e6', label: 'Attention' },
  note: { border: '#36c', bg: '#eaf3ff', label: 'Note' },
  info: { border: '#36c', bg: '#eaf3ff', label: 'Info' },
  tip: { border: '#14866d', bg: '#d5fdf4', label: 'Astuce' },
};

export class MediaWikiConverter implements Converter<MediaWikiOptions> {
  readonly id = 'mediawiki';
  readonly label = 'MediaWiki';
  readonly extension = 'txt';
  readonly description = 'Wikitext natif, à coller dans l’éditeur de MediaWiki';
  readonly available = true;

  defaultOptions(): MediaWikiOptions {
    return {
      imagePrefix: '',
      fileNamespace: 'File',
      syntaxHighlight: true,
      categories: [],
      thumbWidth: 0,
      admonitionStyle: 'div',
      admonitionTemplates: { warning: 'Warning', note: 'Note', info: 'Info', tip: 'Tip' },
      toc: 'auto',
    };
  }

  convert(doc: DocumentModel, options: MediaWikiOptions): ConversionResult {
    const r = new Renderer(doc, options);
    const main = r.render();
    const imageNames = doc.images.map((im) => options.imagePrefix + im.filename);
    const notes: string[] = [];
    if (imageNames.length) {
      notes.push(`Téléversez ${imageNames.length} image(s) dans le wiki avec exactement ces noms : ${imageNames.join(', ')}`);
    }
    if (doc.blocks.some(hasCode) && options.syntaxHighlight) {
      notes.push('Les blocs de code utilisent <syntaxhighlight> (extension SyntaxHighlight). Désactivez l’option si elle n’est pas installée.');
    }
    return {
      main,
      mainFilename: 'mediawiki.txt',
      mimeType: 'text/plain; charset=utf-8',
      extraFiles: {},
      clipboard: { 'text/plain': main },
      previewHtml: renderMediaWikiPreview(main, doc, options),
      notes,
    };
  }
}

function hasCode(b: Block): boolean {
  if (b.type === 'code') return true;
  if (b.type === 'list') return b.items.some((it) => it.blocks.some(hasCode));
  if (b.type === 'admonition' || b.type === 'quote') return b.blocks.some(hasCode);
  if (b.type === 'table') return b.rows.some((r) => r.cells.some((c) => c.blocks.some(hasCode)));
  return false;
}

class Renderer {
  private imagesById: Map<string, ImageAsset>;

  constructor(private doc: DocumentModel, private o: MediaWikiOptions) {
    this.imagesById = new Map(doc.images.map((im) => [im.id, im]));
  }

  render(): string {
    const parts: string[] = [];
    if (this.o.toc === 'force') parts.push('__TOC__');
    if (this.o.toc === 'none') parts.push('__NOTOC__');
    for (const b of this.doc.blocks) parts.push(this.block(b));
    for (const c of this.o.categories) parts.push(`[[Category:${c}]]`);
    return parts.filter((p) => p !== '').join('\n\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }

  block(b: Block, listPrefix = ''): string {
    switch (b.type) {
      case 'heading': {
        // Le niveau 1 (= titre =) est réservé au titre de page.
        const eq = '='.repeat(Math.min(b.level + 1, 6));
        return `${eq} ${this.inlines(b.inlines).replace(/=+$/, (m) => `<nowiki>${m}</nowiki>`)} ${eq}`;
      }
      case 'paragraph':
        return this.protectLineStart(this.inlines(b.inlines));
      case 'list':
        return this.list(b, listPrefix);
      case 'table':
        return this.table(b);
      case 'image':
        return this.image(b.imageId, b.alt, b.caption);
      case 'code': {
        const txt = b.text.replace(/<\/(syntaxhighlight|pre)>/gi, '&lt;/$1&gt;');
        if (this.o.syntaxHighlight) {
          const lang = b.language ? ` lang="${b.language.replace(/[^a-z0-9+#-]/gi, '')}"` : '';
          return `<syntaxhighlight${lang}>\n${txt}\n</syntaxhighlight>`;
        }
        return `<pre>\n${txt.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}\n</pre>`;
      }
      case 'admonition': {
        const inner = b.blocks.map((x) => this.block(x)).join('\n\n');
        if (this.o.admonitionStyle === 'template') {
          const tpl = this.o.admonitionTemplates[b.kind] ?? 'Note';
          return `{{${tpl}|${inner.replace(/\|/g, '{{!}}')}}}`;
        }
        const c = ADMONITION_COLORS[b.kind] ?? ADMONITION_COLORS.note;
        return `<div class="wc-admonition wc-${b.kind}" style="border-left:4px solid ${c.border};background:${c.bg};padding:0.5em 1em;margin:1em 0;">\n'''${b.title ?? c.label}'''\n\n${inner}\n</div>`;
      }
      case 'quote':
        return `<blockquote>\n${b.blocks.map((x) => this.block(x)).join('\n\n')}\n</blockquote>`;
      case 'hr':
        return '----';
    }
  }

  list(b: Extract<Block, { type: 'list' }>, prefix: string): string {
    const marker = b.ordered ? '#' : '*';
    const p = prefix + marker;
    const lines: string[] = [];
    for (const item of b.items) {
      const first: string[] = [];
      const nested: string[] = [];
      for (const blk of item.blocks) {
        if (blk.type === 'list') nested.push(this.list(blk, p));
        else if (blk.type === 'paragraph') first.push(this.inlines(blk.inlines));
        else if (blk.type === 'image') first.push(this.image(blk.imageId, blk.alt, blk.caption));
        else if (blk.type === 'code') nested.push(`${p}: ${this.block(blk).replace(/\n/g, '<br />')}`);
        else first.push(this.block(blk).replace(/\n+/g, '<br />'));
      }
      lines.push(`${p} ${first.join('<br />')}`.trimEnd());
      lines.push(...nested);
    }
    return lines.join('\n');
  }

  table(b: Extract<Block, { type: 'table' }>): string {
    const out: string[] = ['{| class="wikitable"'];
    if (b.caption && b.caption.length) out.push(`|+ ${this.inlines(b.caption)}`);
    b.rows.forEach((row, ri) => {
      if (ri > 0 || true) out.push('|-');
      for (const cell of row.cells) {
        const attrs: string[] = [];
        if (cell.colspan > 1) attrs.push(`colspan="${cell.colspan}"`);
        if (cell.rowspan > 1) attrs.push(`rowspan="${cell.rowspan}"`);
        const content = cell.blocks
          .map((x) => (x.type === 'paragraph' ? this.inlines(x.inlines) : this.block(x)))
          .join('<br />')
          .replace(/\n/g, '<br />')
          .replace(/\|\|/g, '&#124;&#124;');
        const marker = cell.header ? '!' : '|';
        const prefix = attrs.length ? `${attrs.join(' ')} | ` : ' ';
        // Protéger un contenu commençant par un caractère de syntaxe de tableau.
        const safe = /^[-+}!|]/.test(content) ? `<nowiki/>${content}` : content;
        out.push(`${marker}${prefix}${safe}`);
      }
    });
    out.push('|}');
    return out.join('\n');
  }

  image(imageId: string, alt: string, caption?: Inline[]): string {
    const im = this.imagesById.get(imageId);
    if (!im) return '';
    const name = this.o.imagePrefix + im.filename;
    const cap = caption && caption.length ? this.inlines(caption) : alt ? escapeWiki(alt) : '';
    const parts = [`${this.o.fileNamespace}:${name}`, 'thumb'];
    if (this.o.thumbWidth > 0) parts.push(`${this.o.thumbWidth}px`);
    if (cap) parts.push(cap.replace(/\|/g, '&#124;'));
    return `[[${parts.join('|')}]]`;
  }

  inlines(inlines: Inline[]): string {
    return inlines.map((i) => this.inline(i)).join('');
  }

  inline(i: Inline): string {
    if (i.type === 'br') return '<br />';
    if (i.type === 'link') {
      const label = this.inlines(i.children ?? []);
      const href = (i.href ?? '').trim();
      if (!href) return label;
      const safeHref = href.replace(/[\s\]]/g, encodeURIComponent);
      const plain = inlinesToPlainText(i.children ?? []).trim();
      // Lien dont le texte est l'adresse : URL libre, que MediaWiki affiche telle quelle et rend cliquable.
      if (!plain || plain === href) return /^https?:\/\/[^\s[\]<>{}|'"]+$/.test(href) ? href : `[${safeHref}]`;
      return `[${safeHref} ${label}]`;
    }
    let t = escapeWiki(i.text ?? '');
    if (i.code) t = `<code>${t}</code>`;
    if (i.bold) t = `'''${t}'''`;
    if (i.italic) t = `''${t}''`;
    if (i.underline) t = `<u>${t}</u>`;
    if (i.strike) t = `<s>${t}</s>`;
    return t;
  }

  /** Une ligne commençant par un caractère de syntaxe wiki changerait de sens : on la protège. */
  protectLineStart(s: string): string {
    return s
      .split('\n')
      .map((line) => (/^(\s|[*#:;=|!]|\{\||----)/.test(line) ? `<nowiki/>${line}` : line))
      .join('\n');
  }
}

/** Échappe le texte brut pour le wikitext (hors début de ligne, géré à part). */
export function escapeWiki(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/''/g, "<nowiki>''</nowiki>")
    .replace(/\[\[/g, '<nowiki>[[</nowiki>')
    .replace(/\]\]/g, '<nowiki>]]</nowiki>')
    .replace(/\{\{/g, '<nowiki>{{</nowiki>')
    .replace(/\}\}/g, '<nowiki>}}</nowiki>')
    .replace(/~{3,}/g, (m) => `<nowiki>${m}</nowiki>`)
    .replace(/__([A-Z]+)__/g, '<nowiki>__$1__</nowiki>')
    .replace(/\b((?:https?|ftp):\/\/[^\s<]+)/g, '<nowiki>$1</nowiki>');
}
