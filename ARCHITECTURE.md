# Architecture

## Overview

docc combines two classification approaches — **semantic embeddings** and **vocabulary-based Naive Bayes** — and fuses their rankings to produce a single confidence-scored result. This dual approach is more robust than either method alone: embeddings capture meaning while Bayes captures distinctive vocabulary.

Everything runs locally. No cloud APIs, no API keys.

## Project Structure

```
bin/docc.js          CLI entry point (commander), wires up all commands
lib/
  db.js              SQLite schema + query helpers, dual embeddings, clearModel()
  pdf.js             PDF text extraction
  embedder.js        Ollama embedding API client
  bayes.js           Naive Bayes classifier
  vectors.js         Cosine similarity, centroid math, duplicate detection
  classifier.js      Score fusion orchestrator
  folders.js         Recursive folder scanner
  ui.js              Web UI server + inline SPA
  llm.js             Ollama LLM generation client (qwen3:1.7b)
  date.js            Date extraction (text regex, filename, mtime)
  namer.js           Filename suggestion orchestrator
data/
  docc.db            SQLite database (created at runtime, gitignored)
```

## Dependencies

| Package | Purpose |
|---|---|
| **commander** | CLI framework — subcommands, argument parsing, help text |
| **unpdf** | PDF text extraction (wraps PDF.js internally) |
| **better-sqlite3** | Embedded SQLite — stores documents, embeddings, and classifier state |

Ollama is called via native `fetch` against `http://localhost:11434`. No SDK needed. Two endpoints are used: `/api/embed` for embeddings and `/api/generate` for LLM text generation.

## How Classification Works

### 1. Embedding Centroids

Each document is embedded into a 1024-dimensional vector using Ollama's `qwen3-embedding:0.6b` model. Two embeddings are stored per document:

- **Enriched embedding** (`embedding`) — text prepended with `[File: filename]` via `enrichText()`. Used for classification and centroid computation, since filenames carry strong category signal.
- **Raw embedding** (`embedding_raw`) — content-only text, no filename metadata. Used for duplicate detection and name similarity matching, where filename differences between identical documents would cause false negatives.

For each folder/category, a **centroid** (element-wise mean of all enriched embeddings in that folder) is computed and stored. When classifying a new document, its enriched embedding is compared against every centroid using **cosine similarity**. Folders are ranked by similarity score.

This captures semantic meaning — documents about similar topics cluster together in vector space regardless of exact word choice or language.

### 2. Naive Bayes

A multinomial Naive Bayes classifier is trained on tokenized document text. For each folder, it tracks word frequencies. Classification uses Bayes' theorem with Laplace smoothing:

```
log P(folder | doc) = log(docCount[folder] / totalDocs)
                    + sum( log((wordCount[folder][word] + 1) / (totalWords[folder] + vocabSize)) )
```

This captures distinctive vocabulary — if invoices always contain "Rechnungsnummer" and "Betrag", that signal is strong even when the semantic embedding is ambiguous.

**Tokenization** is Unicode-aware (`\p{L}` and `\p{N}` character classes) to handle German characters (umlauts, eszett) alongside English. A combined stopword list filters common function words in both languages.

### 3. Reciprocal Rank Fusion (RRF)

The two rankings are combined using RRF, a standard rank-fusion method:

```
RRF_score(folder) = 1/(k + rank_cosine) + 1/(k + rank_bayes)
```

`k = 5` (tuned for small category counts of 10–50 folders; the web-search default of k=60 is too flat at this scale).

RRF is rank-based rather than score-based, so it doesn't need calibration between the very different score scales of cosine similarity (0–1) and log-probabilities (large negative numbers).

**Confidence scoring:** Each result's RRF score is normalized against the theoretical maximum (rank #1 in both methods), then multiplied by the result's embedding cosine similarity. This injects an absolute confidence signal — a poor semantic fit shows a low percentage even when ranked first. Per-method detail (embedding similarity, embedding rank, Bayes rank) is also returned for each result.

### 4. Duplicate Detection

When classifying via the web UI, the inbox PDF's **raw embedding** (content-only, no filename enrichment) is compared against all stored documents' raw embeddings using cosine similarity. Documents exceeding a **0.985 threshold** are flagged as likely duplicates — this catches OCR re-scans (which typically score 0.99+) while avoiding false positives from merely topically-similar documents. Using raw embeddings ensures that two identical PDFs with different filenames are correctly identified as duplicates.

Duplicates appear as a non-blocking hint above the classification suggestions. The user can compare documents side-by-side or delete the inbox copy directly.

### 5. Leave-One-Out Testing

The `test` command evaluates accuracy without a separate test set. For each document:

1. Its embedding is removed from the folder centroid via direct arithmetic: `adjusted = (centroid * n - embedding) / (n - 1)`
2. Its tokens are untrained from the Bayes model (decrementing counts)
3. The document is classified against the adjusted model
4. The centroid and Bayes state are restored

This gives an unbiased accuracy estimate since each document is never evaluated against a model that includes itself.

### 6. Filename Suggestions

After classification, docc suggests filenames in `YYYY-MM Name.pdf` format. This is handled by three modules:

**Date extraction** (`date.js`) uses a waterfall strategy:
1. PDF text (first 2000 chars) — regex patterns for DD.MM.YYYY, DD. Monat YYYY, Month DD YYYY, YYYY-MM-DD, MM/YYYY. Dates near keywords like "Datum", "Rechnungsdatum", "Issued" are preferred.
2. Filename pattern — e.g. `20260210_Scan_*` → `2026-02` (scan date, month precision only).
3. File mtime — fallback, month precision.

