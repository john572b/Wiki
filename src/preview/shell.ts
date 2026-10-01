/** Enveloppe HTML autonome pour l'aperçu (aucun script, aucune ressource externe). */
export function previewShell(title: string, css: string, body: string): string {
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src blob: data: 'self'; style-src 'unsafe-inline'">
<title>${escape(title)}</title>
<style>
html{font-family:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#202122;background:#fff}
body{margin:0;padding:16px 24px;line-height:1.5;font-size:14px}
img{max-width:100%;height:auto}
table{border-collapse:collapse;margin:1em 0}
pre{overflow:auto}
${css}
</style></head><body>${body}</body></html>`;
}

export function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
