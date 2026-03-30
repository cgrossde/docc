# Building an automated PDF classification and filing system in TypeScript

**A local-first, LLM-powered document organizer running on Apple Silicon is entirely achievable with today's tooling — and the npm ecosystem is surprisingly mature for this.** The optimal architecture combines local embeddings for fast pre-filtering with a local LLM for nuanced classification, falling back to a cloud API for edge cases. Three concrete solution tiers exist: a rule-based approach (~70% accuracy, zero dependencies), an embedding/TF-IDF hybrid (~85% accuracy, fully offline), and a local LLM pipeline with cloud fallback (~93%+ accuracy). All three are buildable in TypeScript/Node.js using actively maintained packages. No existing open-source project does exactly this in TypeScript, but several reference implementations (Paperless-AI in Node.js, Note Companion in TypeScript) provide excellent architectural patterns to build from.

---

## PDF text extraction: three strong options, one clear winner

All libraries below extract the **embedded text layer** from OCR'd PDFs — they do not perform OCR themselves. Since your documents are already OCR'd, this is exactly what you need.

**`unpdf`** is the recommended choice for new TypeScript projects. Built by the UnJS team (Nuxt ecosystem), it wraps Mozilla's PDF.js v5 with a clean async/await API and ships with excellent TypeScript types. A single call to `extractText()` returns the full document text. It works in Node.js, Deno, and serverless environments with zero native dependencies. For batch processing 5,000 documents, expect **~0.5–2 seconds per document** depending on page count.

