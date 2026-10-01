import type { OcrEngine } from './engine';
import type { OcrPage } from './structure';

/**
 * Découpage déterministe d'une page en régions de lecture avant OCR :
 * bandes horizontales séparées par des lignes vides, puis colonnes séparées par des gouttières verticales.
 * Tesseract seul mélange souvent les colonnes des mises en page de type CV ou plaquette.
 */
export interface Region { x: number; y: number; w: number; h: number }

type Canvas = HTMLCanvasElement | OffscreenCanvas;

const INK = 150; // luminance en dessous de laquelle un pixel est de l'encre

export interface SegmentOptions { minCoverage?: number; debug?: (info: unknown) => void }

export function segmentRegions(canvas: Canvas, opts: SegmentOptions = {}): Region[] {
  const W = canvas.width, H = canvas.height;
  if (W < 600 || H < 300) return [{ x: 0, y: 0, w: W, h: H }];
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const { data } = ctx.getImageData(0, 0, W, H);
  // Carte d'encre sous-échantillonnée (1 px sur 2) pour la vitesse.
  const step = 2;
  const cols = Math.ceil(W / step), rows = Math.ceil(H / step);
  const ink = new Uint8Array(cols * rows);
  const rowInk = new Int32Array(rows);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = ((y * step) * W + x * step) * 4;
      const lum = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
      if (lum < INK) { ink[y * cols + x] = 1; rowInk[y]++; }
    }
  }
  // Bandes horizontales : suites de lignes contenant de l'encre, fusionnées si l'espace est petit.
  const minGap = Math.max(2, Math.round(rows * 0.012));
  const bands: { y0: number; y1: number }[] = [];
  let y = 0;
  while (y < rows) {
    while (y < rows && rowInk[y] === 0) y++;
    if (y >= rows) break;
    const y0 = y;
    let blank = 0;
    while (y < rows && blank < minGap) { if (rowInk[y] === 0) blank++; else blank = 0; y++; }
    const y1 = y - blank;
    if (y1 - y0 >= Math.max(3, rows * 0.004)) bands.push({ y0, y1 });
  }
  // Gouttières candidates de chaque bande (zones verticales vides), puis regroupement des bandes
  // consécutives partageant une gouttière : des colonnes se poursuivent au travers des espaces horizontaux.
  interface Gap { x0: number; x1: number }
  const gapsOf = bands.map((b) => findGaps(ink, cols, b.y0, b.y1));
  interface Group { bands: { y0: number; y1: number }[]; gutter: Gap | null }
  const groups: Group[] = [];
  bands.forEach((b, i) => {
    const last = groups[groups.length - 1];
    const gaps = gapsOf[i];
    if (last && last.gutter) {
      const g = gaps.find((x) => overlap(x, last.gutter!));
      if (g) {
        last.bands.push(b);
        last.gutter = { x0: Math.max(last.gutter.x0, g.x0), x1: Math.min(last.gutter.x1, g.x1) };
        return;
      }
    }
    const widest = gaps.reduce<Gap | null>((acc, g) => (!acc || g.x1 - g.x0 > acc.x1 - acc.x0 ? g : acc), null);
    groups.push({ bands: [b], gutter: widest });
  });
  const regions: Region[] = [];
  const pad = Math.round(rows * 0.006);
  const toRegion = (y0r: number, y1r: number, x0: number, x1: number): Region => ({
    x: x0 * step, y: Math.max(0, (y0r - pad) * step), w: (x1 - x0) * step, h: Math.min(H, (y1r + pad) * step) - Math.max(0, (y0r - pad) * step),
  });
  for (const g of groups) {
    const y0 = g.bands[0].y0, y1 = g.bands[g.bands.length - 1].y1;
    const valid = g.gutter && isColumnLayout(ink, cols, y0, y1, g.gutter, opts.minCoverage ?? 0.2, opts.debug);
    if (valid && g.gutter) {
      const mid = Math.round((g.gutter.x0 + g.gutter.x1) / 2);
      regions.push(toRegion(y0, y1, 0, mid), toRegion(y0, y1, mid, cols));
    } else {
      for (const b of g.bands) regions.push(toRegion(b.y0, b.y1, 0, cols));
    }
  }
  opts.debug?.({ rows, cols, bands, groups });
  // Si aucune colonne n'a été trouvée, inutile de découper : Tesseract gère les bandes lui-même.
  if (!regions.some((r) => r.w < W)) return [{ x: 0, y: 0, w: W, h: H }];
  return regions;
}

function overlap(a: { x0: number; x1: number }, b: { x0: number; x1: number }): boolean {
  return Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0;
}

