# Wiki Converter — Architecture technique

> **Mise à jour du 1er octobre 2026 : hébergement Cloudflare.** L'hébergement cible n'est plus un serveur Docker mais **Cloudflare** (compte existant, où tourne déjà `cvtool`). Cette contrainte change l'architecture retenue, décrite dans le chapitre A ci-dessous, **qui prime sur les sections 1, 6, 7 et 8** du document d'origine (conservées pour mémoire : elles restent valables si un jour l'application doit tourner sur un serveur Docker). Les sections 3 à 5, 9 à 13 restent exactes dans leur principe ; les écarts d'implémentation sont listés en A.6.

---

## A. Architecture retenue : traitement 100 % dans le navigateur, site statique sur Cloudflare

### A.1 Pourquoi

Cloudflare ne fournit pas de serveur Docker classique. Trois options existaient :

| Option | Verdict |
|---|---|
| **Cloudflare Containers** (Workers + conteneur Docker Python/Tesseract) | Possible, mais : plan Workers Paid obligatoire, image à construire via Workers Builds, **les documents seraient traités sur l'infrastructure Cloudflare** (un cloud tiers, contraire à l'esprit de l'exigence 2), pas de réseau « sans sortie » comme avec Docker `internal: true`. |
| **Workers purs (JavaScript)** | Pas d'OCR possible (limites CPU/mémoire, pas de canvas), pas de rendu de pages PDF. |
| **Tout dans le navigateur, hébergement statique** ✅ | Les documents **ne quittent même pas le poste de l'utilisateur**. Aucun backend, aucun stockage, plan gratuit, rien à administrer. Le site est un ensemble de fichiers (HTML, JS, WebAssembly, modèles OCR) servi par Cloudflare. |

La troisième option est **plus stricte** que l'exigence initiale (« aucun document ne quitte le serveur ») : il n'y a plus de serveur du tout dans la boucle. C'est elle qui a été implémentée.

### A.2 Garanties de confidentialité, vérifiables

1. **Pas de backend** : `wrangler.jsonc` ne déclare que des *assets* statiques (`assets.directory = dist/`). Aucun code ne s'exécute côté Cloudflare, aucun point d'entrée ne peut recevoir un fichier.
2. **Content-Security-Policy `connect-src 'self'`** (dans `public/_headers` et en balise `<meta>`) : le navigateur lui-même interdit toute requête vers un autre domaine. Même un bug ou une dépendance malveillante ne peut pas exfiltrer un document.
3. **Tout est auto-hébergé** : Tesseract (worker + cœur WebAssembly + modèles `fra`, `eng`, `deu`) dans `public/tesseract/`, polices et CMaps de pdf.js dans `public/pdfjs/`. Aucun CDN. Une fois la page chargée, la connexion peut être coupée.
4. **Test automatisé** (`tests/e2e/convert.spec.ts`) : pendant la conversion d'une image avec OCR, Playwright enregistre toutes les requêtes et vérifie qu'aucune ne sort de l'origine.
5. **Pas de stockage** : résultats en mémoire de la page ; fermer l'onglet efface tout. La politique de rétention (section 7.2) devient sans objet.
6. **Pas d'IA** : aucun appel à Workers AI ni à un LLM (vérifié : CVtool, lui, utilise `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, ce qui est précisément ce que ce projet exclut).

### A.3 Stack implémenté

| Composant | Choix | Rôle |
|---|---|---|
| Interface | Vue 3 + Vite + TypeScript, page unique | dépôt, formats, tableau de statuts, résultats, aperçu, copier, ZIP |
| PDF | **pdf.js** (`pdfjs-dist` 5.x) | texte avec tailles/gras/police, images natives avec position (parcours de la liste d'opérateurs et des matrices de transformation), liens, rendu des pages scannées pour l'OCR |
| DOCX | **JSZip + DOMParser** (parcours OOXML maison) | titres (`outlineLvl`), listes (`numbering.xml`), tableaux avec fusions, images inline et ancrées, liens, code, révisions acceptées, légendes |
| Images | Canvas | ré-encodage (suppression EXIF), niveaux de gris + agrandissement ×2 avant OCR |
| OCR | **Tesseract 5 WebAssembly** (`tesseract.js` 7), modèles `tessdata_fast` | blocs → paragraphes → lignes avec boîtes ; titres par hauteur de ligne, listes par puces |
| Modèle | `DocumentModel` TypeScript (section 4, inchangé) | neutre, normalisation (fusion inlines, admonitions par mots-clés, nivellement des titres, nommage des images) |
| Convertisseurs | `converters/mediawiki`, `converters/confluence`, registre | interface `Converter` (section 5) ; `dokuwiki` et `bookstack` déclarés mais grisés (V2) |
| Aperçus | rendu du wikitext réel (sous-ensemble émis) et transformation du Storage Format | iframe `sandbox`, images en `data:` |
| Parallélisme | file d'attente en mémoire, N jobs simultanés (option), N threads OCR (option) | pdf.js et Tesseract ont chacun leurs *workers* |
| Export | `fflate` | ZIP par document et ZIP du lot (`<slug>/mediawiki.txt`, `confluence.html`, `confluence.paste.html`, `README.txt`, `images/`) |
| Presse-papiers | `ClipboardItem` `text/plain` + `text/html` | Confluence reçoit du HTML riche, MediaWiki du wikitext |
| Hébergement | Cloudflare Workers (*static assets*), route `wiki.boi.lu` | `wrangler.jsonc`, en-têtes dans `public/_headers` |

Polyfills : pdf.js 5.x utilise des API très récentes (`Map.prototype.getOrInsertComputed`, `Promise.try`, `Math.sumPrecise`, `Uint8Array.toBase64`). `src/polyfills.ts` les fournit, dans la page et dans le worker pdf.js, pour les navigateurs d'entreprise en retard d'une version.

### A.4 Pipeline d'un fichier (dans l'onglet)

```text
File (navigateur)
  ├─ analyse     : extension + octets magiques (incohérence → erreur MIME_MISMATCH), taille max
  ├─ extraction  : parsePdf | parseDocx | parseImage  → DocumentModel + images (Uint8Array)
  │     PDF : page sans texte + grande image → rendu canvas → Tesseract → blocs
  │           texte corrompu (polices sans Unicode) → idem
  │           en-têtes/pieds répétés supprimés, césures fusionnées, listes/titres par règles
  ├─ normalisation
  ├─ conversion  : pour chaque format coché → { main, extraFiles, clipboard, previewHtml, notes }
  └─ résultat en mémoire (Vue) : Prévisualiser / Copier / ZIP
```

Chaque job ne reçoit que son `File` et une copie des options ; les convertisseurs sont des fonctions pures. Le test « lot en parallèle » convertit quatre PDF portant des marqueurs distincts et vérifie qu'aucun marqueur ne fuit vers un autre résultat.

### A.5 Limites et sécurité côté navigateur

| Mesure | Implémentation |
|---|---|
| Taille par fichier | 50 Mo (option) |
| Pages PDF | 300 (option) |
| Bombe de décompression DOCX | taille décompressée totale et ratio vérifiés avant lecture ; chemins `..`/absolus refusés |
| Images | `MAX_IMAGE_PIXELS` 50 Mpx ; ré-encodage (EXIF/GPS supprimés) |
| PDF chiffré | refusé avec message clair |
| DOC (Word 97-2003) | refusé avec consigne « enregistrer en DOCX » (LibreOffice n'existe pas dans un navigateur) |
| CSP | `default-src 'self'`, `connect-src 'self'`, `script-src 'self' 'wasm-unsafe-eval'`, `frame-ancestors 'none'` |
| Aperçu | iframe `sandbox` sans script, CSP propre `default-src 'none'` |
| Journaux | aucun (pas de serveur) |

### A.6 Écarts par rapport au document d'origine

- **Pas de DOC** en V1 ni en V2 côté navigateur : impossible sans LibreOffice. Si ce besoin est fort, la seule voie est un service de conversion séparé (serveur), à décider à part.
- **Tableaux PDF** : non détectés (pdf.js n'a pas d'équivalent de `find_tables`) ; rendus en paragraphes. Les tableaux DOCX sont complets.
- **Schémas vectoriels PDF** : non extraits en V1.
- **OCR partagé avec CVtool** : sans objet, CVtool n'a pas d'OCR (section 3.5 devient caduque). Le module `src/ocr/` reste autonome et réutilisable.
- **Authentification** : la page ne manipulant aucun document côté serveur, l'accès public au site n'expose aucune donnée. Si l'on veut restreindre l'accès, Cloudflare Access (Zero Trust) se configure devant `wiki.boi.lu` sans modifier l'application.
- **Performance** : dépend du poste de l'utilisateur. Ordre de grandeur mesuré en test (Chromium, 1 cœur) : DOCX < 1 s, PDF texte de 2 pages < 1 s, OCR d'une page A4 à 300 dpi ≈ 2 à 4 s.

### A.7 Déploiement

Voir `README.md`. Deux chemins : `npm run deploy` avec un jeton API (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`), ou connexion du dépôt GitHub à Workers Builds (build `npm run build`, déploiement `npx wrangler deploy`).

---

# Document d'origine (architecture serveur Docker, conservée pour mémoire)


Hébergement cible : **wiki.boi.lu**
Nature : convertisseur documentaire **100 % local**, déterministe, **sans IA**, **sans sortie réseau**.

Principe fondateur : **1 fichier source = 1 job = 1 répertoire isolé = N exports (un par format wiki coché)**. Jamais de fusion.

> Ce document est une proposition d'architecture, pas du code. Il est découpé selon les 11 points demandés, puis une section « Problèmes techniques identifiés » et une section « Questions ouvertes ».

---

## 0. Résumé des décisions

| Sujet | Décision | Pourquoi |
|---|---|---|
| Backend | **Python 3.12 + FastAPI** | Tout l'écosystème d'extraction documentaire sérieux est Python (PyMuPDF, python-docx, OCRmyPDF, Pillow). Node obligerait à tout appeler en sous-processus. |
| Frontend | **Vue 3 + Vite + TypeScript**, une seule page, CSS maison, aucune dépendance CDN | Simple, build statique, servi par nginx. Pas de framework UI lourd. |
| Queue / workers | **Redis + RQ** | Léger, timeouts par job natifs, nombre de workers = nombre de conteneurs/processus. Celery est surdimensionné ici. |
| PDF | **PyMuPDF (fitz)** | Texte avec polices/tailles/positions, images natives avec position, tableaux (`find_tables`), dessins vectoriels, rapide, sans dépendance externe. |
| DOCX | **python-docx + lxml** (parcours OOXML direct) | Contrôle total de l'ordre paragraphes/tableaux/images, listes via `numbering.xml`, titres via `outlineLvl` (indépendant de la langue de Word). |
| DOC (et ODT/RTF/PPTX) | **LibreOffice headless** dans un conteneur dédié (V2) | Conversion locale DOC → DOCX, puis pipeline DOCX. |
| OCR | **Tesseract 5 + OCRmyPDF** derrière une interface `OcrEngine` ; **RapidOCR** (ONNX) en moteur optionnel V2 pour les captures d'écran | Léger, mature, paquets Debian, hOCR = structure paragraphes/lignes, gestion native des PDF mixtes. Comparatif en §3. |
| Modèle intermédiaire | `DocumentModel` **Pydantic v2**, JSON, versionné, neutre | Aucune syntaxe wiki dedans. |
| Convertisseurs | Un package par cible, enregistré dans un **registre** ; interface `Converter` unique | Ajouter `converters/gitlab/` = un dossier + une ligne d'enregistrement. |
| Confluence | **Storage Format (XHTML)** comme sortie canonique **+ HTML « collable »** pour le presse-papiers ; **wiki markup** Server/DC en variante V2 | Voir matrice §5.3 : ce qui est réellement collable dépend du type de Confluence. |
| Aperçu | Généré côté serveur à la conversion, rendu dans une iframe `sandbox` ; MediaWiki via **Pandoc** (lecteur `mediawiki`), Confluence via transformation XSLT du storage format | Aperçu réellement spécifique au format, hors ligne. |
| Isolation réseau | Les conteneurs `worker` et `api` sont sur un réseau Docker **`internal: true`** (aucune route sortante) | La confidentialité est garantie par la topologie, pas par une promesse dans le code. Auditable avec `tcpdump`/`iptables`. |
| Stockage | Volume local `/data/jobs/<job_id>/`, nettoyage par un **janitor** planifié | Un répertoire par job, suppression TTL configurable. |

---

## 1. Architecture technique globale

### 1.1 Vue d'ensemble

```text
                 HTTPS (reverse proxy existant de l'hôte : TLS + auth)
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────────┐
│  web  (nginx)                                                         │
│  - sert le frontend statique (Vue)                                    │
│  - proxy /api/* → api:8000                                            │
│  - limites de taille d'upload, en-têtes de sécurité, CSP stricte      │
└───────────────┬──────────────────────────────────────────────────────┘
                │ réseau "internal" (internal: true → pas d'Internet)
                ▼
┌──────────────────────────┐        ┌──────────────────────────┐
│  api  (FastAPI/uvicorn)  │        │  redis                   │
│  - validation upload     │◄──────►│  - queue RQ              │
│  - crée 1 job / fichier  │        │  - état des jobs (hash)  │
│  - état, résultats, zip  │        │  - sans persistance      │
│  - aperçus, images       │        └────────────┬─────────────┘
└───────────┬──────────────┘                     │
            │                                    │
            │  volume /data (jobs)               │
            ▼                                    ▼
┌──────────────────────────────────────────────────────────────────────┐
│  worker ×N  (même image que api, commande `rq worker`)                │
│  pipeline par job : detect → parse → (ocr) → model → convert → export │
│  contient : PyMuPDF, python-docx, Tesseract + tessdata, OCRmyPDF,     │
│             Ghostscript, unpaper, Pandoc, Pillow                      │
└──────────────────────────────────────────────────────────────────────┘
            │
            ▼
┌──────────────────────────┐        ┌──────────────────────────┐
│  janitor (rq scheduler)  │        │  office (V2, LibreOffice │
│  purge work/ après 1 h   │        │  headless via unoserver) │
│  purge job après 24 h    │        │  DOC/ODT/RTF → DOCX      │
└──────────────────────────┘        └──────────────────────────┘
```

### 1.2 Cycle de vie d'une demande

```text
1. L'utilisateur dépose N fichiers + coche les formats.
2. POST /api/batches  (multipart)   ──►  api crée un "batch" (simple regroupement UI)
                                          et N "jobs" indépendants : /data/jobs/<job_id>/source/
                                          puis enqueue(job_id) × N
3. Les workers dépilent : chaque worker ne reçoit QUE job_id.
   Il ne lit que /data/jobs/<job_id>/ et n'écrit que dedans.
4. Le frontend interroge GET /api/batches/<batch_id> toutes les 1,5 s
   (SSE possible plus tard) et met à jour le tableau de statuts.
5. Résultats : GET /api/jobs/<job_id>/outputs/<format>  (texte brut, pour "Copier")
               GET /api/jobs/<job_id>/preview/<format>  (HTML d'aperçu, iframe sandbox)
               GET /api/jobs/<job_id>/download          (zip du job)
               GET /api/batches/<batch_id>/download     (zip de tous les jobs du batch)
6. Janitor : suppression automatique selon TTL.
```

Le « batch » n'existe que pour l'interface et pour le ZIP global. Il n'intervient jamais dans le traitement : il n'y a aucun code qui itère sur « les autres jobs du batch » pendant un pipeline.

### 1.3 Pipeline d'un job (dans le worker)

```text
job_id
  │
  ├─ 1. load        : lit meta.json, vérifie que source/ contient exactement 1 fichier
  ├─ 2. detect      : extension + magic bytes (libmagic) → kind ∈ {pdf, docx, doc, image, ...}
  ├─ 3. parse       : parser spécifique → DocumentModel + images extraites dans out/images/
  │       ├─ pdf    : PyMuPDF ; si pages sans texte → OCRmyPDF (--skip-text) puis PyMuPDF
  │       ├─ docx   : parcours OOXML
  │       ├─ image  : Pillow (prétraitement) → Tesseract hOCR → blocs
  │       └─ doc    : office → docx → parser docx (V2)
  ├─ 4. normalize   : post-traitements déterministes (titres, listes, en-têtes/pieds répétés,
  │                   césures, nommage images image-001.png…), validation du modèle
  ├─ 5. convert     : pour chaque format demandé → Converter.convert(model, options)
  │                   → out/<format>.<ext> + out/<format>.preview.html + presse-papiers
  ├─ 6. finalize    : meta.json (statut terminé, durées), suppression de work/ si configuré
  └─ erreurs        : statut "error" + code d'erreur (jamais le contenu du document)
```

Chaque étape publie son statut dans Redis (`job:<id>` hash : `status`, `stage`, `progress`, `error_code`). Les statuts UI demandés sont mappés directement : En attente, Analyse, Extraction, OCR, Conversion, Terminé, Erreur.

### 1.4 API (REST, JSON)

| Méthode | Route | Rôle |
|---|---|---|
| GET | `/api/health` | liveness/readiness (redis joignable, volume inscriptible, tesseract présent) |
| GET | `/api/formats` | liste des convertisseurs disponibles (id, libellé, extension, options) — alimente les cases à cocher |
| GET | `/api/limits` | limites (taille, nombre de fichiers, extensions) — le frontend les affiche |
| POST | `/api/batches` | multipart : `files[]`, `formats[]`, `options` → `{batch_id, jobs:[{job_id, filename, kind}]}` |
| GET | `/api/batches/{id}` | statut de chaque job |
| GET | `/api/jobs/{id}` | détail d'un job (statut, étape, formats produits, nb images, avertissements) |
| GET | `/api/jobs/{id}/outputs/{format}` | sortie brute (`text/plain` ou `application/xhtml+xml`) |
| GET | `/api/jobs/{id}/clipboard/{format}` | `{ "text/plain": "...", "text/html": "..." }` pour le bouton Copier |
| GET | `/api/jobs/{id}/preview/{format}` | HTML d'aperçu autonome |
| GET | `/api/jobs/{id}/images/{name}` | image extraite (nom validé par regex stricte) |
| GET | `/api/jobs/{id}/download` | zip du job |
| GET | `/api/batches/{id}/download` | zip structuré de tous les jobs |
| DELETE | `/api/jobs/{id}` / `/api/batches/{id}` | suppression immédiate |

Les identifiants sont des UUID v4 non devinables ; aucune énumération de jobs n'est exposée. L'authentification des utilisateurs est déléguée au reverse proxy de l'hôte (voir questions ouvertes).

### 1.5 Logs et monitoring

- Logs JSON sur stdout (docker logs) : `ts, level, job_id, stage, duration_ms, kind, pages, ocr_pages, error_code`. **Jamais** de texte extrait, de nom de fichier original, ni d'extrait d'erreur de parseur contenant du contenu (les exceptions sont mappées vers des codes : `PDF_ENCRYPTED`, `TOO_MANY_PAGES`, `ZIP_BOMB`, `OCR_TIMEOUT`, ...).
- `/api/metrics` Prometheus (prometheus-fastapi-instrumentator + rq-exporter) : jobs par statut, durée par étape, taille de la queue, workers actifs. Exposé uniquement sur le réseau interne.
- `rq-dashboard` optionnel, réseau interne uniquement.
- Audit réseau : un test d'intégration lance un job dans le conteneur worker avec `tcpdump` et vérifie zéro paquet sortant hors redis.

---

## 2. Choix du stack

### 2.1 Backend : Python 3.12 / FastAPI

Alternatives considérées :

| Option | Verdict |
|---|---|
| Node/TypeScript | Rejeté : pdf.js est orienté rendu, pas extraction structurée ; pas d'équivalent de PyMuPDF/python-docx ; OCR et LibreOffice seraient de toute façon des sous-processus. |
| Pandoc comme moteur central (AST Pandoc = modèle intermédiaire) | Rejeté comme cœur : pas de lecteur PDF, pas d'écrivain Confluence, pas de maîtrise du placement des images. **Conservé** comme outil d'aperçu MediaWiki (lecteur `mediawiki` → HTML) et comme oracle de test. |
| Django | Inutile : pas de base relationnelle, pas d'admin, pas d'utilisateurs. |

Bibliothèques : `fastapi`, `uvicorn`, `pydantic` v2, `rq`, `redis`, `pymupdf`, `python-docx`, `lxml`, `Pillow`, `python-magic`, `ocrmypdf`, `pytesseract` (ou `tesserocr`), `structlog`. Toutes installées dans l'image ; aucun téléchargement à l'exécution.

### 2.2 Frontend : Vue 3 + Vite + TypeScript

- Une page, trois états (dépôt → traitement → résultats), aucun routeur.
- Aucune police ni script externe : CSP `default-src 'self'`.
- `navigator.clipboard.write()` avec `ClipboardItem` (`text/plain` + `text/html`) : nécessite HTTPS et un geste utilisateur — satisfait sur wiki.boi.lu.
- Aperçu dans `<iframe sandbox srcdoc>` : le HTML d'aperçu ne peut exécuter aucun script ni charger de ressource externe.
- Alternative envisagée : HTMX + Jinja (zéro build). Rejetée parce que l'aperçu à onglets, le presse-papiers riche et la mise à jour du tableau sont plus propres en SPA. Reste possible si l'équipe préfère éviter Node au build.

### 2.3 Dépôt

```text
wiki/
├── docker-compose.yml
├── .env.example
├── docs/                      ← ce document, choix, procédures
├── backend/
│   ├── Dockerfile             ← image unique api + worker
│   ├── pyproject.toml
│   ├── app/
│   │   ├── api/               ← routes FastAPI
│   │   ├── core/              ← config, limites, sécurité, logging
│   │   ├── queue/             ← RQ : enqueue, tâche `process_job`, janitor
│   │   ├── storage/           ← JobStore : chemins, meta.json, verrous, purge
│   │   ├── model/             ← DocumentModel (pydantic) + normalisation
│   │   ├── detect/            ← type de fichier
│   │   ├── parsers/           ← pdf/, docx/, image/, doc/ (V2)
│   │   ├── ocr/               ← OcrEngine (interface), tesseract/, rapidocr/ (V2)
│   │   ├── converters/        ← base.py, registry.py, mediawiki/, confluence/, dokuwiki/ (V2), bookstack/ (V2)
│   │   ├── preview/           ← aperçu par format
│   │   └── export/            ← zip, nommage
│   └── tests/
│       ├── fixtures/generate.py  ← corpus synthétique reproductible
│       ├── golden/               ← sorties attendues par (fixture, format)
│       ├── unit/
│       └── integration/
├── frontend/                  ← Vue 3
└── deploy/
    ├── nginx.conf
    └── offline/               ← procédure `docker save` pour installation sans Internet
```

---

## 3. Technologies locales d'extraction et d'OCR

### 3.1 Extraction PDF : PyMuPDF

Ce que l'on exploite :

- `page.get_text("dict", sort=True)` : blocs (texte **et** image, dans l'ordre de lecture), lignes, spans avec police, taille, flags gras/italique, bbox. C'est la clé pour **interclasser texte et images dans le bon ordre**.
- `page.get_images()` + `doc.extract_image(xref)` : images natives (objets XObject) avec SMask recomposé, conversion CMYK → RGB. Filtre : surface < seuil (icônes, puces) ignorée, images répétées sur chaque page (logo d'en-tête) détectées par hash et ignorées.
- `page.find_tables()` : tableaux à lignes tracées. Sans lignes tracées, la détection est peu fiable → repli en paragraphes (voir risques).
- `page.get_drawings()` : regroupement des tracés vectoriels en clusters → un schéma vectoriel est rendu en PNG **sur sa zone seulement** (`get_pixmap(clip=bbox)`), pas la page entière. C'est ce qui répond à « ne pas transformer chaque page en image » tout en récupérant les schémas.
- `page.get_links()` : liens URI avec bbox → rattachés aux spans.
- Détection d'une page à OCR : nombre de caractères utiles < seuil ET une image couvre > 60 % de la page. Détection d'un texte caché corrompu (ToUnicode cassé) : taux de caractères de remplacement/non imprimables > seuil → page traitée comme scannée (`--force-ocr` sur cette page).

Heuristiques déterministes de structure (PDF n'a pas de sémantique) :

| Élément | Règle |
|---|---|
| Taille de corps | mode des tailles de police pondéré par nombre de caractères |
| Titres | spans dont la taille > corps × 1,15 ou gras sur ligne isolée ; niveaux attribués par rang décroissant des tailles distinctes (max 4 niveaux) ; numérotation « 1.2.3 » détectée et retirée du texte, utilisée pour le niveau si cohérente |
| Listes | regex sur le premier token (`•`, `-`, `–`, `▪`, `o`, `1.`, `1)`, `a)`, `i.`) + indentation (x0) pour l'imbrication |
| Code | police à chasse fixe (nom contient Mono, Courier, Consolas, Menlo…) sur ≥ 1 ligne → bloc de code ; sur un fragment → inline code |
| En-têtes/pieds | texte identique à ±2 px de la même position y sur ≥ 60 % des pages → supprimé ; numéros de page idem |
| Césures | ligne finissant par `-` suivie d'une minuscule → fusion |
| Paragraphes | lignes d'un même bloc fusionnées ; nouveau paragraphe si saut vertical > 1,5 × interligne |
| Colonnes | `sort=True` + regroupement par colonne quand deux blocs se chevauchent verticalement sans se chevaucher horizontalement |

### 3.2 Extraction DOCX : parcours OOXML

- Itération sur `document.element.body` pour garder l'**ordre réel** paragraphes / tableaux / images (l'API haut niveau de python-docx sépare `paragraphs` et `tables`).
- Titres : `w:outlineLvl` (paragraphe puis chaîne de styles). Indépendant de la localisation (« Titre 1 » / « Heading 1 » / « Überschrift 1 »). Repli : style dont l'id commence par `Heading`/`Titre`, puis heuristique taille+gras.
- Listes : `w:numPr` (`numId`, `ilvl`) → `numbering.xml` → `w:numFmt` (`bullet` / `decimal` / `lowerLetter`…) → liste ordonnée ou non, niveau d'imbrication.
- Tableaux : `w:gridSpan` (colspan), `w:vMerge` (rowspan), première ligne marquée `w:tblHeader` ou cellules toutes en gras → en-tête.
- Images : `w:drawing` inline et ancrées (`wp:anchor`) → `a:blip r:embed` → partie liée → blob + type ; EMF/WMF convertis en PNG (via LibreOffice en V2, sinon ignorés avec avertissement).
- Liens : `w:hyperlink r:id` → relation externe ; signets internes ignorés.
- Runs : gras, italique, souligné, barré, `w:rStyle` Code / police à chasse fixe → inline code ; paragraphes consécutifs en style Code → bloc de code.
- Révisions : `w:ins` conservé, `w:del` ignoré (= « accepter toutes les modifications »).
- En-têtes/pieds de page : ignorés par défaut (option pour les inclure en V2). Notes de bas de page : rendues en fin de document (V2).
- Alternative considérée : `mammoth` (DOCX → HTML sémantique). Bon pour prototyper, mais perte sur les fusions de cellules, et oblige à un second parseur HTML → modèle. Non retenu.

### 3.3 Images : Pillow + OCR

- Validation : `Image.MAX_IMAGE_PIXELS` strict (anti-bombe de décompression), re-encodage de l'image (strip métadonnées EXIF, dont GPS).
- Prétraitement déterministe : conversion en niveaux de gris, agrandissement ×2 (LANCZOS) si la largeur < 1 500 px (indispensable pour les captures d'écran), redressement léger via OCRmyPDF/`--deskew` lorsque l'image passe par le chemin PDF.
- Résultat : `Image` (l'original) **puis** le texte OCR structuré, ou l'inverse selon option (par défaut image puis texte, conformément à la spécification « image + texte »).
- Formats : PNG, JPG/JPEG, WEBP, et sans coût supplémentaire TIFF (multi-pages → traité comme scan multipage), BMP, GIF (première image).

### 3.4 Comparatif OCR

Critères : qualité sur **documents bureautiques imprimés et captures d'écran** (le cas réel ici), français/anglais/allemand, CPU seul, taille d'image Docker, fonctionnement hors ligne, support PDF, structure récupérée.

| Moteur | Qualité imprimé | Qualité captures / basse résolution | Langues | CPU/RAM | Image Docker | Hors ligne | PDF natif | Structure | Intégration |
|---|---|---|---|---|---|---|---|---|---|
| **Tesseract 5 (LSTM)** | Très bonne sur texte propre ; sensible au bruit/basse résolution (compensé par le prétraitement) | Correcte après agrandissement ×2 | 100+ via tessdata (`fra`, `eng`, `deu` ; `ltz` à vérifier) | Faible (~200–400 Mo RAM/page) | +~60 Mo (apt) + tessdata ~30 Mo/langue (`tessdata_best` plus lourd, plus précis) | Oui, modèles = fichiers | Via **OCRmyPDF** (mixte, rotation, deskew, couche texte) | **hOCR : blocs, paragraphes, lignes, mots, bbox, confiance** | Très simple (paquets Debian, pytesseract) |
| **OCRmyPDF** (sur Tesseract) | idem | idem | idem | Parallélise par page (`--jobs`) | +Ghostscript, unpaper, pngquant (~150 Mo) | Oui | **Oui, c'est son objet** : `--skip-text` (pages sans texte seulement), `--redo-ocr`, `--force-ocr`, `--rotate-pages`, `--deskew` | hOCR en sidecar | Simple |
| **PaddleOCR (PP-OCRv4/v5)** | Très bonne | **Meilleure** sur petites polices, texte d'écran, bruit | Modèle `latin` couvre fr/en/de | Moyen (paddlepaddle CPU ~500 Mo, ~1–2 Go RAM) | +~1 Go | Possible mais les modèles sont téléchargés au premier lancement → **doivent être pré-chargés au build** | Non (il faut rastériser) | Lignes + bbox seulement ; pas de paragraphes | Moyenne ; dépendance `paddlepaddle` parfois capricieuse sur certaines CPU (AVX) |
| **RapidOCR** (modèles Paddle portés en ONNX) | ≈ Paddle | ≈ Paddle | idem | **Faible** (onnxruntime, ~150 Mo) | +~200 Mo, modèles **embarqués dans le paquet pip** | Oui | Non | Lignes + bbox | Simple |
| EasyOCR | Bonne | Bonne | 80+ | Lourd (PyTorch) | +1,5–2 Go | Modèles téléchargés au premier usage | Non | Lignes | Simple |
| docTR / Surya | Très bonne | Très bonne | nombreuses | Lourd (PyTorch), GPU recommandé | +2 Go | Modèles à pré-charger | Non | Lignes/blocs | Moyenne |
| Apache Tika / autres | n/a (wrapper Tesseract) | | | | | | | | Pas d'intérêt ici |

**Décision.**

1. **MVP : Tesseract 5 + OCRmyPDF.** Raisons décisives : le seul à fournir **la structure en paragraphes** (hOCR) dont le `DocumentModel` a besoin ; gestion native des **PDF mixtes** ; empreinte minimale ; installation Debian reproductible, modèles = simples fichiers copiés dans l'image ; déterminisme total.
2. **V2 : RapidOCR** comme second moteur derrière la même interface, activable par configuration pour le cas « capture d'écran » si la qualité Tesseract s'avère insuffisante sur vos captures réelles. Les lignes RapidOCR seront regroupées en paragraphes par une règle géométrique (interligne, alignement x).
3. **Rejetés** : PaddleOCR natif (dépendance lourde et fragile, modèles à télécharger), EasyOCR/docTR/Surya (PyTorch, CPU lent, images énormes). Rien de GPU.

Langues OCR par défaut : `fra+eng+deu`, configurable par déploiement et par batch (option avancée).

### 3.5 Partage de l'OCR avec CVtool.boi.lu

Je n'ai pas pu lire le code de CVtool (aucun dépôt de ce nom accessible ; `luciole` refusé, `Zod` vide). L'architecture ci-dessous est donc indépendante du moteur réel de CVtool ; la décision finale dépend de deux informations (voir questions ouvertes) : **le langage/stack de CVtool** et **son moteur OCR actuel**.

Interface commune, quel que soit le mode de partage :

```python
class OcrEngine(Protocol):
    id: str                                  # "tesseract", "rapidocr"
    def ocr_image(self, image: Path, langs: list[str], *, timeout_s: int) -> OcrPage: ...
    def ocr_pdf(self, pdf: Path, langs: list[str], *, pages: list[int] | None, timeout_s: int) -> Path: ...  # PDF avec couche texte

@dataclass
class OcrPage:            # structure neutre, issue de hOCR
    width: int; height: int
    blocks: list[OcrBlock]           # block → paragraphs → lines → words (bbox, text, confidence)
    mean_confidence: float
```

Deux façons de la partager :

| Mode | Quand | Avantages | Inconvénients |
|---|---|---|---|
| **A. Bibliothèque partagée `boi-ocr`** (dépôt Git propre, installée par pip dans wiki et CVtool) | CVtool est en Python | Pas de service supplémentaire, pas de réseau, versionnage par tag, tests communs | Tesseract installé dans deux images (c'est juste `apt`, pas un problème) |
| **B. Service `ocr-service`** (conteneur HTTP sur réseau interne, même interface, réponse JSON `OcrPage` ou PDF) | CVtool n'est pas en Python, ou l'on veut un seul pool CPU OCR partagé entre les deux applications | Un seul déploiement du moteur et des modèles ; quota CPU commun | Un saut réseau interne, un service à superviser ; les documents transitent sur le réseau Docker interne (acceptable, jamais hors hôte) |

Recommandation : **construire A dès le MVP** (le code OCR de wiki vit dans `app/ocr/`, mais avec zéro dépendance vers le reste de l'application, pour pouvoir le sortir en paquet sans refactor), puis **sortir le paquet** vers CVtool quand on connaît son stack. B se construit par-dessus A en une journée si nécessaire.

### 3.6 DOC et autres formats bureautiques (V2)

`soffice --headless --convert-to docx` dans un conteneur `office` dédié (image Debian + `libreoffice-writer-nogui`, ~500 Mo), piloté par `unoserver` sur le réseau interne (évite le démarrage à froid de 3–5 s par fichier et isole les plantages). Échange par le volume `/data/jobs/<job_id>/work/`. Timeout strict, `pids_limit`, mémoire plafonnée. Ouvre gratuitement : DOC, ODT, RTF, PPTX (texte + images, pas la mise en page), XLSX (tableaux).

Pandoc n'est **pas** utilisé comme convertisseur d'entrée (perte des positions d'images sur DOCX comparé au parcours OOXML, et aucun lecteur PDF).

---

## 4. Architecture du `DocumentModel`

### 4.1 Principes

- Pydantic v2, sérialisé en `out/model.json` (utile pour le débogage, les tests et pour reconvertir sans re-parser).
- `schema_version` pour pouvoir faire évoluer le modèle sans casser les golden files.
- **Aucune** syntaxe cible, aucune notion de MediaWiki/Confluence. Un convertisseur ne reçoit que ce modèle et ses options.
- Arbre de **blocs** contenant des **inlines** ; les listes et cellules contiennent des blocs (imbrication réelle).
- Les images sont référencées par identifiant ; les binaires vivent dans `out/images/`.

### 4.2 Schéma

```text
Document
├── schema_version: "1"
├── metadata
│   ├── title: str | None            (DOCX : coreProps.title ou 1er titre ; PDF : metadata ou 1er titre ; sinon nom du fichier)
│   ├── source_filename: str         (nom original nettoyé, affichage uniquement)
│   ├── source_kind: "pdf" | "docx" | "doc" | "image" | ...
│   ├── page_count: int | None
│   ├── ocr: { used: bool, pages: [int], engine: str, langs: [str], mean_confidence: float | None }
│   ├── language: str | None         (déclarée par le document, jamais devinée par IA)
│   └── warnings: [ {code, message, location} ]   (ex. "TABLE_NOT_DETECTED page 3")
├── images: [ ImageAsset ]
│   └── ImageAsset { id: "img-001", filename: "image-001.png", mime, width, height, sha256, origin: {page, index} }
└── blocks: [ Block ]

Block (discriminé par "type") :
  Heading      { level: 1..6, inlines }
  Paragraph    { inlines }
  List         { ordered: bool, start: int | None, items: [ ListItem { blocks } ] }
  Table        { caption: inlines | None, rows: [ Row { cells: [ Cell { blocks, header: bool, colspan, rowspan } ] } ] }
  Image        { image_id, alt: str, caption: inlines | None }
  CodeBlock    { language: str | None, text }
  Admonition   { kind: "note" | "warning" | "tip" | "info", title: str | None, blocks }
  Quote        { blocks }
  HorizontalRule {}

Inline (discriminé par "type") :
  Text         { text, bold, italic, underline, strike, code }
  Link         { href, inlines }
  LineBreak    {}
```

Exemple :

```json
{
  "schema_version": "1",
  "metadata": { "title": "Procédure VPN", "source_filename": "procedure-01.pdf", "source_kind": "pdf",
                "page_count": 3, "ocr": { "used": true, "pages": [3], "engine": "tesseract", "langs": ["fra","eng"], "mean_confidence": 0.93 },
                "language": null, "warnings": [] },
  "images": [ { "id": "img-001", "filename": "image-001.png", "mime": "image/png", "width": 1180, "height": 640,
                "sha256": "…", "origin": { "page": 1, "index": 0 } } ],
  "blocks": [
    { "type": "heading", "level": 2, "inlines": [ { "type": "text", "text": "Configuration réseau" } ] },
    { "type": "paragraph", "inlines": [ { "type": "text", "text": "Cliquez sur " },
                                        { "type": "text", "text": "Configuration", "bold": true },
                                        { "type": "text", "text": "." } ] },
    { "type": "image", "image_id": "img-001", "alt": "Écran de configuration", "caption": null },
    { "type": "list", "ordered": true, "items": [
        { "blocks": [ { "type": "paragraph", "inlines": [ { "type": "text", "text": "Sélectionnez Réseau." } ] } ] } ] },
    { "type": "admonition", "kind": "warning", "title": null,
      "blocks": [ { "type": "paragraph", "inlines": [ { "type": "text", "text": "Ne pas redémarrer pendant la mise à jour." } ] } ] }
  ]
}
```

### 4.3 Normalisation (après le parseur, avant les convertisseurs)

Passes déterministes, communes à tous les parseurs :

1. Compactage des inlines adjacents de mêmes attributs ; suppression des espaces en double.
2. Suppression des paragraphes vides, des titres vides.
3. Promotion : si le document n'a pas de `metadata.title` et commence par un `Heading` de niveau 1 isolé → devient le titre, le bloc est retiré (chaque wiki a déjà un titre de page). Option désactivable.
4. Re-nivellement des titres : les niveaux sont rendus contigus (h1, h3 → h1, h2).
5. Admonitions par règle : paragraphe commençant par `Attention`, `Avertissement`, `Important`, `Note`, `Remarque`, `Astuce`, `Warning`, `Caution`, `Tip` suivi de ` :` ou `:` → `Admonition` du type correspondant. Styles Word nommés de même → idem. Liste de mots-clés configurable.
6. Nommage des images dans l'ordre du document : `image-001.png`, `image-002.jpg`… ; dédoublonnage par SHA-256 (même image deux fois → un seul fichier, deux références).
7. Validation : chaque `Image.image_id` existe ; chaque fichier image est référencé au moins une fois (sinon retiré).

---

## 5. Architecture des convertisseurs

### 5.1 Interface

```python
@dataclass
class ConversionResult:
    main: bytes | str               # contenu principal (ex. wikitext)
    main_filename: str              # "mediawiki.txt"
    extra_files: dict[str, bytes]   # ex. "confluence.paste.html"
    clipboard: dict[str, str]       # {"text/plain": ..., "text/html": ...}
    preview_html: str               # aperçu autonome (sans script, images via chemins relatifs)
    notes: list[str]                # instructions post-collage ("téléverser 3 images : …")

class Converter(ABC):
    id: str                 # "mediawiki"
    label: str              # "MediaWiki"
    extension: str          # "txt"
    options_schema: type[BaseModel]   # options exposées à l'UI (optionnel)

    @abstractmethod
    def convert(self, doc: Document, options: BaseModel) -> ConversionResult: ...
```

Registre explicite (`converters/registry.py`) : `REGISTRY = {c.id: c for c in [MediaWikiConverter(), ConfluenceConverter(), ...]}` ; `GET /api/formats` le reflète. Ajouter GitLab Wiki = créer `converters/gitlab/` (un `converter.py` + ses tests golden) et ajouter une ligne au registre. Rien d'autre ne change : ni l'API, ni le frontend (qui lit `/api/formats`), ni le pipeline.

Chaque convertisseur est une **fonction pure** du modèle : pas d'accès disque, pas d'accès réseau, pas d'état. C'est ce qui garantit mécaniquement l'isolation entre jobs et la testabilité.

Les convertisseurs partagent un petit utilitaire interne de parcours (visiteur de blocs/inlines) mais chacun possède ses propres règles d'échappement et sa propre grammaire.

### 5.2 MediaWiki (natif wikitext)

| Élément du modèle | Wikitext produit |
|---|---|
| Heading niveau n | `== … ==` pour n = 1 (le niveau `=` est réservé au titre de page), `=== … ===` pour n = 2, etc. |
| Paragraph | texte + ligne vide |
| Text bold / italic / code | `'''…'''`, `''…''`, `<code>…</code>` |
| List non ordonnée / ordonnée, imbriquée | `*`, `**`, `#`, `##`, `#*` ; un item multi-blocs est joint avec `<br />` ou rendu en paragraphes indentés (`:`) |
| Table | `{\| class="wikitable"` … `!` en-têtes, `\|-`, `\|` cellules ; `colspan="2" \|`, `rowspan="2" \|` ; cellules multi-blocs → `<br />` ; légende `\|+` |
| Image | `[[File:<prefix>image-001.png\|thumb\|<largeur>px\|<légende ou alt>]]` ; préfixe de namespace configurable (`File:`/`Fichier:`), **préfixe de nom configurable** (par défaut le slug du document, ex. `procedure-01-image-001.png`, parce que les noms de fichiers sont globaux sur un MediaWiki) |
| CodeBlock | `<syntaxhighlight lang="bash">…</syntaxhighlight>` si l'extension est disponible (option), sinon `<pre>` |
| Link | `[https://… libellé]` ; e-mails `mailto:` |
| Admonition | par défaut `<div class="wc-warning" style="…">` (fonctionne sur tout MediaWiki) ; option `template` → `{{Warning\|…}}` avec nom de modèle configurable |
| Quote | `<blockquote>` |
| HorizontalRule | `----` |
| LineBreak | `<br />` |
| Catégories | `[[Category:…]]` en fin de page si configurées |
| TOC | option `__TOC__` / `__NOTOC__` |

Échappement (point critique, couvert par des tests dédiés) : en début de ligne `*`, `#`, `:`, `;`, `=`, `{|`, `|`, `----`, espace (préformaté) ; en inline `''`, `[[`, `]]`, `{{`, `}}`, `~~~`, `__XXX__`, `<` → `&lt;`, `&` → `&amp;`, et l'URL nue (auto-liée) → encadrée par `<nowiki>`. Dans les cellules de tableau, `|` → `{{!}}` ou `&#124;`, `!` en début de cellule protégé.

Les images ne peuvent pas être téléversées par l'application (aucun accès réseau, aucun accès au wiki). Le ZIP contient `images/` et `notes` liste exactement les fichiers à téléverser avec le nom attendu par le wikitext (Special:Upload / UploadWizard / `importImages.php`).

### 5.3 Confluence : quels formats sont réellement utilisables ?

| Type de Confluence | Pour un **copier-coller** dans l'éditeur | Pour un **import** (API / éditeur de source) |
|---|---|---|
| **Cloud** (éditeur actuel) | **HTML riche** sur le presse-papiers (`text/html`) : titres, listes, tableaux, blocs de code, liens sont convertis en éléments natifs à la collée. Le wiki markup n'a plus de boîte « Insert markup » dans le nouvel éditeur ; le Markdown collé est partiellement reconnu. **Les images ne passent pas** par le presse-papiers : à insérer manuellement depuis `images/`. | **Storage Format** (XHTML `ac:`/`ri:`) via REST v1/v2 `body.storage` ; ADF JSON (v2) possible mais plus lourd à produire. |
| **Server / Data Center** | Deux options fiables : **HTML riche** collé (comme Cloud), ou **wiki markup** via *Insérer > Balisage* (`h1.`, `||en-tête||`, `{code}`, `{warning}`). | **Storage Format** via REST `body.storage`, ou directement dans l'**éditeur de source** (plugin Atlassian « Source Editor »). |

Conséquences d'architecture :

- Un seul package `converters/confluence/` produit **une représentation interne Confluence** puis **deux rendus** :
  1. `confluence.html` = **Storage Format** (sortie principale, fichier, utilisable par API et éditeur de source, les deux types de Confluence) ;
  2. `confluence.paste.html` = **HTML collable** (sans `ac:`, `<pre>` pour le code, `<img>` en marque-place avec le nom de fichier) → c'est ce que le bouton **Copier** met dans `text/html` ; `text/plain` reçoit le storage format.
- V2 : variante `confluence-wiki` (wiki markup) pour Server/DC, dans le même package, activée par option `variant`.
- Les deux rendus sont générés à partir du même modèle, et le convertisseur MediaWiki n'est jamais touché par une évolution Confluence.

Mapping Storage Format :

| Élément | Storage Format |
|---|---|
| Heading | `<h1>`…`<h6>` |
| Paragraph | `<p>` |
| Text | `<strong>`, `<em>`, `<u>`, `<s>`, `<code>` |
| List | `<ul>/<ol>` + `<li>` (imbrication native) |
| Table | `<table><tbody><tr><th>/<td colspan rowspan>` (Confluence exige `<tbody>`) |
| Image | `<ac:image ac:alt="…"><ri:attachment ri:filename="image-001.png"/></ac:image>` + `<p>` de légende ; l'utilisateur joint les fichiers de `images/` à la page (noms identiques) |
| CodeBlock | `<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">bash</ac:parameter><ac:plain-text-body><![CDATA[…]]></ac:plain-text-body></ac:structured-macro>` |
| Admonition | macros `info` / `note` / `warning` / `tip` avec `<ac:rich-text-body>` |
| Link | `<a href="…">` |
| Quote | `<blockquote>` |
| TOC | option macro `toc` en tête |

Contraintes : XML bien formé (entités numériques uniquement, `&nbsp;` toléré), `]]>` échappé dans les CDATA. Test : chaque sortie est re-parsée par lxml avec les espaces de noms `ac`/`ri` déclarés.

### 5.4 Aperçu par format

- **MediaWiki** : `pandoc -f mediawiki -t html5` (local, dans l'image worker) sur le wikitext réel, puis post-traitement : `[[File:…]]` déjà converti par Pandoc en `<img>` → réécrit vers `images/…` du job ; les `<div class="wc-warning">` et balises `<syntaxhighlight>` sont stylées par une feuille CSS imitant le thème Vector. Les éventuels modèles `{{…}}` (option) sont rendus en encadrés génériques puisque Pandoc ne les connaît pas.
- **Confluence** : transformation lxml/XSLT du storage format : `ac:image` → `<img>`, macro `code` → `<pre>`, macros panneau → `<div class="panel …">`, CSS imitant Confluence.
- L'aperçu est **calculé une fois** à la conversion, stocké dans `out/<format>.preview.html`, servi avec CSP stricte et affiché dans une `<iframe sandbox="">` (aucun script, aucune ressource externe). L'onglet **Code source** affiche exactement le contenu de `out/<format>.<ext>`.

### 5.5 V2 : DokuWiki, BookStack

- DokuWiki : syntaxe native (`====== Titre ======`, `  * item`, `^ en-tête ^`, `{{:image-001.png}}`, `<code bash>`), images dans le namespace de la page.
- BookStack : accepte du HTML (éditeur WYSIWYG, API `html`) et du Markdown ; produire HTML.
- GitLab/GitHub Wiki, Markdown générique : écrivain Markdown (CommonMark + tables GFM).

---

## 6. Architecture de traitement parallèle

```text
POST /api/batches ──► api : pour chaque fichier
                        ├── job_id = uuid4
                        ├── écrit /data/jobs/<job_id>/{meta.json, source/<fichier>}
                        └── queue.enqueue(process_job, job_id, job_timeout=JOB_TIMEOUT_S, result_ttl=…)

redis (queue "convert") ◄── rq worker ×N (N = WORKERS, 1 processus par conteneur, scalable par `--scale worker=N`)
                                 │
                                 └── process_job(job_id) : pipeline §1.3, publie l'état dans redis hash job:<id>
```

- **Nombre de workers** : variable `WORKERS` (compose `deploy.replicas` ou `--scale`). Règle de dimensionnement : `WORKERS × OCR_JOBS ≤ nb de cœurs − 1` où `OCR_JOBS` est le parallélisme interne d'OCRmyPDF (`--jobs`). Par défaut `WORKERS=2`, `OCR_JOBS=2` pour un hôte 4–6 cœurs. Mémoire : ~1 Go par worker en pointe (PDF 300 pages + OCR).
- **Priorité** : une seule queue en MVP (FIFO = ordre de dépôt). V2 : deux queues (`light` pour DOCX/texte, `heavy` pour OCR) pour que 50 scans ne bloquent pas un DOCX.
- **Timeouts** : par job (`JOB_TIMEOUT_S`, défaut 600 s), par étape OCR (`OCR_TIMEOUT_S`, défaut 300 s, `--tesseract-timeout` par page). Dépassement → statut `error`, code `TIMEOUT`, répertoire nettoyé.
- **Pas de retry automatique** sur erreur de parsing (déterministe : rejouer donne le même résultat) ; retry ×1 uniquement sur perte de worker (OOM kill, redémarrage), détecté par RQ.
- **Isolation** : la tâche ne reçoit qu'un `job_id` ; `JobStore.path(job_id)` valide l'UUID et refuse tout chemin hors `/data/jobs/<job_id>/` ; tous les fichiers temporaires sont créés via `tempfile` **dans** `work/` du job (jamais `/tmp` global) ; le `DocumentModel` est construit en mémoire dans le processus du job et jamais mis dans Redis (seul l'état y va).
- **Test d'isolation** (§10 et plan) : 20 jobs simultanés avec contenus distincts et marqueurs uniques → chaque sortie contient uniquement son marqueur ; images comparées par SHA-256 à leur source.
- Le frontend interroge l'état par **polling** (1,5 s, backoff jusqu'à 5 s) ; SSE (`/api/batches/{id}/events`) prévu en V2 si besoin.

---

## 7. Architecture de stockage temporaire

### 7.1 Disposition

```text
/data/jobs/<job_id>/
├── meta.json                 statut, horodatages, kind, formats demandés, options, codes d'erreur, avertissements
│                             (jamais de texte extrait)
├── source/
│   └── input.<ext>           nom neutre ; le nom original n'est que dans meta.json (affichage et nom de dossier du zip)
├── work/                     intermédiaires : pdf OCRisé, hOCR, rendus de zones, docx converti
└── out/
    ├── model.json
    ├── mediawiki.txt
    ├── mediawiki.preview.html
    ├── confluence.html             (storage format)
    ├── confluence.paste.html
    ├── confluence.preview.html
    └── images/
        ├── image-001.png
        └── image-002.jpg
```

Le batch n'est qu'un enregistrement Redis `batch:<id> → [job_id…]` (TTL = RESULT_TTL). Rien sur disque.

### 7.2 Rétention

| Paramètre | Défaut | Rôle |
|---|---|---|
| `TMP_TTL` | 1 h | suppression de `work/` et de `source/` après fin du job (ou immédiatement si `DELETE_SOURCE_ON_SUCCESS=true`) |
| `RESULT_TTL` | 24 h | suppression de tout le répertoire du job et des clés Redis |
| `RETENTION_DISABLED` | false | si true : suppression de tout dès que l'utilisateur a téléchargé ou quitté (TTL court, ex. 15 min) — mode « paranoïaque » |
| `MAX_DISK_MB` | 10 240 | au-delà, refus des nouveaux batches (erreur 507) et purge anticipée des plus anciens terminés |

Le **janitor** est une tâche RQ planifiée (`rq worker --with-scheduler`, toutes les 5 min) : parcourt `/data/jobs`, compare `meta.json.finished_at` aux TTL, supprime (`shutil.rmtree`, puis supprime les clés Redis). Suppression manuelle via `DELETE /api/jobs/{id}`. Au démarrage, les jobs orphelins (statut « en cours » sans worker) sont marqués en erreur `INTERRUPTED`.

### 7.3 Durcissement

- Volume `/data` : propriété de l'utilisateur non root du conteneur (uid 10001), `chmod 700`, monté `nosuid,nodev,noexec`. Option : `tmpfs` (RAM) pour que rien ne touche le disque, ou volume sur partition chiffrée de l'hôte.
- Système de fichiers racine des conteneurs en lecture seule (`read_only: true`), `tmpfs` pour `/tmp` du conteneur.
- Aucun contenu dans Redis (seulement états, identifiants, compteurs). Redis sans persistance (`--save "" --appendonly no`).

---

## 8. Architecture Docker

### 8.1 `docker-compose.yml` (esquisse)

```yaml
services:
  web:
    build: ./frontend            # nginx:alpine + dist Vue + nginx.conf
    networks: [edge, internal]
    ports: ["127.0.0.1:8080:80"] # le reverse proxy de l'hôte publie wiki.boi.lu en HTTPS
    read_only: true
    tmpfs: [/var/cache/nginx, /var/run]
    depends_on: [api]

  api:
    build: ./backend
    command: uvicorn app.main:app --host 0.0.0.0 --port 8000
    env_file: .env
    networks: [internal]
    volumes: [jobdata:/data]
    read_only: true
    tmpfs: [/tmp]
    user: "10001:10001"
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    mem_limit: 1g
    pids_limit: 256
    depends_on: [redis]
    healthcheck: { test: ["CMD", "python", "-m", "app.healthcheck"], interval: 30s }

  worker:
    build: ./backend
    command: rq worker --with-scheduler --url redis://redis:6379/0 convert
    env_file: .env
    networks: [internal]
    volumes: [jobdata:/data]
    read_only: true
    tmpfs: [/tmp]
    user: "10001:10001"
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    mem_limit: 2g
    cpus: 2
    pids_limit: 512
    deploy: { replicas: 2 }      # ou: docker compose up --scale worker=4
    depends_on: [redis]

  redis:
    image: redis:7-alpine
    command: redis-server --save "" --appendonly no --maxmemory 256mb
    networks: [internal]
    read_only: true
    user: "999:999"

  # V2
  # office:
  #   build: ./deploy/office     # debian + libreoffice-writer-nogui + unoserver
  #   networks: [internal]
  #   volumes: [jobdata:/data]

networks:
  edge: {}
  internal:
    internal: true               # ← AUCUNE route vers l'extérieur pour api, worker, redis, office

volumes:
  jobdata: {}                    # ou driver_opts tmpfs
```

Le réseau `internal: true` est la garantie structurelle de « aucun document ne sort » : même un bug, une dépendance malveillante ou une mauvaise configuration ne peuvent pas ouvrir une connexion sortante depuis les conteneurs de traitement. `web` est le seul conteneur relié au réseau `edge`, et il ne manipule aucun document (il proxifie les octets vers `api`).

### 8.2 Image backend (esquisse)

```dockerfile
FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
      tesseract-ocr tesseract-ocr-fra tesseract-ocr-eng tesseract-ocr-deu \
      ocrmypdf ghostscript unpaper pngquant qpdf pandoc libmagic1 \
    && rm -rf /var/lib/apt/lists/*
# option : tessdata_best (plus précis, plus lent) copié dans /usr/share/tesseract-ocr/5/tessdata
COPY requirements.lock .
RUN pip install --no-cache-dir -r requirements.lock      # versions épinglées + hashes
COPY app ./app
USER 10001
ENV TESSDATA_PREFIX=/usr/share/tesseract-ocr/5/tessdata OMP_THREAD_LIMIT=1
```

- Une seule image pour `api` et `worker` (même code, commande différente) : pas de dérive de version du modèle entre les deux.
- Build reproductible : versions épinglées (`pip-compile --generate-hashes`), image de base par digest.
- **Installation hors ligne** : `docker compose build` sur une machine connectée, `docker save` des images en tarball, `docker load` sur le serveur. Après `docker load`, le fonctionnement ne requiert aucun accès réseau (vérifié par le test d'audit).
- Mises à jour de sécurité (Ghostscript, Tesseract) = reconstruire l'image, jamais `apt` dans un conteneur en marche.

### 8.3 Configuration (`.env`)

| Variable | Défaut | Rôle |
|---|---|---|
| `WORKERS` | 2 | réplicas worker |
| `OCR_JOBS` | 2 | parallélisme interne OCRmyPDF |
| `OCR_LANGS` | `fra+eng+deu` | langues Tesseract par défaut |
| `OCR_ENGINE` | `tesseract` | moteur (V2 : `rapidocr`) |
| `MAX_FILE_MB` | 50 | taille par fichier |
| `MAX_BATCH_MB` | 500 | taille cumulée d'un batch |
| `MAX_FILES_PER_BATCH` | 50 | |
| `MAX_PAGES` | 300 | pages PDF |
| `MAX_IMAGE_PIXELS` | 50 000 000 | anti-bombe de décompression |
| `MAX_DOCX_UNCOMPRESSED_MB` | 500 | anti-zip bomb (ratio et total) |
| `JOB_TIMEOUT_S` / `OCR_TIMEOUT_S` | 600 / 300 | |
| `TMP_TTL` / `RESULT_TTL` | 1h / 24h | rétention |
| `MW_FILE_NAMESPACE` | `File` | `File` ou `Fichier` |
| `MW_IMAGE_PREFIX_MODE` | `slug` | `slug` / `none` / `custom:<texte>` |
| `MW_SYNTAXHIGHLIGHT` | true | `<syntaxhighlight>` vs `<pre>` |
| `MW_CATEGORIES` | vide | catégories ajoutées |
| `CONFLUENCE_VARIANT` | `storage` | `storage` (V2 : `wiki`) |
| `CLAMAV_ENABLED` | false | scan via clamd (conteneur interne, signatures fournies hors ligne) |

### 8.4 Sécurité des entrées (api)

1. Nombre, taille, extension autorisée (`.pdf .docx .png .jpg .jpeg .webp .tiff .bmp .gif` ; `.doc .odt .rtf .pptx .xlsx` en V2).
2. Magic bytes (libmagic) cohérents avec l'extension ; sinon rejet `MIME_MISMATCH`.
3. Nom original : conservé uniquement comme chaîne dans `meta.json` après nettoyage (Unicode NFC, longueur ≤ 120, pas de `/`, `\`, `..`, caractères de contrôle). Le fichier sur disque s'appelle `input.<ext>`. Le nom de dossier dans le zip est un **slug** dérivé (`procedure-01`), dédoublonné dans le batch (`procedure-01-2`).
4. Upload en streaming vers le disque avec compteur de taille (pas de chargement en mémoire).
5. DOCX : avant ouverture, inspection de la table du zip : rejet si un membre contient `..` ou un chemin absolu, si taille décompressée totale > seuil ou ratio > 100.
6. PDF : refus si chiffré avec mot de passe ; pas d'exécution de JavaScript (PyMuPDF n'en exécute pas) ; `MAX_PAGES`.
7. Images : `MAX_IMAGE_PIXELS`, re-encodage.
8. Pas d'extraction de fichiers joints embarqués (PDF attachments, OLE objects) en MVP.
9. ClamAV optionnel : `clamd` sur le réseau interne, signatures mises à jour hors ligne par import de fichiers `.cvd` (sinon l'option contredit « pas d'Internet »). Désactivé par défaut.
10. Rate limiting au niveau nginx (uploads par IP/minute).

---

## 9. Écrans UI

Une seule page, titre **Wiki Converter**. Trois états + un panneau d'aperçu.

### Écran 1 — Dépôt

```text
┌────────────────────────────────────────────────────────────────┐
│  Wiki Converter                                                 │
│  Conversion locale de documents vers vos wikis. Rien ne quitte  │
│  ce serveur.                                                    │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                                                          │   │
│  │            Déposez vos documents ici                     │   │
│  │        PDF, DOCX, PNG, JPG, WEBP — 50 Mo max/fichier     │   │
│  │                                                          │   │
│  │              [ Sélectionner des fichiers ]               │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  Formats de sortie                                              │
│  ☑ MediaWiki   ☑ Confluence   ☐ DokuWiki (V2)   ☐ BookStack (V2)│
│                                                                 │
│  ▸ Options avancées  (langues OCR, préfixe des images, …)       │
│                                                                 │
│  Fichiers sélectionnés (0)                            [Convertir]│
└────────────────────────────────────────────────────────────────┘
```

Après sélection, la liste apparaît sous la zone avec type détecté (par extension, côté client), taille, et un ✕ pour retirer. Les fichiers refusés (extension, taille) sont marqués en rouge avant tout envoi. `Convertir` s'active quand ≥ 1 fichier et ≥ 1 format.

### Écran 2 — Traitement

```text
│  Fichier              Type   OCR   MediaWiki   Confluence   Statut           │
│  procedure-01.pdf     PDF     ✓       ✓            ✓        ● Terminé        │
│  procedure-02.pdf     PDF     —       ✓            ✓        ● Terminé        │
│  installation.docx    DOCX    —       ◌            ◌        ◐ Conversion     │
│  capture-01.png       Image   ✓       ◌            ◌        ◐ OCR (page 1/1) │
│  procedure-05.pdf     PDF     ?       ◌            ◌        ○ En attente     │
│  ancien.doc           DOC     —       ✗            ✗        ✖ Erreur : format non pris en charge en V1 │
│                                                                              │
│  3 / 6 terminés                             [Tout télécharger]  [Nouveau lot] │
```

Statuts : En attente, Analyse, Extraction, OCR (avec page courante), Conversion, Terminé, Erreur (message humain, code technique au survol). Les lignes terminées deviennent cliquables (écran 3) sans attendre la fin des autres.

### Écran 3 — Résultats (par document, dépliable)

```text
│  ▾ procedure-01.pdf          PDF · 3 pages · OCR sur 1 page · 2 images       │
│      ✓ MediaWiki     [Prévisualiser] [Copier]                                │
│      ✓ Confluence    [Prévisualiser] [Copier]   (copie HTML riche pour l'éditeur) │
│      ⚠ 1 avertissement : tableau page 3 non détecté, rendu en paragraphes    │
│      Images à téléverser dans le wiki : procedure-01-image-001.png, …-002.jpg│
│      [Télécharger procedure-01.zip]                                          │
```

`Copier` affiche un toast « Copié » et, pour MediaWiki, rappelle le nombre d'images à téléverser.

### Écran 4 — Aperçu (panneau latéral ou modal plein écran)

```text
│  procedure-01.pdf → MediaWiki            [ Aperçu ] [ Code source ]   [Copier] [✕] │
│  ┌──────────────────────────────────────────────────────────────────────────┐ │
│  │ (iframe sandbox : rendu Vector-like du wikitext, images du job affichées) │ │
│  └──────────────────────────────────────────────────────────────────────────┘ │
```

Onglet Code source : `<textarea readonly>` monospace, contenu exact, sélection-tout au clic.

### Contenu du ZIP

```text
export.zip
├── procedure-01/
│   ├── mediawiki.txt
│   ├── confluence.html
│   ├── confluence.paste.html
│   ├── README.txt            ← quoi coller où, images à téléverser
│   └── images/
│       ├── procedure-01-image-001.png
│       └── procedure-01-image-002.jpg
├── procedure-02/
│   └── …
└── capture-01/
    ├── mediawiki.txt
    ├── confluence.html
    └── images/capture-01-image-001.png   (l'image source elle-même, re-encodée)
```

Un seul format demandé → le zip reste structuré de la même façon (prévisible). Téléchargement individuel : `procedure-01.zip` ; téléchargement direct d'un seul fichier texte possible (`procedure-01-mediawiki.txt`) via le menu du format.

---

## 10. Périmètre précis du MVP (V1)

### Inclus

| Domaine | V1 |
|---|---|
| Entrées | PDF (texte, scanné, mixte), DOCX, PNG, JPG/JPEG, WEBP (+ TIFF, BMP, GIF gratuitement via Pillow) |
| Détection | extension + magic bytes |
| PDF | texte, titres par heuristique, listes, tableaux à lignes tracées, images natives avec position, schémas vectoriels en PNG de zone, liens, blocs de code (chasse fixe), en-têtes/pieds répétés supprimés |
| DOCX | titres (`outlineLvl`), paragraphes et styles de caractères, listes imbriquées, tableaux avec fusions, images inline et ancrées (PNG/JPEG/GIF ; EMF/WMF ignorés avec avertissement), liens |
| OCR | Tesseract 5 + OCRmyPDF, `fra+eng+deu`, images et pages PDF sans texte, hOCR → paragraphes/lignes, titres par hauteur de ligne, listes par regex |
| Modèle | `DocumentModel` v1 complet (§4) + normalisation |
| Sorties | MediaWiki (wikitext natif), Confluence (storage format + HTML collable) |
| Admonitions | par mots-clés et styles |
| UI | dépôt multiple, formats, tableau de statuts en temps réel, prévisualisation Aperçu / Code source, Copier (presse-papiers), téléchargement par document, ZIP global, options avancées repliées |
| Traitement | queue Redis/RQ, workers configurables, timeouts, isolation par job |
| Sécurité | toutes les mesures §8.4 sauf ClamAV ; réseau interne sans sortie ; conteneurs non root, lecture seule |
| Rétention | TTL configurables, janitor, suppression manuelle |
| Observabilité | logs JSON sans contenu, `/api/health`, `/api/metrics` |
| Tests | corpus synthétique §11, golden files, test d'isolation, test de parallélisme, test d'audit réseau |

### Exclu (V2+)

- DOC/ODT/RTF/PPTX/XLSX via LibreOffice (`office`), EMF/WMF.
- DokuWiki, BookStack, GitLab Wiki/Markdown, variante Confluence wiki markup, ADF.
- Second moteur OCR (RapidOCR), détection de tableaux dans les scans, OCR des zones image à l'intérieur de pages scannées (en V1 une page scannée donne du texte, pas d'images extraites, sauf option « joindre le scan de page »).
- Tableaux PDF sans lignes tracées (V1 : paragraphes + avertissement).
- Notes de bas de page, en-têtes/pieds de page DOCX, commentaires.
- Queues de priorité, SSE, ClamAV, authentification intégrée (V1 : au reverse proxy).
- Envoi direct vers un wiki (API MediaWiki/Confluence). Même en V2 ce serait un module distinct et optionnel, désactivé par défaut, puisqu'il contredit « aucune sortie réseau » : à discuter séparément.

---

## 11. Plan de développement

Ordre choisi pour obtenir tôt des composants purs et testables, puis les parseurs les plus incertains (PDF) avec du temps pour itérer.

| Phase | Contenu | Livrable / critère de sortie | Durée indicative |
|---|---|---|---|
| **0. Socle** | dépôt, `pyproject`, Dockerfile, compose, nginx, CI (lint, mypy, pytest), FastAPI `/health`, RQ + worker « no-op », JobStore, limites d'upload, janitor | `docker compose up` fonctionne ; un fichier déposé crée un job qui passe « en attente → terminé » sans traitement | 3 j |
| **1. Modèle + convertisseurs** | `DocumentModel` v1, normalisation, `Converter`/registre, MediaWiki, Confluence (storage + paste + aperçus), générateur de modèles de test, golden files, règles d'échappement | 100 % des éléments du modèle couverts par des golden files ; storage format validé XML ; wikitext validé par Pandoc (parse sans erreur) | 5 j |
| **2. DOCX** | parcours OOXML, listes, tableaux, images, liens, anti-zip-bomb ; fixtures DOCX générées par python-docx | fixtures DOCX → modèle attendu (snapshot JSON) ; ordre texte/images vérifié | 4 j |
| **3. PDF texte** | PyMuPDF, heuristiques de structure, images natives, zones vectorielles, tableaux tracés, en-têtes/pieds, liens ; fixtures PDF générées (PyMuPDF/reportlab) | snapshots ; mesure de précision titres/listes sur le corpus ; pas de page entière rastérisée | 6 j |
| **4. OCR** | `OcrEngine` Tesseract, prétraitement images, OCRmyPDF pour PDF scannés/mixtes, parsing hOCR → blocs, détection pages à OCR, texte corrompu → OCR forcé ; fixtures scannées = rastérisation des fixtures texte | PDF scanné et mixte donnent un modèle ≈ celui du PDF texte (diff textuel < seuil) ; captures d'écran lisibles | 5 j |
| **5. Frontend** | Vue : dépôt, formats, tableau, résultats, aperçu, Copier (ClipboardItem), zips, options avancées, messages d'erreur ; tests Playwright | scénario « 10 fichiers → 2 formats → copier » en < 5 clics ; fonctionne sur Chrome/Firefox/Edge | 5 j |
| **6. Durcissement** | sécurité §8.4, read-only, non root, réseau `internal`, test d'audit réseau (tcpdump), test d'isolation ×20, test de charge 50 fichiers, rétention, métriques, procédure d'installation hors ligne | audit : zéro paquet sortant ; 50 fichiers avec `WORKERS=4` sans OOM ; purge vérifiée | 4 j |
| **7. Corpus réel et recette** | passage sur vos vrais documents (en local, chez vous), ajustement des heuristiques, seuils, langues ; documentation utilisateur ; déploiement wiki.boi.lu derrière le proxy existant | recette signée sur un lot représentatif | 3–5 j |
| **V2** | DOC via `office`, DokuWiki, BookStack, RapidOCR, Confluence wiki markup, queues de priorité, SSE, paquet `boi-ocr` partagé avec CVtool | | à planifier |

Total V1 : environ **7 semaines** pour une personne, réductibles si frontend et parseurs sont menés en parallèle (phases 2–4 et 5 sont indépendantes après la phase 1).

### Corpus de test (phase 1 → 4, enrichi ensuite)

Généré par `tests/fixtures/generate.py` (reproductible, aucun document confidentiel dans le dépôt) :

| Fixture | Génération | Vérifie |
|---|---|---|
| `text-simple.pdf` | PyMuPDF `insert_text` | paragraphes, titres par taille |
| `text-structure.pdf` | titres 3 niveaux, listes, code mono | niveaux, listes, code |
| `text-tables.pdf` | tableau tracé | `find_tables` |
| `text-images.pdf` | 3 images insérées entre paragraphes | extraction, ordre, nommage |
| `text-vector.pdf` | schéma en tracés | rendu de zone |
| `scanned.pdf` | rastérisation de `text-structure.pdf` à 200 dpi + léger bruit/rotation 1° | OCR complet, deskew |
| `mixed.pdf` | pages texte + pages rastérisées | `--skip-text`, fusion |
| `headers-footers.pdf` | en-tête/pied répétés 5 pages | suppression |
| `docx-headings.docx` | python-docx, styles Titre 1–3 (noms FR et EN) | `outlineLvl` |
| `docx-lists.docx` | listes à puces et numérotées imbriquées | numbering |
| `docx-tables.docx` | tableau avec fusions | colspan/rowspan |
| `docx-images.docx` | images inline + ancrée entre paragraphes | ordre |
| `docx-code-links.docx` | style Code, hyperliens | code, liens |
| `image-text.png` | Pillow, texte rendu 12–24 pt | OCR, titre par hauteur |
| `screenshot.png` | Pillow, fausse fenêtre avec menus, petite police 10 px | prétraitement ×2 |
| `isolation-*.pdf/docx` ×20 | marqueurs uniques | aucune fuite inter-jobs |
| `escaping.model.json` | modèle direct contenant tous les caractères pièges | échappement MediaWiki/Confluence |

Plus un dossier `tests/corpus-private/` ignoré par Git pour vos documents réels.

---

## 12. Problèmes techniques identifiés (à valider avant de coder)

1. **Structure PDF = heuristique.** Un PDF n'a pas de titres, listes ni tableaux ; tout est inféré. Attendez-vous à ~90 % de titres corrects sur des procédures Word exportées en PDF, moins sur des mises en page complexes. Mitigation : options de seuils, avertissements dans l'UI, et surtout **préférer le DOCX source quand il existe** (l'UI le rappellera).
2. **Tableaux PDF sans bordures** : non détectés en V1 → paragraphes avec avertissement. Les tableaux à bordures sont bien gérés.
3. **Pages OCRisées** : pas de gras, pas d'italique ; titres seulement par hauteur de ligne ; pas d'images extraites dans une page scannée en V1.
4. **Images et wikis** : l'application ne peut pas téléverser (aucun réseau, pas de compte). Pour MediaWiki : téléversement manuel (ou `importImages.php` côté wiki) avec les noms générés ; pour Confluence : pièces jointes à ajouter à la page. Le ZIP et le `README.txt` par document guident ces étapes. C'est la principale friction résiduelle du produit, inhérente à la contrainte d'isolation.
5. **Collisions de noms d'images MediaWiki** : les fichiers sont globaux au wiki → préfixe par slug du document par défaut. À confirmer avec vos conventions.
6. **Échappement MediaWiki** : nombreux cas limites (`|` dans les cellules, lignes commençant par `*`, URL nues, `''`). Couvert par une fixture dédiée, mais à surveiller en recette.
7. **Confluence Cloud et presse-papiers** : la collée HTML est convertie par l'éditeur ; les macros (panneaux, code avec langage) deviennent des équivalents approximatifs (code sans coloration). Les gros collages (> ~1 Mo) peuvent être tronqués par le navigateur ou l'éditeur → le fichier storage format via API reste la voie fiable pour les gros documents. Comportement à vérifier sur votre instance.
8. **Confluence Server/DC vs Cloud** : la réponse « quel format coller » dépend de votre instance ; d'où la double sortie dès la V1.
9. **Ghostscript** (dépendance d'OCRmyPDF) a un historique de CVE sur fichiers malveillants. Mitigations : conteneur sans réseau, non root, lecture seule, `pids_limit`, mise à jour par reconstruction d'image. Alternative possible : OCRmyPDF `--output-type pdf` sans post-traitement Ghostscript n'existe pas totalement ; on garde Ghostscript mais isolé.
10. **Texte PDF corrompu** (polices sans ToUnicode) : texte extrait illisible. Détection par taux de caractères anormaux → OCR forcé de la page. Seuil à calibrer.
11. **Dimensionnement** : OCR d'un PDF scanné de 100 pages ≈ 2–4 min CPU à 300 dpi par worker. 50 scans simultanés avec 2 workers = file d'attente longue mais stable. Il faut connaître les ressources du serveur pour fixer `WORKERS`/`OCR_JOBS`.
12. **Luxembourgeois** : vérifier la disponibilité d'un `ltz.traineddata` de qualité ; sinon `deu+fra` donne des résultats acceptables sur le lexique.
13. **Authentification** : sans protection, n'importe qui joignant wiki.boi.lu peut déposer des documents et, avec un UUID, lire des résultats. Les UUID ne sont pas devinables, mais il faut une authentification au niveau du reverse proxy (SSO/OIDC/basic) ou une restriction réseau (VPN/LAN). À décider avant la mise en ligne.
14. **LibreOffice (V2)** : lourd, parfois instable sur des DOC anciens ; d'où le conteneur dédié avec timeout et redémarrage automatique.
15. **Presse-papiers** : `ClipboardItem` avec `text/html` est supporté par Chrome/Edge/Safari récents ; Firefox le supporte depuis la version 127. Repli : copie `text/plain` + bouton « Télécharger ».

---

## 13. Questions ouvertes (réponses nécessaires avant la phase 0)

1. **CVtool.boi.lu** : quel langage/stack, quel moteur OCR actuel, où est son code (nom du dépôt) ? Cela décide entre bibliothèque partagée et service OCR partagé.
2. **Confluence** : Cloud ou Server/Data Center ? Version ? Les utilisateurs ont-ils l'éditeur de source ou l'accès API ?
3. **MediaWiki** : version, langue d'interface (`File:` ou `Fichier:`), extension SyntaxHighlight active, modèles d'avertissement existants (`{{Warning}}` ?), convention de nommage des fichiers, catégories à poser.
4. **Serveur** : cœurs, RAM, disque, Docker Compose ou autre orchestrateur, reverse proxy existant (Traefik, nginx, Caddy ?) et mécanisme d'authentification disponible.
5. **Langues** des documents (français, allemand, anglais, luxembourgeois ?).
6. **Rétention** : les valeurs 1 h / 24 h conviennent-elles, ou souhaitez-vous le mode « suppression dès téléchargement » ?
7. **Volume** : nombre de documents typique par lot et par jour, taille moyenne, proportion de scans.
8. **Antivirus** : ClamAV souhaité ? Si oui, procédure d'import hors ligne des signatures à prévoir.