**Name suggestions** (`namer.js`) combines two sources:
- **Similarity matches** — the new document's raw embedding is compared against each document's raw embedding in the target folder. Matches above 0.97 cosine similarity contribute their name part (date prefix stripped). These appear first since they match existing naming conventions. Raw embeddings are used here so that filename differences don't suppress matches between content-identical documents.
- **LLM generation** — `qwen3:1.7b` generates names to fill remaining slots (up to 5 total). The prompt includes example filenames from the folder and the first 3000 chars of document text. Post-processing strips dates/numbering, restores German umlauts (ae→ä, oe→ö, ue→ü), and converts ALL CAPS to title case.

**LLM client** (`llm.js`) calls Ollama's `/api/generate` with `think: false` (qwen3 models default to thinking mode, which consumes all `num_predict` tokens for internal reasoning and returns an empty response). 15s timeout.

In the CLI (`docc classify`), suggestions are shown synchronously below the results table. In the web UI, they load asynchronously via `POST /api/suggest-names` after classification completes, populating a dropdown on the rename input. Changing the selected folder triggers a new suggestion request.

`docc test-names` evaluates suggestions against existing documents using leave-one-out (excluding each document from its folder's docs before generating suggestions).

## Configuration

Two paths are stored in the `meta` table:

- **root** — the organized folder structure containing categorized PDFs. Set during `setup` or via `docc config root <path>`. Used as the default for `docc learn` when no argument is given.
- **inbox** — folder containing unclassified PDFs. Set during `setup` or via `docc config inbox <path>`. Used as the default for `docc ui` when no argument is given (falls back to cwd if not set).

Changing the root path when a learned model exists triggers a confirmation prompt and clears the model (documents, centroids, bayes_state) since the category structure has changed. `docc reset` clears the learned model but preserves configuration.

## Web UI

`docc ui` starts a local web server with an inline SPA for interactive batch classification. The UI is fully keyboard-driven for speed.

**Layout:** PDF preview (left, 60%) + control pane (right, 40%) + full-width keyboard shortcut bar (bottom). Navigation buttons and progress counter live in the header bar.

**Classification flow:** Each PDF is classified against the learned model, showing the top N suggestions (configurable via `NUM_SUGGESTIONS`, default 4) ranked by confidence score. If a near-duplicate is detected (cosine similarity >= 0.985), a warning with compare/delete actions appears above the suggestions as a non-blocking hint. The user can pick a suggestion (keys 1-N, arrow selection + Enter), or press N+1 / arrow-down past the last suggestion to open a folder search with multi-word AND matching. Files can be renamed before moving (`.pdf` auto-appended). Holding `i` shows per-method detail (embedding similarity, embedding rank, Bayes rank) instead of the combined confidence score.

**Compare view:** A side-by-side PDF comparison with the inbox document on the left and the existing document on the right. Triggered by: (a) pressing `c` on a duplicate warning, or (b) clicking any file row in the folder file list. `Esc` exits back to normal view, `d` deletes the inbox copy.

**State model:** The PDF list is fetched once at init. A `movedMap` tracks moved files and a `deletedSet` tracks deleted files. Navigation is free — users can go back to already-handled documents. Toast notifications confirm moves (green), skips (yellow), and deletes (red).

**Console logging:** All user actions are logged to the terminal — classify results (top folder + confidence), duplicate detections, moves (with rename if applicable), skips, and deletes. This provides an audit trail during batch classification sessions.

**API endpoints:**

| Endpoint | Purpose |
|----------|---------|
| `GET /api/pdfs` | List PDFs in inbox |
| `GET /api/pdf/:name` | Serve raw PDF from inbox for preview |
| `GET /api/doc-pdf?path=X` | Serve PDF from root (for compare view) |
| `GET /api/folders` | All known folder categories |
| `GET /api/folder-files?folder=X` | Files in a folder (sorted by mtime) |
| `POST /api/classify` | Classify a PDF, returns ranked results + duplicates |
| `POST /api/suggest-names` | Async filename suggestions for a classified PDF |
| `POST /api/move` | Move PDF to folder (with optional rename) |
| `POST /api/delete` | Delete a PDF from inbox |
| `POST /api/log` | Log a client-side action (skip) to the console |
| `POST /api/open-folder` | Open folder in system file manager |

## Storage

All state lives in a single SQLite database (`data/docc.db`):

- **documents** — path, folder category, extracted text, enriched embedding (`embedding` blob), raw content-only embedding (`embedding_raw` blob, nullable for legacy data)
- **centroids** — pre-computed per-folder centroid embedding + document count
- **bayes_state** — serialized classifier state (JSON blob, singleton row)
- **meta** — key-value pairs (root directory path, inbox path, embed_model)

Embeddings are stored as `Float64Array` buffers (1024 doubles = 8,192 bytes each, two per document = ~16 KB). The `embedding_raw` column is added via `ALTER TABLE` on first access if missing, allowing seamless upgrades from older databases. Legacy rows with `NULL` raw embeddings fall back to the enriched embedding via `doc.embeddingRaw || doc.embedding`. SQLite with WAL mode handles concurrent reads efficiently.

## Models

**Embedding: `qwen3-embedding:0.6b`** — 1024-dimensional vectors, 32K token context window. Progressive truncation at 24K/12K/4K chars on context overflow. ~640 MB download, runs fully offline via Ollama.

**Generation: `qwen3:1.7b`** — used for filename suggestions. Same Qwen family as the embedding model. ~1.4 GB download, generates in <2s. Strong multilingual support (German + English). Must be called with `think: false` to disable the default thinking mode.
