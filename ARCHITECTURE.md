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
  vectors.js         Cosine similarity, centroid math
  classifier.js      Score fusion orchestrator
  folders.js         Recursive folder scanner
  ui.js              Web UI server + inline SPA for interactive classification
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

`k = 5` (tuned for small category counts of 10–50 folders; the web-search default of k=60 is too flat at this scale). The top 5 results are normalized so scores sum to 1.0, giving interpretable confidence values.

RRF is rank-based rather than score-based, so it doesn't need calibration between the very different score scales of cosine similarity (0–1) and log-probabilities (large negative numbers).

### 4. Leave-One-Out Testing

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

**Classification flow:** Each PDF is classified against the learned model, showing the top 3 suggestions ranked by RRF score. The user can pick a suggestion (keys 1-3, arrow selection + Enter), or press 4 / arrow-down past suggestion 3 to open a folder search with multi-word AND matching. Files can be renamed before moving (`.pdf` auto-appended).

**State model:** The PDF list is fetched once at init. A `movedMap` tracks which files have been moved and where (folder + final name). Navigation is free — users can go back to already-moved documents to see where they were filed and open the destination folder. Toast notifications confirm moves (green) and skips (yellow).

**API endpoints:**

| Endpoint | Purpose |
|----------|---------|
| `GET /api/pdfs` | List PDFs in inbox |
| `GET /api/pdf/:name` | Serve raw PDF for preview |
| `GET /api/folders` | All known folder categories |
| `GET /api/folder-files?folder=X` | Files in a folder (sorted by mtime) |
| `POST /api/classify` | Classify a PDF, returns ranked results |
| `POST /api/move` | Move PDF to folder (with optional rename) |
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
