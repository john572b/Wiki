import type { DocumentModel } from '../model/types';

export interface ConversionResult {
  /** Contenu principal (ce que l'onglet « Code source » affiche et ce qui est téléchargé). */
  main: string;
  mainFilename: string;
  mimeType: string;
  /** Fichiers supplémentaires (ex. HTML collable pour Confluence). */
  extraFiles: Record<string, string>;
  /** Représentations mises dans le presse-papiers par le bouton Copier. */
  clipboard: { 'text/plain': string; 'text/html'?: string };
  /** Aperçu HTML autonome (sans script). Les images sont référencées par `images/<filename>`. */
  previewHtml: string;
  /** Consignes après collage (images à téléverser, etc.). */
  notes: string[];
}

export interface ConverterOptions {
  /** Préfixe appliqué aux noms de fichiers image (ex. "procedure-01-"). */
  imagePrefix: string;
}

export interface Converter<O extends ConverterOptions = ConverterOptions> {
  readonly id: string;
  readonly label: string;
  readonly extension: string;
  readonly description: string;
  readonly available: boolean;
  defaultOptions(): O;
  convert(doc: DocumentModel, options: O): ConversionResult;
}

export function slugify(name: string): string {
  const base = name.replace(/\.[^.]+$/, '');
  const slug = base
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'document';
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
