<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import JobTable from './components/JobTable.vue';
import ResultCard from './components/ResultCard.vue';
import PreviewPanel from './components/PreviewPanel.vue';
import { CONVERTERS } from './converters/registry';
import { ACCEPTED_EXTENSIONS, extensionOf } from './detect/detect';
import { slugify } from './converters/base';
import { TesseractEngine, type OcrEngine } from './ocr/engine';
import { runQueue } from './pipeline/run';
import { DEFAULT_OPTIONS, type Job, type JobOutput, type PipelineOptions } from './pipeline/types';
import { downloadBytes, zipBatch } from './export/zip';

type Phase = 'select' | 'processing' | 'done';

const phase = ref<Phase>('select');
const options = reactive<PipelineOptions>(JSON.parse(JSON.stringify(DEFAULT_OPTIONS)));
const selected = ref<{ file: File; rejected: string | null }[]>([]);
const jobs = ref<Job[]>([]);
const dragActive = ref(false);
const toast = ref('');
const preview = ref<{ job: Job; output: JobOutput } | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const categoriesText = ref('');
let ocrEngine: OcrEngine | null = null;

const availableFormats = CONVERTERS;
const OCR_LANGS = [
  { id: 'eng', label: 'Anglais' },
  { id: 'fra', label: 'Français' },
  { id: 'deu', label: 'Allemand' },
  { id: 'ltz', label: 'Luxembourgeois' },
];
const canConvert = computed(() => selected.value.some((s) => !s.rejected) && options.formats.length > 0);
const doneCount = computed(() => jobs.value.filter((j) => j.status === 'done').length);
const errorCount = computed(() => jobs.value.filter((j) => j.status === 'error').length);
const finishedJobs = computed(() => jobs.value.filter((j) => j.status === 'done'));

function showToast(msg: string) {
  toast.value = msg;
  setTimeout(() => (toast.value = ''), 2500);
}

function addFiles(list: FileList | File[]) {
  for (const f of Array.from(list)) {
    if (selected.value.some((s) => s.file.name === f.name && s.file.size === f.size)) continue;
    let rejected: string | null = null;
    const ext = extensionOf(f.name);
    if (!ACCEPTED_EXTENSIONS.includes(ext)) rejected = ext === 'doc' ? 'format DOC non pris en charge : enregistrez en DOCX' : 'extension non acceptée';
    else if (f.size > options.maxFileBytes) rejected = `trop volumineux (max ${Math.round(options.maxFileBytes / 1024 / 1024)} Mo)`;
    selected.value.push({ file: f, rejected });
  }
}
function onDrop(e: DragEvent) {
  dragActive.value = false;
  if (e.dataTransfer?.files) addFiles(e.dataTransfer.files);
}
function onPick(e: Event) {
  const input = e.target as HTMLInputElement;
  if (input.files) addFiles(input.files);
  input.value = '';
}
function remove(i: number) {
  selected.value.splice(i, 1);
}

function imagePrefixFor(_job: Job): string {
  return '';
}

// Accès de test : expose les résultats (texte uniquement) quand l'URL se termine par #e2e.
if (typeof window !== 'undefined' && window.location.hash === '#e2e') {
  (window as unknown as { __wcDump: () => unknown }).__wcDump = () =>
    jobs.value.map((j) => ({
      name: j.file.name,
      kind: j.kind,
      status: j.status,
      error: j.errorMessage ?? null,
      warnings: j.doc?.metadata.warnings.map((w) => w.message) ?? [],
      images: j.doc?.images.map((im) => ({ name: im.filename, mime: im.mime, bytes: im.data.length })) ?? [],
      outputs: Object.fromEntries(j.outputs.map((o) => [o.formatId, o.result.main])),
      previews: Object.fromEntries(j.outputs.map((o) => [o.formatId, o.result.previewHtml])),
    }));
}

