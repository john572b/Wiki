/**
 * DocumentModel : représentation intermédiaire neutre d'un document.
 * Aucune syntaxe cible (MediaWiki, Confluence…) ne doit apparaître ici.
 */

export const SCHEMA_VERSION = '1';

export type SourceKind = 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'odt' | 'html' | 'markdown' | 'text' | 'csv' | 'image';

export interface Inline {
  type: 'text' | 'link' | 'br';
  text?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  code?: boolean;
  href?: string;
  children?: Inline[];
}

export interface HeadingBlock { type: 'heading'; level: number; inlines: Inline[] }
export interface ParagraphBlock { type: 'paragraph'; inlines: Inline[] }
export interface ListItem { blocks: Block[] }
export interface ListBlock { type: 'list'; ordered: boolean; start?: number; items: ListItem[] }
export interface TableCell { blocks: Block[]; header: boolean; colspan: number; rowspan: number }
export interface TableRow { cells: TableCell[] }
export interface TableBlock { type: 'table'; caption?: Inline[]; rows: TableRow[] }
export interface ImageBlock { type: 'image'; imageId: string; alt: string; caption?: Inline[] }
export interface CodeBlock { type: 'code'; language?: string; text: string }
export type AdmonitionKind = 'note' | 'warning' | 'tip' | 'info';
export interface AdmonitionBlock { type: 'admonition'; kind: AdmonitionKind; title?: string; blocks: Block[] }
export interface QuoteBlock { type: 'quote'; blocks: Block[] }
export interface HrBlock { type: 'hr' }

export type Block =
  | HeadingBlock
  | ParagraphBlock
  | ListBlock
  | TableBlock
  | ImageBlock
  | CodeBlock
  | AdmonitionBlock
  | QuoteBlock
  | HrBlock;

export interface ImageAsset {
  id: string;
  /** Nom de fichier final (image-001.png) */
  filename: string;
  mime: string;
  width: number;
  height: number;
  sha256: string;
  data: Uint8Array;
  origin?: { page?: number; index?: number };
}

export interface DocWarning { code: string; message: string; location?: string }

export interface OcrInfo {
  used: boolean;
  pages: number[];
  engine?: string;
  langs?: string[];
  meanConfidence?: number;
}

export interface DocumentMetadata {
  title: string | null;
  sourceFilename: string;
  sourceKind: SourceKind;
  pageCount: number | null;
  ocr: OcrInfo;
  language: string | null;
  warnings: DocWarning[];
}

export interface DocumentModel {
  schemaVersion: string;
  metadata: DocumentMetadata;
  images: ImageAsset[];
  blocks: Block[];
}

export const text = (t: string, attrs: Partial<Inline> = {}): Inline => ({ type: 'text', text: t, ...attrs });
export const paragraph = (inlines: Inline[]): ParagraphBlock => ({ type: 'paragraph', inlines });
export const heading = (level: number, inlines: Inline[]): HeadingBlock => ({ type: 'heading', level, inlines });

/** Document vide prêt à remplir par un parseur. */
export function emptyDocument(sourceFilename: string, sourceKind: SourceKind): DocumentModel {
  return {
    schemaVersion: SCHEMA_VERSION,
    metadata: { title: null, sourceFilename, sourceKind, pageCount: null, ocr: { used: false, pages: [] }, language: null, warnings: [] },
    images: [],
    blocks: [],
  };
}

export function inlinesToPlainText(inlines: Inline[]): string {
  let out = '';
  for (const i of inlines) {
    if (i.type === 'br') out += '\n';
    else if (i.type === 'link') out += inlinesToPlainText(i.children ?? []);
    else out += i.text ?? '';
  }
  return out;
}

export function blocksToPlainText(blocks: Block[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'heading':
      case 'paragraph':
        parts.push(inlinesToPlainText(b.inlines));
        break;
      case 'list':
        for (const it of b.items) parts.push(blocksToPlainText(it.blocks));
        break;
      case 'table':
        for (const r of b.rows) for (const c of r.cells) parts.push(blocksToPlainText(c.blocks));
        break;
      case 'code':
        parts.push(b.text);
        break;
      case 'admonition':
      case 'quote':
        parts.push(blocksToPlainText(b.blocks));
        break;
      default:
        break;
    }
  }
  return parts.join('\n');
}
