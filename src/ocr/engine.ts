import { createScheduler, createWorker, OEM, type Scheduler, type Worker } from 'tesseract.js';
import type { OcrPage } from './structure';

export interface OcrEngineOptions {
  langs: string[];
  /** Nombre de workers Tesseract (threads WebAssembly). */
  workers: number;
  /** Base des ressources auto-hébergées. */
  basePath?: string;
}

export interface OcrEngine {
  readonly id: string;
  recognize(image: HTMLCanvasElement | OffscreenCanvas | Blob | ImageBitmap, signal?: AbortSignal): Promise<OcrPage>;
  terminate(): Promise<void>;
}

/**
 * Moteur OCR Tesseract (WebAssembly) entièrement servi depuis notre origine :
 * aucun CDN, aucun téléchargement de modèle depuis l'extérieur.
 */
export class TesseractEngine implements OcrEngine {
  readonly id = 'tesseract-wasm';
  private scheduler: Scheduler | null = null;
  private ready: Promise<void> | null = null;
  private workers: Worker[] = [];

  constructor(private opts: OcrEngineOptions) {}

  private async init(): Promise<void> {
    const base = this.opts.basePath ?? '/tesseract';
    const simd = await detectSimd();
    const corePath = `${base}/core/${simd ? 'tesseract-core-simd-lstm.wasm.js' : 'tesseract-core-lstm.wasm.js'}`;
    this.scheduler = createScheduler();
    const n = Math.max(1, this.opts.workers);
    for (let i = 0; i < n; i++) {
      // L'anglais en dernier : le premier modèle pèse le plus sur les accents et caractères spéciaux.
      const langs = [...this.opts.langs].sort((a, b) => (a === 'eng' ? 1 : 0) - (b === 'eng' ? 1 : 0));
      const w = await createWorker(langs, OEM.LSTM_ONLY, {
        workerPath: `${base}/worker.min.js`,
        corePath,
        langPath: `${base}/lang`,
        gzip: true,
        workerBlobURL: false,
        cacheMethod: 'none',
      });
      await w.setParameters({ preserve_interword_spaces: '1', user_defined_dpi: '150' });
      this.workers.push(w);
      this.scheduler.addWorker(w);
    }
  }

  async recognize(image: HTMLCanvasElement | OffscreenCanvas | Blob | ImageBitmap): Promise<OcrPage> {
    if (!this.ready) this.ready = this.init();
    await this.ready;
    let input: HTMLCanvasElement | OffscreenCanvas | Blob = image as HTMLCanvasElement;
    if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) {
      const c = new OffscreenCanvas(image.width, image.height);
      c.getContext('2d')!.drawImage(image, 0, 0);
      input = c;
    }
    if (typeof OffscreenCanvas !== 'undefined' && input instanceof OffscreenCanvas) {
      input = await input.convertToBlob({ type: 'image/png' });
    }
    const res = await this.scheduler!.addJob('recognize', input, {}, { blocks: true, text: false });
    const data = res.data;
    const blocks = (data.blocks ?? []).map((b) => ({
      paragraphs: b.paragraphs.map((p) => ({
        lines: p.lines.map((l) => ({ text: l.text.replace(/\n$/, ''), x0: l.bbox.x0, y0: l.bbox.y0, x1: l.bbox.x1, y1: l.bbox.y1, confidence: l.confidence })),
      })),
    }));
    let w = 0, h = 0;
    if ('width' in image && 'height' in image) { w = image.width as number; h = image.height as number; }
    return { width: w, height: h, blocks, meanConfidence: data.confidence };
  }

  async terminate(): Promise<void> {
    await this.scheduler?.terminate();
    this.scheduler = null;
    this.ready = null;
    this.workers = [];
  }
}

async function detectSimd(): Promise<boolean> {
  try {
    // Module WebAssembly minimal utilisant une instruction SIMD (v128.const).
    const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
    return WebAssembly.validate(bytes);
  } catch {
    return false;
  }
}

/** Prétraitement déterministe : niveaux de gris + agrandissement des petites images (captures d'écran). */
export function preprocessForOcr(bitmap: ImageBitmap, minWidth = 1600): OffscreenCanvas | HTMLCanvasElement {
  const scale = bitmap.width < minWidth ? Math.min(3, Math.ceil((minWidth / bitmap.width) * 2) / 2) : 1;
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = c.getContext('2d') as CanvasRenderingContext2D;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
    d[i] = d[i + 1] = d[i + 2] = g;
    d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
