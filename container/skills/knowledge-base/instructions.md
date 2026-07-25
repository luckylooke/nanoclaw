---
name: knowledge-base
description: Search indexed reference books (RAG) for architectural and technical guidance. Use when making an architecture/design decision, or to check a proposal against authoritative sources. Returns exact quotes with source, page, and a confidence score.
---

# Knowledge Base (RAG)

A local vector index of ingested reference books (PDFs). Query it via the `rag` tool through the tool proxy. Embeddings run locally on the VPS (Ollama, `mxbai-embed-large`, 1024-dim) — nothing leaves the server, no API key.

## Search (all agents)

```bash
# Find relevant passages — scope to your domain(s) so unrelated books are excluded
node /workspace/extra/tool-exec.js rag search "your question here" --domain <your-domain> --k 5

# List indexed books (shows each source's domain)
node /workspace/extra/tool-exec.js rag list
```

**Domains keep retrieval relevant.** Each book is tagged with a domain (`ai`, `web`, `game`, …). Pass `--domain` to restrict a search to sources that fit your work — e.g. a game-dev agent uses `--domain game` and never pulls from an AI/LLM book. `--domain a,b` searches multiple. Omit `--domain` only to search everything (admin/system-wide). If a scoped search returns empty, there are no matching sources yet — use your own reasoning.

`search` returns JSON with `results[]`, each carrying:
- `confidence` — cosine similarity 0–1 (higher = more relevant)
- `source` — "Title — Author"
- `page` — page number in the source
- `quote` — the exact indexed text

### Harder lookups: `--rerank` (opt-in)

The default search is fast, local-only, and free (pure vector similarity). For a **difficult or high-stakes lookup** — an exact term / code identifier / API name, or when the plain search returns weak or off-target results — add `--rerank`:

```bash
node /workspace/extra/tool-exec.js rag search "exact term or hard question" --domain <your-domain> --rerank --k 5
```

`--rerank` retrieves a wider candidate pool (lexical BM25 + vector, fused) and a small model reranks it down to the best `--k`, dropping index/glossary/boilerplate noise. On the retrieval eval it beat the default on every metric (context-precision 0.48 → 0.74). **Cost note:** it makes **one Haiku LLM call per search** (small, but not free, and adds ~1–2s), billed to your agent's normal budget. So use the default for routine checks and reach for `--rerank` only when a lookup is hard or the answer really matters.


### Follow-up questions: `--rewrite` (opt-in)

If your query is elliptical or leans on the conversation ("what about the cost?", "how does that scale?"), pass the recent thread text so it can be folded into a standalone query first:

```bash
node /workspace/extra/tool-exec.js rag search "what about the cost?" --rewrite --context "we were discussing long context windows" --domain <your-domain>
```

The response echoes `rewritten_query` so you can see what was actually searched. One small Haiku call (billed to your budget); skip it when your query already stands on its own.

## How to use results — the anti-hallucination contract (strict)

Every claim you make from the knowledge base must be **traceable to a retrieved quote**. Rule of thumb: *an authoritative-sounding claim with no citation is a bug* — a reader (or an eval) can spot an unsupported answer purely by its missing citation.

- **Cite every source-backed claim inline** — quote + source (author) + **page** — right where you make the claim. Never paraphrase indexed text as your own fact.
- **Confidence gate / miss.** If the top result's `confidence` is low (roughly `< 0.4`) or `results` is empty, say plainly **"not in the knowledge base"** *first*. You may then add your own reasoning, but you MUST label it "my own reasoning, not source-backed".
- **Never fabricate a citation.** Do not invent a source, page, or quote, and never dress up your own general knowledge as if it came from the index. State only what the returned quotes actually support.
- **Flag contradictions.** If a proposed design conflicts with an indexed source, surface the conflict with the citation, then suggest the source-backed alternative.
- On architecture / design decisions, search the knowledge base **first**, then reason with what it returns.

## Admin (host-side only — not runnable from inside the container)

Ingesting and removing books runs on the VPS host, because the tool reads the PDF from the host filesystem:

```bash
# on the host (ssh agent@…):
node ~/agent-system/tools/rag/rag.js ingest <file.pdf> --title "..." --author "..."
node ~/agent-system/tools/rag/rag.js remove <source_id|title-substring>
node ~/agent-system/tools/rag/rag.js stats
```