/** Zones verticales vides d'une bande, entre 15 % et 85 % de la largeur, assez larges pour être une gouttière. */
function findGaps(ink: Uint8Array, cols: number, y0: number, y1: number): { x0: number; x1: number }[] {
  const height = y1 - y0;
  const colInk = new Int32Array(cols);
  for (let y = y0; y < y1; y++) for (let x = 0; x < cols; x++) colInk[x] += ink[y * cols + x];
  const tolerance = Math.max(1, Math.floor(height * 0.003));
  const minWidth = Math.max(4, Math.round(cols * 0.012));
  const gaps: { x0: number; x1: number }[] = [];
  let x = Math.floor(cols * 0.15);
  const end = Math.ceil(cols * 0.85);
  while (x < end) {
    if (colInk[x] <= tolerance) {
      const x0 = x;
      while (x < cols && colInk[x] <= tolerance) x++;
      if (x - x0 >= minWidth && x <= cols * 0.85) gaps.push({ x0, x1: x });
    } else x++;
  }
  return gaps;
}

/** Les deux côtés d'une gouttière ressemblent-ils à des colonnes de texte (plusieurs lignes, présence verticale, largeur) ? */
function isColumnLayout(ink: Uint8Array, cols: number, y0: number, y1: number, g: { x0: number; x1: number }, minCoverage: number, debug?: (info: unknown) => void): boolean {
  const colInk = new Int32Array(cols);
  for (let y = y0; y < y1; y++) for (let x = 0; x < cols; x++) colInk[x] += ink[y * cols + x];
  const tolerance = Math.max(1, Math.floor((y1 - y0) * 0.003));
  const left = colInk.slice(0, g.x0).filter((v) => v > tolerance).length;
  const right = colInk.slice(g.x1).filter((v) => v > tolerance).length;
  const covL = rowCoverage(ink, cols, y0, y1, 0, g.x0), covR = rowCoverage(ink, cols, y0, y1, g.x1, cols);
  const runsL = lineRuns(ink, cols, y0, y1, 0, g.x0), runsR = lineRuns(ink, cols, y0, y1, g.x1, cols);
  debug?.({ group: [y0, y1], gutter: g, left, right, covL, covR, runsL, runsR });
  return left >= cols * 0.08 && right >= cols * 0.15 && runsL >= 3 && runsR >= 3 && covL >= minCoverage && covR >= minCoverage && (y1 - y0) >= 20;
}

/** Fraction des lignes de la bande contenant de l'encre dans l'intervalle de colonnes [xa, xb). */
function rowCoverage(ink: Uint8Array, cols: number, y0: number, y1: number, xa: number, xb: number): number {
  let covered = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = xa; x < xb; x++) if (ink[y * cols + x]) { covered++; break; }
  }
  return covered / Math.max(1, y1 - y0);
}

/** Nombre de groupes de lignes encrées (≈ lignes de texte) dans l'intervalle de colonnes [xa, xb). */
function lineRuns(ink: Uint8Array, cols: number, y0: number, y1: number, xa: number, xb: number): number {
  let runs = 0, inRun = false;
  for (let y = y0; y < y1; y++) {
    let has = false;
    for (let x = xa; x < xb; x++) if (ink[y * cols + x]) { has = true; break; }
    if (has && !inRun) runs++;
    inRun = has;
  }
  return runs;
}

export function cropCanvas(src: Canvas, r: Region): Canvas {
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(r.w, r.h) : Object.assign(document.createElement('canvas'), { width: r.w, height: r.h });
  const ctx = c.getContext('2d') as CanvasRenderingContext2D;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, r.w, r.h);
  ctx.drawImage(src as CanvasImageSource, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
  return c;
}

/** OCR d'une page par régions de lecture ; renvoie une page OCR par région, dans l'ordre. */
export async function recognizeWithLayout(ocr: OcrEngine, canvas: Canvas): Promise<OcrPage[]> {
  const regions = segmentRegions(canvas);
  const out: OcrPage[] = [];
  for (const r of regions) {
    const sub = regions.length === 1 ? canvas : cropCanvas(canvas, r);
    const page = await ocr.recognize(sub as HTMLCanvasElement);
    out.push(cleanOcrPage(page));
  }
  return out;
}

/** Retire les lignes sans contenu lisible (artefacts de barres, icônes) : peu de confiance et pas de mot. */
export function cleanOcrPage(page: OcrPage): OcrPage {
  const keep = (text: string, conf: number) => {
    const t = text.trim();
    if (!t) return false;
    const letters = (t.match(/[\p{L}\p{N}]/gu) ?? []).length;
    if (letters === 0) return false;
    if (conf < 55 && letters <= 5) return false;
    if (conf < 85 && letters <= 2 && !/\d/.test(t)) return false;
    if (letters / t.length < 0.3 && t.length <= 6) return false;
    return true;
  };
  return {
    ...page,
    blocks: page.blocks
      .map((b) => ({ paragraphs: b.paragraphs.map((p) => ({ lines: p.lines.filter((l) => keep(l.text, l.confidence)) })).filter((p) => p.lines.length) }))
      .filter((b) => b.paragraphs.length),
  };
}
