import type { ConversionResult } from '../converters/base';
import type { DocumentModel } from '../model/types';
import type { FileKind } from '../detect/detect';

export type JobStatus = 'pending' | 'analyzing' | 'extracting' | 'ocr' | 'converting' | 'done' | 'error';

export const STATUS_LABELS: Record<JobStatus, string> = {
  pending: 'En attente',
  analyzing: 'Analyse',
  extracting: 'Extraction',
  ocr: 'OCR',
  converting: 'Conversion',
  done: 'Terminé',
  error: 'Erreur',
};

export interface JobOutput {
  formatId: string;
  result: ConversionResult;
}

export interface Job {
  id: string;
  file: File;
  /** Nom de dossier (slug) unique dans le lot. */
  slug: string;
  kind: FileKind;
  status: JobStatus;
  /** Détail d'étape (ex. "page 3/10"). */
  detail: string;
  errorCode?: string;
  errorMessage?: string;
  /** Vrai si l'OCR a été utilisé (ou sera nécessaire). */
  ocrUsed: boolean | null;
  doc?: DocumentModel;
  outputs: JobOutput[];
  startedAt?: number;
  finishedAt?: number;
}

export interface PipelineOptions {
  formats: string[];
  langs: string[];
  ocrEnabled: boolean;
  /** Nombre de documents traités simultanément. */
  concurrency: number;
  /** Nombre de threads OCR. */
  ocrWorkers: number;
  maxPages: number;
  maxFileBytes: number;
  imagePrefixMode: 'slug' | 'none';
  mediawiki: { fileNamespace: string; syntaxHighlight: boolean; categories: string[]; admonitionStyle: 'div' | 'template' };
  confluence: { toc: boolean };
}

export const DEFAULT_OPTIONS: PipelineOptions = {
  formats: ['mediawiki', 'confluence'],
  langs: ['fra', 'eng'],
  ocrEnabled: true,
  concurrency: Math.max(1, Math.min(3, (typeof navigator !== 'undefined' ? navigator.hardwareConcurrency ?? 2 : 2) - 1)),
  ocrWorkers: Math.max(1, Math.min(2, (typeof navigator !== 'undefined' ? navigator.hardwareConcurrency ?? 2 : 2) - 1)),
  maxPages: 300,
  maxFileBytes: 50 * 1024 * 1024,
  imagePrefixMode: 'slug',
  mediawiki: { fileNamespace: 'File', syntaxHighlight: true, categories: [], admonitionStyle: 'div' },
  confluence: { toc: false },
};

export const ERROR_MESSAGES: Record<string, string> = {
  PDF_ENCRYPTED: 'PDF protégé par mot de passe.',
  PDF_INVALID: 'PDF illisible ou corrompu.',
  TOO_MANY_PAGES: 'Trop de pages (limite configurable dans les options).',
  FILE_TOO_LARGE: 'Fichier trop volumineux.',
  UNSUPPORTED_TYPE: 'Type de fichier non pris en charge.',
  MIME_MISMATCH: 'Le contenu du fichier ne correspond pas à son extension.',
  ZIP_BOMB: 'Archive DOCX anormalement compressée, refusée.',
  ZIP_PATH_TRAVERSAL: 'Archive DOCX contenant des chemins invalides, refusée.',
  DOCX_NO_DOCUMENT: 'DOCX sans contenu principal.',
  DOCX_XML_INVALID: 'DOCX corrompu (XML invalide).',
  IMAGE_UNREADABLE: 'Image illisible.',
  IMAGE_TOO_LARGE: 'Image trop grande.',
  DOC_NOT_SUPPORTED: 'Le format DOC (Word 97-2003) n’est pas pris en charge dans le navigateur : enregistrez-le en DOCX dans Word, puis réessayez.',
  OCR_FAILED: 'Échec du moteur OCR.',
  TIMEOUT: 'Traitement trop long, interrompu.',
};
