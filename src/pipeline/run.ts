import { detect } from '../detect/detect';
import { imageBaseNameFrom, normalizeDocument } from '../model/normalize';
import type { DocumentModel } from '../model/types';
import { getConverter } from '../converters/registry';
import type { MediaWikiOptions } from '../converters/mediawiki';
import type { ConfluenceOptions } from '../converters/confluence';
import type { OcrEngine } from '../ocr/engine';
import { parseDocx } from '../parsers/docx';
import { parseImage } from '../parsers/image';
import { parsePdf } from '../parsers/pdf';
import { parsePptx } from '../parsers/pptx';
import { parseXlsx } from '../parsers/xlsx';
import { parseOdt } from '../parsers/odt';
import { parseHtml } from '../parsers/html';
import { parseMarkdown } from '../parsers/markdown';
import { parseText } from '../parsers/text';
import { parseCsv } from '../parsers/csv';
import { decodeText } from '../util/text';
import type { Job, JobStatus, PipelineOptions } from './types';
import { ERROR_MESSAGES } from './types';

export interface JobCallbacks {
  onStatus: (job: Job, status: JobStatus, detail?: string) => void;
}

/**
 * Traite UN job, de façon totalement indépendante : ne reçoit que le job et les options,
 * ne lit ni n'écrit rien de partagé. Les erreurs sont converties en codes.
 */
export async function runJob(job: Job, opts: PipelineOptions, ocr: OcrEngine | null, cb: JobCallbacks): Promise<void> {
  const set = (s: JobStatus, d = '') => {
    job.status = s;
    job.detail = d;
    cb.onStatus(job, s, d);
  };
  job.startedAt = Date.now();
  try {
    set('analyzing');
    if (job.file.size > opts.maxFileBytes) throw new Error('FILE_TOO_LARGE');
    const buffer = await job.file.arrayBuffer();
    const det = detect(job.file.name, new Uint8Array(buffer, 0, Math.min(512, buffer.byteLength)));
    job.kind = det.kind;
    if (det.kind === 'doc') throw new Error('DOC_NOT_SUPPORTED');
    if (!det.consistent) throw new Error('MIME_MISMATCH');
    if (det.kind === 'unknown' || det.kind === 'zip') throw new Error('UNSUPPORTED_TYPE');

    set('extracting');
    let doc: DocumentModel;
    const engine = opts.ocrEnabled ? ocr : null;
    switch (det.kind) {
      case 'pdf':
        doc = await parsePdf(buffer, {
          sourceFilename: job.file.name,
          ocr: engine,
          langs: opts.langs,
          maxPages: opts.maxPages,
          dropRepeatedImages: !opts.keepRepeatedImages,
          onStage: (stage, page, total) => set(stage === 'ocr' ? 'ocr' : 'extracting', `page ${page}/${total}`),
        });
        break;
      case 'docx':
        doc = await parseDocx(buffer, { sourceFilename: job.file.name });
        break;
      case 'image':
        doc = await parseImage(buffer, {
          sourceFilename: job.file.name,
          mime: det.mime,
          ocr: engine,
          langs: opts.langs,
          onStage: () => set('ocr'),
        });
        break;
      case 'pptx':
        doc = await parsePptx(buffer, { sourceFilename: job.file.name });
        break;
      case 'xlsx':
        doc = await parseXlsx(buffer, { sourceFilename: job.file.name });
        break;
      case 'odt':
        doc = await parseOdt(buffer, { sourceFilename: job.file.name });
        break;
      case 'html':
        doc = await parseHtml(decodeText(buffer), { sourceFilename: job.file.name });
        break;
      case 'markdown':
        doc = await parseMarkdown(decodeText(buffer), { sourceFilename: job.file.name });
        break;
      case 'text':
        doc = parseText(decodeText(buffer), { sourceFilename: job.file.name });
        break;
      case 'csv':
        doc = parseCsv(decodeText(buffer), { sourceFilename: job.file.name, tab: /\.tsv$/i.test(job.file.name) });
        break;
      default:
        throw new Error('UNSUPPORTED_TYPE');
    }
    job.ocrUsed = doc.metadata.ocr.used;
    doc = normalizeDocument(doc, { imageBaseName: imageBaseNameFrom(job.file.name) });
    job.doc = doc;

    set('converting');
    const imagePrefix = '';
    job.outputs = [];
    for (const formatId of opts.formats) {
      const conv = getConverter(formatId);
      let options = { ...conv.defaultOptions(), imagePrefix };
      if (formatId === 'mediawiki') options = { ...(options as MediaWikiOptions), ...opts.mediawiki } as MediaWikiOptions;
      if (formatId === 'confluence') options = { ...(options as ConfluenceOptions), ...opts.confluence } as ConfluenceOptions;
      job.outputs.push({ formatId, result: conv.convert(doc, options) });
    }
    job.finishedAt = Date.now();
    set('done');
  } catch (e) {
    const code = e instanceof Error && ERROR_MESSAGES[e.message] ? e.message : 'INTERNAL';
    job.errorCode = code;
    job.errorMessage = ERROR_MESSAGES[code] ?? `Erreur interne : ${e instanceof Error ? e.message : String(e)}`;
    job.finishedAt = Date.now();
    set('error', job.errorMessage);
  }
}

/** File d'attente simple : au plus `concurrency` jobs en parallèle, ordre de dépôt respecté. */
export async function runQueue(jobs: Job[], opts: PipelineOptions, ocr: OcrEngine | null, cb: JobCallbacks): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, opts.concurrency) }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      if (job.status !== 'pending') continue;
      await runJob(job, opts, ocr, cb);
    }
  });
  await Promise.all(workers);
}