async function convert() {
  options.mediawiki.categories = categoriesText.value.split(',').map((s) => s.trim()).filter(Boolean);
  if (!options.langs.length) options.langs = ['eng'];
  const slugs = new Map<string, number>();
  jobs.value = selected.value
    .filter((s) => !s.rejected)
    .map((s, i) => {
      let slug = slugify(s.file.name);
      const n = (slugs.get(slug) ?? 0) + 1;
      slugs.set(slug, n);
      if (n > 1) slug = `${slug}-${n}`;
      return { id: `job-${Date.now()}-${i}`, file: s.file, slug, kind: 'unknown', status: 'pending', detail: '', ocrUsed: null, outputs: [] } as Job;
    });
  phase.value = 'processing';
  if (options.ocrEnabled && !ocrEngine) ocrEngine = new TesseractEngine({ langs: options.langs, workers: options.ocrWorkers });
  const snapshot: PipelineOptions = JSON.parse(JSON.stringify(options));
  await runQueue(jobs.value, snapshot, options.ocrEnabled ? ocrEngine : null, { onStatus: () => { /* réactivité Vue */ } });
  phase.value = 'done';
}

async function restart() {
  selected.value = [];
  jobs.value = [];
  phase.value = 'select';
}

function downloadAll() {
  downloadBytes(zipBatch(jobs.value, imagePrefixFor), 'export.zip');
}

async function changeLangs() {
  // Un changement de langues recrée le moteur OCR au prochain lot.
  if (ocrEngine) {
    await ocrEngine.terminate();
    ocrEngine = null;
  }
}
</script>

