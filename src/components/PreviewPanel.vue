<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { Job, JobOutput } from '../pipeline/types';
import { inlinePreviewImages } from '../preview/images';
import { getConverter } from '../converters/registry';
import { copyToClipboard } from '../util/clipboard';

const props = defineProps<{ job: Job; output: JobOutput; imagePrefix: string }>();
const emit = defineEmits<{ close: []; toast: [msg: string] }>();

const tab = ref<'preview' | 'source'>('preview');
const previewHtml = ref('');

function build() {
  if (!props.job.doc) return;
  previewHtml.value = inlinePreviewImages(props.output.result.previewHtml, props.job.doc, props.imagePrefix).html;
}
watch(() => props.output, build, { immediate: true });

const label = computed(() => getConverter(props.output.formatId).label);

async function copy() {
  const mode = await copyToClipboard(props.output.result.clipboard);
  emit('toast', mode === 'rich' ? 'Copié (HTML riche)' : 'Copié');
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close');
}
</script>

<template>
  <div class="preview-overlay" @click.self="emit('close')" @keydown="onKey" tabindex="-1">
    <div class="preview" role="dialog" aria-modal="true">
      <header>
        <strong>{{ job.file.name }}</strong>
        <span class="muted">→ {{ label }}</span>
        <span class="spacer"></span>
        <span class="tabs">
          <button :class="{ active: tab === 'preview' }" @click="tab = 'preview'">Aperçu</button>
          <button :class="{ active: tab === 'source' }" @click="tab = 'source'">Code source</button>
        </span>
        <button class="primary small" @click="copy">Copier</button>
        <button class="small" @click="emit('close')" aria-label="Fermer">✕</button>
      </header>
      <div class="body">
        <iframe v-if="tab === 'preview'" :srcdoc="previewHtml" sandbox="" title="Aperçu"></iframe>
        <textarea v-else readonly :value="output.result.main" spellcheck="false" @focus="($event.target as HTMLTextAreaElement).select()"></textarea>
      </div>
    </div>
  </div>
</template>
