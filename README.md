# Wiki Converter — wiki.boi.lu

Convertisseur **local** de documents (PDF, DOCX, images) vers des formats de wiki : MediaWiki, Confluence (Storage Format + HTML collable), Confluence wiki markup (Server/Data Center), DokuWiki, Markdown (GitHub/GitLab Wiki, Wiki.js…), BookStack.

- **Aucun document ne quitte le navigateur** : extraction, OCR (Tesseract en WebAssembly) et conversion s'exécutent dans la page. Le site est un simple ensemble de fichiers statiques hébergé sur Cloudflare Workers ; il n'a aucun backend et ne reçoit jamais vos fichiers.
- **Aucune IA** : parsing, règles déterministes, templates.
- **1 fichier = 1 résultat** : chaque document est traité indépendamment et produit ses propres exports (jamais de fusion).

## Utilisation

1. Déposez vos documents (ou cliquez sur « Sélectionner des fichiers »).
2. Cochez les formats de sortie (MediaWiki, Confluence, Confluence wiki markup, DokuWiki, Markdown, BookStack).
3. Cliquez sur **Convertir**.
4. Pour chaque document : **Prévisualiser**, **Copier** (presse-papiers) ou télécharger le ZIP (texte + `images/`).
5. Téléversez les images listées dans votre wiki avec les noms indiqués (l'application ne peut pas le faire à votre place : elle n'a aucun accès réseau).

Le bouton **Copier** de Confluence place du HTML riche dans le presse-papiers (collage direct dans l'éditeur Cloud ou Server). Le fichier `confluence.html` est au *Storage Format* (API REST, éditeur de source).

## Faire tourner l'application sur votre propre serveur

L'application est un site statique : aucun backend, aucune base de données, aucun appel sortant. Il suffit de construire le dossier `dist/` et de le servir avec n'importe quel serveur web (nginx, Apache, IIS, Caddy…) ou hébergeur statique.

```bash
git clone https://github.com/john572b/Wiki.git
cd Wiki
npm install
npm run build          # produit dist/
```

Copiez ensuite `dist/` sur votre serveur. Exemple avec nginx (les en-têtes de sécurité de `public/_headers` sont à reporter dans la configuration du serveur) :

```nginx
server {
    listen 443 ssl;
    server_name wiki.exemple.com;
    root /var/www/wiki-converter/dist;
    index index.html;
    add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; frame-src 'self' blob:; frame-ancestors 'none'" always;
    location / { try_files $uri $uri/ =404; }
}
```

Une fois la page chargée, elle fonctionne sans connexion Internet (OCR et modèles compris). HTTPS est nécessaire pour le bouton Copier (API presse-papiers du navigateur). Aucun compte Cloudflare n'est requis pour cet usage.

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
├── converters/   base.ts, registry.ts, mediawiki/, confluence/, confluence-wiki/, dokuwiki/, markdown/, bookstack/
│                 (ajouter un format = un dossier + une ligne dans registry.ts)
├── preview/      aperçus HTML spécifiques à chaque format
├── pipeline/     file d'attente, exécution d'un job, statuts
├── export/       ZIP par document / par lot
└── components/   interface Vue
public/
├── tesseract/    worker + cœur WebAssembly + modèles de langues (fra, eng, deu) — aucun CDN
└── pdfjs/        polices standard et CMaps de pdf.js
```

Voir `docs/architecture.md` pour l'architecture détaillée et les choix techniques.

## Licence

MIT. Voir le fichier `LICENSE`. Les composants embarqués ont leurs propres licences libres : Tesseract (Apache 2.0), tesseract.js (Apache 2.0), pdf.js (Apache 2.0), Vue (MIT), JSZip (MIT), fflate (MIT).