<template>
  <h1>Wiki Converter</h1>
  <p class="lead">Convertit vos documents (PDF, Word, PowerPoint, Excel, LibreOffice, HTML, Markdown, texte, images) en pages prêtes à coller dans MediaWiki ou Confluence. Tout est traité dans votre navigateur : aucun document n’est envoyé à un serveur.</p>

  <template v-if="phase === 'select'">
    <div
      class="dropzone"
      :class="{ active: dragActive }"
      @dragover.prevent="dragActive = true"
      @dragleave="dragActive = false"
      @drop.prevent="onDrop"
      @click="fileInput?.click()"
    >
      <div class="big">Déposez vos documents ici</div>
      <div class="hint">PDF, Word (DOCX), PowerPoint (PPTX), Excel (XLSX), LibreOffice (ODT), HTML, Markdown, texte, CSV, images (PNG, JPG, WEBP, TIFF) — {{ Math.round(options.maxFileBytes / 1024 / 1024) }} Mo max par fichier</div>
      <button type="button" @click.stop="fileInput?.click()">Sélectionner des fichiers</button>
      <input ref="fileInput" type="file" multiple hidden :accept="ACCEPTED_EXTENSIONS.map((e) => '.' + e).join(',')" @change="onPick" data-testid="file-input" />
    </div>

    <ul v-if="selected.length" class="filelist card">
      <li v-for="(s, i) in selected" :key="s.file.name + s.file.size" :class="{ rejected: s.rejected }">
        <span>{{ s.rejected ? '✗' : '☑' }}</span>
        <span>{{ s.file.name }}</span>
        <span class="muted">{{ (s.file.size / 1024).toFixed(0) }} Ko</span>
        <span v-if="s.rejected" class="err">— {{ s.rejected }}</span>
        <span class="spacer"></span>
        <button class="small" @click="remove(i)" aria-label="Retirer">✕</button>
      </li>
    </ul>

    <div class="card">
      <h2 style="margin-top: 0">Formats de sortie</h2>
      <div class="formats">
        <label v-for="c in availableFormats" :key="c.id" :class="{ disabled: !c.available }" :title="c.description">
          <input type="checkbox" :value="c.id" v-model="options.formats" :disabled="!c.available" />
          {{ c.label }}<span v-if="!c.available" class="muted"> (V2)</span>
        </label>
      </div>
      <details class="options">
        <summary>Options avancées</summary>
        <div class="options-grid">
          <label class="inline"><input type="checkbox" v-model="options.ocrEnabled" /> OCR des images et pages scannées</label>
          <div class="lang-group">
            <span>Langues OCR</span>
            <label class="inline" v-for="l in OCR_LANGS" :key="l.id"><input type="checkbox" :value="l.id" v-model="options.langs" @change="changeLangs" /> {{ l.label }}</label>
            <span class="muted">Moins de langues = OCR plus rapide.</span>
          </div>
          <label>Documents traités en parallèle <input type="number" min="1" max="8" v-model.number="options.concurrency" /></label>
          <label>Threads OCR <input type="number" min="1" max="4" v-model.number="options.ocrWorkers" /></label>
          <label>Pages max par PDF <input type="number" min="1" max="2000" v-model.number="options.maxPages" /></label>
          <label class="inline"><input type="checkbox" v-model="options.keepRepeatedImages" /> Conserver les images répétées sur chaque page (logos d’en-tête)</label>
          <label>MediaWiki : espace de noms des fichiers
            <select v-model="options.mediawiki.fileNamespace"><option value="File">File:</option><option value="Fichier">Fichier:</option><option value="Datei">Datei:</option></select>
          </label>
          <label class="inline"><input type="checkbox" v-model="options.mediawiki.syntaxHighlight" /> MediaWiki : utiliser &lt;syntaxhighlight&gt;</label>
          <label>MediaWiki : avertissements
            <select v-model="options.mediawiki.admonitionStyle"><option value="div">bloc &lt;div&gt; (portable)</option><option value="template">modèles du wiki (Warning, Note, Tip…)</option></select>
          </label>
          <label>MediaWiki : catégories (séparées par des virgules) <input type="text" v-model="categoriesText" placeholder="Procédures, Réseau" /></label>
          <label class="inline"><input type="checkbox" v-model="options.confluence.toc" /> Confluence : macro table des matières</label>
        </div>
      </details>
    </div>

    <div class="row">
      <span class="muted">{{ selected.filter((s) => !s.rejected).length }} fichier(s) prêt(s)</span>
      <span class="spacer"></span>
      <button class="primary" :disabled="!canConvert" @click="convert" data-testid="convert">Convertir</button>
    </div>
    <p class="privacy">Confidentialité : la conversion et l’OCR s’exécutent localement dans cette page (WebAssembly). La page n’effectue aucune requête réseau avec vos documents ; vous pouvez couper la connexion après le chargement.</p>
  </template>

  <template v-else>
    <div class="card">
      <JobTable :jobs="jobs" :formats="options.formats" />
      <div class="row" style="margin-top: 12px">
        <span class="muted" data-testid="progress">{{ doneCount }} / {{ jobs.length }} terminé(s)<span v-if="errorCount"> · {{ errorCount }} en erreur</span></span>
        <span class="spacer"></span>
        <button :disabled="!finishedJobs.length" @click="downloadAll">Tout télécharger (ZIP)</button>
        <button :disabled="phase !== 'done'" @click="restart">Nouveau lot</button>
      </div>
    </div>

    <div v-if="finishedJobs.length" class="card">
      <h2 style="margin-top: 0">Résultats</h2>
      <ResultCard v-for="j in finishedJobs" :key="j.id" :job="j" :image-prefix="imagePrefixFor(j)" @preview="(o) => (preview = { job: j, output: o })" @toast="showToast" />
    </div>
  </template>

  <footer class="site-footer">
    <span>Wiki Converter est open source (licence MIT).</span>
    <a href="https://github.com/john572b/Wiki" rel="noopener">github.com/john572b/Wiki</a>
    <span>Une entreprise peut le cloner et l’héberger sur son propre serveur : c’est un site statique, sans backend ni base de données.</span>
  </footer>

  <PreviewPanel v-if="preview" :job="preview.job" :output="preview.output" :image-prefix="imagePrefixFor(preview.job)" @close="preview = null" @toast="showToast" />
  <div v-if="toast" class="toast" role="status">{{ toast }}</div>
</template>
