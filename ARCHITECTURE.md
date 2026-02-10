# Architecture

## Overview

docc combines two classification approaches — **semantic embeddings** and **vocabulary-based Naive Bayes** — and fuses their rankings to produce a single confidence-scored result. This dual approach is more robust than either method alone: embeddings capture meaning while Bayes captures distinctive vocabulary.

Everything runs locally. No cloud APIs, no API keys.

## Project Structure

```
bin/docc.js          CLI entry point (commander), wires up all 7 commands
lib/
  db.js              SQLite schema + query helpers, clearModel()
  pdf.js             PDF text extraction
  embedder.js        Ollama REST API client
  bayes.js           Naive Bayes classifier
  vectors.js         Cosine similarity, centroid math, duplicate detection
  classifier.js      Score fusion orchestrator
  folders.js         Recursive folder scanner
  ui.js              Web UI server + inline SPA (classification, duplicate detection, compare view)
data/
  docc.db            SQLite database (created at runtime, gitignored)
```

## Dependencies

| Package | Purpose |
|---|---|
| **commander** | CLI framework — subcommands, argument parsing, help text |
| **unpdf** | PDF text extraction (wraps PDF.js internally) |
| **better-sqlite3** | Embedded SQLite — stores documents, embeddings, and classifier state |

Ollama is called via native `fetch` against `http://localhost:11434/api/embed`. No SDK needed.

## How Classification Works

### 1. Embedding Centroids

Each document is embedded into a 768-dimensional vector using Ollama's `nomic-embed-text` model. For each folder/category, a **centroid** (element-wise mean of all document embeddings in that folder) is computed and stored.

When classifying a new document, its embedding is compared against every centroid using **cosine similarity**. Folders are ranked by similarity score.

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

When classifying via the web UI, the inbox PDF's embedding (already computed for classification) is compared against all stored document embeddings using cosine similarity. Documents exceeding a **0.985 threshold** are flagged as likely duplicates — this catches OCR re-scans (which typically score 0.99+) while avoiding false positives from merely topically-similar documents.

Duplicates appear as a non-blocking hint above the classification suggestions. The user can compare documents side-by-side or delete the inbox copy directly.

### 5. Leave-One-Out Testing

The `test` command evaluates accuracy without a separate test set. For each document:

1. Its embedding is removed from the folder centroid via direct arithmetic: `adjusted = (centroid * n - embedding) / (n - 1)`
2. Its tokens are untrained from the Bayes model (decrementing counts)
3. The document is classified against the adjusted model
4. The centroid and Bayes state are restored

This gives an unbiased accuracy estimate since each document is never evaluated against a model that includes itself.

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
| `POST /api/move` | Move PDF to folder (with optional rename) |
| `POST /api/delete` | Delete a PDF from inbox |
| `POST /api/log` | Log a client-side action (skip) to the console |
| `POST /api/open-folder` | Open folder in system file manager |

## Storage

All state lives in a single SQLite database (`data/docc.db`):

- **documents** — path, folder category, extracted text, embedding (as `Float64Array` blob)
- **centroids** — pre-computed per-folder centroid embedding + document count
- **bayes_state** — serialized classifier state (JSON blob, singleton row)
- **meta** — key-value pairs (root directory path, inbox path)

Embeddings are stored as raw `Float64Array` buffers (768 doubles = 6,144 bytes per document). SQLite with WAL mode handles concurrent reads efficiently.

## Embedding Model

`nomic-embed-text` was chosen for its balance of quality and size:

- 768-dimensional vectors
- ~0.5 GB RAM footprint
- ~9,300 tokens/sec on Apple Silicon
- Strong multilingual performance (German + English)
- Runs fully offline via Ollama
