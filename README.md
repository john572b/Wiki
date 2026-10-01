# Wiki Converter — wiki.boi.lu

Convertisseur **local** de documents (PDF, DOCX, images) vers des formats de wiki (MediaWiki, Confluence).

- **Aucun document ne quitte le navigateur** : extraction, OCR (Tesseract en WebAssembly) et conversion s'exécutent dans la page. Le site est un simple ensemble de fichiers statiques hébergé sur Cloudflare Workers ; il n'a aucun backend et ne reçoit jamais vos fichiers.
- **Aucune IA** : parsing, règles déterministes, templates.
- **1 fichier = 1 résultat** : chaque document est traité indépendamment et produit ses propres exports (jamais de fusion).

## Utilisation

1. Déposez vos documents (ou cliquez sur « Sélectionner des fichiers »).
2. Cochez les formats de sortie (MediaWiki, Confluence).
3. Cliquez sur **Convertir**.
4. Pour chaque document : **Prévisualiser**, **Copier** (presse-papiers) ou télécharger le ZIP (texte + `images/`).
5. Téléversez les images listées dans votre wiki avec les noms indiqués (l'application ne peut pas le faire à votre place : elle n'a aucun accès réseau).

Le bouton **Copier** de Confluence place du HTML riche dans le presse-papiers (collage direct dans l'éditeur Cloud ou Server). Le fichier `confluence.html` est au *Storage Format* (API REST, éditeur de source).

## Développement

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # tests unitaires (vitest)
npm run build      # dist/
npm run test:e2e   # tests Playwright (Chromium) : DOCX, PDF texte, PDF scanné/mixte avec OCR, lot parallèle, isolation réseau
```

Les tests de bout en bout génèrent eux-mêmes leur corpus (aucun document réel dans le dépôt) et vérifient qu'aucune requête réseau ne sort de l'origine pendant la conversion, OCR compris.

## Déploiement sur Cloudflare

Deux possibilités :

**A. Depuis une machine (ou cette session) avec un jeton API**

```bash
export CLOUDFLARE_API_TOKEN=...   # jeton « Modifier Cloudflare Workers »
export CLOUDFLARE_ACCOUNT_ID=...
npm run deploy                    # build + wrangler deploy
```

**B. Workers Builds (déploiement automatique à chaque push)**

Dans le tableau de bord Cloudflare : *Workers & Pages → Créer → Importer un dépôt* → choisir `john572b/Wiki`, commande de build `npm run build`, commande de déploiement `npx wrangler deploy`, branche de production `master`.

Le fichier `wrangler.jsonc` publie le dossier `dist/` comme site statique et rattache le domaine `wiki.boi.lu` (la zone `boi.lu` doit être sur le même compte Cloudflare). Les en-têtes de sécurité (CSP `connect-src 'self'`, etc.) sont dans `public/_headers`.

## Structure

```text
src/
├── model/        DocumentModel neutre + normalisation
├── detect/       détection du type (octets magiques + extension)
├── parsers/      pdf.ts (pdf.js), docx.ts (OOXML), image.ts
├── ocr/          moteur Tesseract WASM auto-hébergé + règles de structure
├── converters/   base.ts, registry.ts, mediawiki/, confluence/  (ajouter un format = un dossier + une ligne)
├── preview/      aperçus HTML spécifiques à chaque format
├── pipeline/     file d'attente, exécution d'un job, statuts
├── export/       ZIP par document / par lot
└── components/   interface Vue
public/
├── tesseract/    worker + cœur WebAssembly + modèles de langues (fra, eng, deu) — aucun CDN
└── pdfjs/        polices standard et CMaps de pdf.js
```

Voir `docs/architecture.md` pour l'architecture détaillée et les choix techniques.