**`pdfjs-dist`** (Mozilla's PDF.js, **~50,000 GitHub stars**) is the most battle-tested option and handles edge cases better than any alternative. Its API is more complex — you work with individual pages and text content items — but it gives you positional/coordinate data that's valuable for structured documents like invoices. If you encounter PDFs that other libraries choke on, `pdfjs-dist` will likely handle them.

**`pdf-parse` v2** was rewritten as pure TypeScript in late 2025 and offers the simplest API (`getText()` returns a string). It uses PDF.js internally. The v2 rewrite addresses years of v1 being unmaintained. Good for prototyping, though `unpdf` offers a similarly simple API with better maintenance pedigree.

| Package | TypeScript | API complexity | Edge-case handling | Weekly downloads |
|---------|-----------|---------------|-------------------|-----------------|
| `unpdf` | Native (built-in) | Simple | Good (PDF.js v5) | Growing |
| `pdfjs-dist` | Native (built-in) | Complex | Best | 2,468+ dependents |
| `pdf-parse` v2 | Native (built-in) | Simplest | Good | 684+ dependents |
| `pdf-lib` | Native | N/A | N/A | **Does not extract text** |

Note that `pdf-lib` is for PDF creation/modification only — it cannot extract text and is irrelevant for classification. `pdf2json` is worth considering if you need coordinate/positional data with zero dependencies.

---

## Local LLMs on M2: Ollama dominates the Node.js ecosystem

**Ollama is the clear winner for local LLM integration with Node.js.** It provides a native Metal-accelerated runtime, an official TypeScript SDK (`ollama` on npm, **1.2M+ weekly downloads**), and handles model management automatically. On an M2 MacBook, expect **15–28 tokens/second** for 7B-parameter models — fast enough to classify a document in 5–15 seconds.

The `ollama` npm package wraps a clean REST API at `localhost:11434` and supports chat completions, embeddings, structured JSON output, and streaming. A classification call looks like this: `await ollama.chat({ model: 'llama3.1', messages: [...], format: jsonSchema })`. The `format` parameter enforces structured output via JSON schema, eliminating parsing headaches.

**Best models for document classification by RAM tier:**

For **8GB RAM**, use **Qwen3 4B** (Q4_K_M quantization, ~2.75GB on disk, ~4GB RAM) or **Llama 3.2 3B** (~2GB on disk, ~3.5GB RAM). Both leave enough headroom for the embedding model and Node.js runtime. Qwen3 4B scores **74% on MMLU-Pro** despite its small size and handles classification prompts reliably.

For **16GB RAM**, **Llama 3.1 8B Instruct** (Q4_K_M, ~4.7GB on disk, ~6–7GB RAM) is the workhorse. Excellent instruction-following and structured output compliance. **Qwen 2.5 7B** is a strong alternative with superior multilingual support. You could even run **Gemma 3 12B** (~7.3GB) for the best quality, though it leaves less room for concurrent embedding operations.

**Alternatives to Ollama** exist but have trade-offs. **`node-llama-cpp`** runs llama.cpp in-process (no separate daemon), ships with native Metal binaries for Apple Silicon, and is written entirely in TypeScript. It's faster to cold-start since there's no server process, but you lose Ollama's model management convenience. **LM Studio** exposes an OpenAI-compatible API at `localhost:1234` and offers both llama.cpp and Apple MLX backends (MLX can be **20–30% faster** on Apple Silicon). Its TypeScript SDK `@lmstudio/sdk` is solid, but requiring a GUI app is awkward for a CLI tool. **MLX bindings for Node.js** exist via the community `node-mlx` package (GitHub: `frost-beta/node-mlx`), but this is still maturing compared to Ollama.

---

## Embedding-based classification delivers 85–95% accuracy offline

The highest-leverage approach for your use case is **embedding-based similarity search**: embed every document already in your folder structure, build a vector index per folder, then classify new documents by finding the most similar existing documents.

**For embedding models**, run **`nomic-embed-text`** via Ollama. It produces **768-dimensional** vectors, uses only **~0.5GB RAM**, and processes at **~9,340 tokens/second** on M2 Max. Embedding 5,000 documents (averaging 500 tokens each) takes roughly **3–5 minutes**. Alternatively, `@huggingface/transformers` (Transformers.js, **13K+ GitHub stars**) runs ONNX models directly in Node.js without a separate process — use `Xenova/all-MiniLM-L6-v2` for a lightweight 384-dimensional model that's faster but limited to ~256-token inputs.

**For vector storage and search**, two libraries stand out:

- **`vectra`** (npm) — A file-backed, in-memory vector database written in pure TypeScript. Each index is a folder on disk with JSON files. Queries return in **1–2ms**. Perfect for up to ~50,000 documents. Zero infrastructure, zero native dependencies. This is the right choice for your scale.
- **`@lancedb/lancedb`** (**4.6K GitHub stars**) — An embedded vector database stored in columnar Lance format on disk. Supports SQL-like filtering, hybrid search, and scales to millions of vectors. More feature-rich but heavier. Choose this if you anticipate growing past 50K documents.

Other options include `hnswlib-node` (HNSW algorithm, used by LangChain.js), `faiss-node` (FAISS bindings), and `usearch` (claims 20x faster than FAISS for brute-force search). All require native compilation but work on Apple Silicon.

**The classification pipeline** works as follows: during initialization, compute a centroid embedding for each folder by averaging its documents' embeddings. When a new document arrives, embed it and compare against folder centroids using cosine similarity. Take the top-3 candidates. For well-separated categories (invoices vs. contracts vs. medical records), this alone achieves **85–95% accuracy**. For ambiguous cases, pass the candidates to the LLM for a final decision.

---

## Traditional ML still works remarkably well for this problem

Before reaching for LLMs, consider that **TF-IDF + Naive Bayes classifiers achieve 80–95% accuracy** on document categorization with 10–50 folder categories — and they classify in under a millisecond.

**`natural`** (npm, **~10,800 GitHub stars**, ~200K weekly downloads) is the Swiss army knife. It bundles TF-IDF computation, tokenizers, stemmers, a `BayesClassifier`, and a `LogisticRegressionClassifier` in one package. Train it by calling `classifier.addDocument(tokens, 'Invoices')` for each labeled document, then `classifier.train()`. Classification takes **<1ms per document**. Models serialize to JSON for persistence. The `wink-naive-bayes-text-classifier` (companion to `wink-nlp`) offers better TypeScript support and built-in cross-validation metrics, reporting **90% accuracy on sentiment** and **99% on intent classification** with proper preprocessing.

**Why this works for document filing:** documents in different folders typically have **highly distinct vocabularies**. Tax returns contain "W-2", "1099", "adjusted gross income." Medical records contain "diagnosis", "prescription", "patient." TF-IDF naturally amplifies these distinguishing terms. With just 10–20 labeled examples per category, Naive Bayes learns effective classification boundaries.

A **hybrid approach** combining keyword rules (if document contains "Form 1040" → tax returns) with Naive Bayes as a fallback often outperforms either method alone. Use `compromise` (npm, **~10,600 stars**) for entity extraction — dates, names, monetary amounts — as preprocessing features. Use `chrono-node` for natural language date parsing to extract filing dates from document text.

---

## Existing projects to learn from (but not use directly)

No existing TypeScript project does exactly what you want — offline PDF auto-filing on macOS as a CLI tool. But several projects provide excellent architectural patterns:

**Note Companion** (formerly File Organizer 2000, GitHub: `different-ai/note-companion`) is the closest match. Written in **TypeScript** with React and Next.js, it's an Obsidian plugin that watches an inbox folder, classifies documents with AI (OpenAI, Anthropic, Google), suggests folders and tags, and moves files. Study its classification pipeline and prompt engineering, even though it's Obsidian-specific.

**Paperless-AI** (GitHub: `clusterzx/paperless-ai`, **~4,600 stars**) is a **Node.js** sidecar for Paperless-ngx that uses LLMs (OpenAI, Ollama, DeepSeek) to auto-assign titles, tags, and document types. Its JavaScript codebase demonstrates LLM-based document classification patterns directly applicable to your project.

**Paperless-ngx** itself (**~36,000 stars**) uses scikit-learn's MLPClassifier trained on user-assigned metadata — a proven "learn from existing organization" approach. Its auto-classification retrains hourly from confirmed documents. The architecture (text vectorization → ML classifier → metadata assignment) maps directly to your TF-IDF tier.

**LlamaFS** (GitHub: `iyaja/llama-fs`, **~5,000 stars**) demonstrates the exact scan → classify → file pattern with LLMs, plus batch mode and watch mode. Python backend with Electron frontend. **`organize`** (GitHub: `tfeldmann/organize`, **~2,500 stars**) is the open-source Hazel alternative — a Python CLI with YAML-configured rules for file organization. Its filter→action pipeline and simulation/dry-run mode are directly applicable architecture patterns.

For the "learning from existing folder structure" approach, **DEVONthink** (commercial macOS app) is the gold standard. Its AI classification engine builds a similarity model from documents in each group and suggests the best-fit group for new documents. This is essentially the embedding-centroid approach described above.

---

## Three concrete architectures, from simple to advanced

### Tier 1: Rule engine (no ML, ~70% accuracy)

Pattern matching against filename and extracted text using configurable YAML rules. Use `chokidar` v5 (ESM-only, **75.9M weekly downloads**, TypeScript-native) for file watching, `pdf-parse` for extraction, `chrono-node` for date parsing, and `natural` for tokenization/stemming. Define rules like: "if text matches `/invoice\s*#?\s*\d+/i` → Invoices folder." Fully deterministic, instant processing, zero external dependencies. **Breaks down with ambiguous or novel document types.**

### Tier 2: Embeddings + TF-IDF hybrid (~85% accuracy)

Combines `natural`'s BayesClassifier with embedding-based folder centroid matching via Ollama + `vectra`. On initialization, embed all existing documents and compute folder centroids. For new documents: TF-IDF pre-filters to top-N candidates, then embedding cosine similarity ranks them. The feedback loop works by updating folder centroids incrementally: `new_centroid = (old_centroid × n + new_embedding) / (n + 1)`. Retrain the Bayes classifier with `classifier.addDocument()` on user confirmations, then persist with `classifier.save()`. **Fully offline, no API costs, learns continuously.**

### Tier 3: Local LLM + cloud fallback (~93%+ accuracy)

The most capable architecture uses embedding pre-filtering (Tier 2) to narrow candidates, then a local LLM via Ollama for nuanced classification with structured JSON output (enforced via `zod` schema + Ollama's `format` parameter). A confidence scoring system routes decisions: **≥0.85 confidence → auto-file**, 0.60–0.85 → user confirmation, **<0.60 → cloud API fallback**. After initial training on ~100 documents, expect ~70% auto-filed locally, ~20% confirmed locally, and ~10% requiring cloud. Use `@anthropic-ai/sdk` or `openai` npm packages for the fallback.

**Recommended UI approach:** Start with a **CLI tool + lightweight web UI** served on localhost. Run the watcher as a background daemon via macOS `launchd`. The web UI (Express/Fastify + React/Svelte) shows pending classifications with PDF previews, confidence scores, and confirm/correct/skip buttons. Use `node-notifier` for macOS desktop notifications when new documents are classified. This avoids Electron's ~100MB overhead while delivering a responsive experience.

---

## Cloud API costs are negligible — local is about privacy, not savings

For **5,000 documents averaging 2,000 input tokens each**, cloud classification costs are remarkably low:

| Provider/Model | Per document | 5,000 docs (batch) |
|---------------|-------------|-------------------|
| **GPT-4o-mini** | $0.000188 | **$0.94** |
| Claude Haiku 3 | $0.000322 | $1.61 |
| Claude Haiku 4.5 | $0.001288 | $6.44 |
| Local LLM (Ollama) | $0 | $0 (but ~14 hours processing) |

GPT-4o-mini via OpenAI's Batch API (50% discount, results within 24 hours) is the cheapest cloud option at **under $1 for 5,000 documents**. Claude Haiku 3 is similarly cheap. The cost argument for local processing is essentially nonexistent — **the real case for local is privacy and offline capability**. If your documents contain sensitive financial, medical, or legal information, keeping them off cloud APIs has genuine value regardless of cost.

The hybrid approach is optimal: use local classification for the ~90% of documents that get high-confidence scores (free and fast), and spend pennies on cloud fallback for ambiguous cases. Structure both paths to use the same Zod schema for structured output, making the fallback transparent to the rest of the pipeline.

---

## Recommended project structure and key packages

```
pdf-classifier/
├── src/
│   ├── index.ts                  # CLI entry (commander)
│   ├── watcher/file-watcher.ts   # chokidar v5
│   ├── extraction/pdf-extractor.ts  # unpdf or pdf-parse
│   ├── classification/
│   │   ├── classifier.ts         # Strategy interface
│   │   ├── rule-classifier.ts    # Tier 1: regex/keyword rules
│   │   ├── embedding-classifier.ts  # Tier 2: vector similarity
│   │   └── llm-classifier.ts     # Tier 3: Ollama + cloud fallback
│   ├── embedding/
│   │   ├── embedder.ts           # Ollama or Transformers.js
│   │   └── vector-store.ts       # Vectra or LanceDB
│   ├── feedback/
│   │   ├── feedback-store.ts     # better-sqlite3
│   │   └── learning-loop.ts      # Retrain from corrections
│   ├── ui/server.ts              # Fastify web UI
│   └── utils/
├── data/
│   ├── rules.yaml                # Classification rules
│   ├── vector-index/             # Vectra index
│   └── feedback.db               # SQLite
├── package.json
└── tsconfig.json
```

**Complete npm dependency list:**

| Purpose | Package | Why this one |
|---------|---------|-------------|
| File watching | `chokidar` v5 | 75.9M downloads, TypeScript-native, macOS FSEvents |
| PDF extraction | `unpdf` | TypeScript-first, modern PDF.js wrapper |
| Local LLM | `ollama` | Official SDK, 1.2M downloads, Metal GPU |
| Local embeddings | `ollama` (embed API) | Same process, nomic-embed-text model |
| Vector database | `vectra` | Pure TS, file-backed, perfect for <50K docs |
| NLP/classification | `natural` | TF-IDF, Bayes classifier, tokenizers |
| Schema validation | `zod` + `zod-to-json-schema` | Structured LLM output |
| Cloud: Anthropic | `@anthropic-ai/sdk` | TypeScript-native, 5.7M downloads |
| Cloud: OpenAI | `openai` | Batch API for bulk processing |
| Date parsing | `chrono-node` | Extract dates from document text |
| CLI framework | `commander` | Standard Node.js CLI |
| Database | `better-sqlite3` | Feedback/history storage |
| Web server | `fastify` | Lightweight, TypeScript-friendly |
| File operations | `fs-extra` | Safe move/copy with error handling |
| Notifications | `node-notifier` | macOS desktop alerts |

## Conclusion

The most effective path is to **start with Tier 2** (embeddings + TF-IDF) and **add Tier 3 capabilities** (local LLM) once the pipeline is working. Begin by extracting text from your existing organized documents with `unpdf`, embedding them with `nomic-embed-text` via Ollama, and building folder centroids in `vectra`. This alone will correctly classify 85%+ of new documents with zero API costs and sub-second latency. Layer in `natural`'s BayesClassifier for an ensemble boost, then add Ollama LLM classification for the remaining ambiguous cases.

The critical insight from existing projects like Paperless-ngx and DEVONthink is that **your existing folder organization is already your training data** — you don't need to manually label anything. Every document already filed is a labeled example. The feedback loop then only needs to handle corrections to the ~10–15% of misclassifications, making the cold-start problem much smaller than it initially appears. Target a working prototype that indexes existing folders, classifies a test batch, and measures accuracy before investing in the web UI or cloud fallback — validation of classification quality should come before building the full pipeline.