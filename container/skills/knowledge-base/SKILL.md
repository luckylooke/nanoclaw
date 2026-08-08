---
name: knowledge-base
description: Search indexed reference books (RAG) for architectural and technical guidance. Use when making an architecture/design decision, or to check a proposal against authoritative sources. Returns exact quotes with source, page, and a confidence score.
---

# Knowledge Base (RAG)

A local vector index of ingested reference books (PDFs) and curated documentation sites. Query it via the `rag` tool through the tool proxy. Embeddings run locally on the VPS (Ollama, `mxbai-embed-large`, 1024-dim) — nothing leaves the server, no API key.

## Search (all agents)

```bash
# Find relevant passages — scope to your domain(s) so unrelated books are excluded
node /workspace/extra/tool-exec.js rag search "your question here" --domain <your-domain> --k 5

# List indexed sources (domain, layer, framework, age, staleness)
node /workspace/extra/tool-exec.js rag list
```

**Domains keep retrieval relevant.** Each book is tagged with a domain (`ai`, `web`, `game`, …). Pass `--domain` to restrict a search to sources that fit your work — e.g. a game-dev agent uses `--domain game` and never pulls from an AI/LLM book. `--domain a,b` searches multiple. Omit `--domain` only to search everything (admin/system-wide). If a scoped search returns empty, there are no matching sources yet — use your own reasoning.

`search` returns JSON with `results[]`, each carrying:
- `confidence` — cosine similarity 0–1 (higher = more relevant)
- `source` — "Title — Author"
- `page` — page number in the source (for a web source, which doc page it came from)
- `chapter` — the heading path the chunk sits under, e.g. `Layers > Import rule on layers`
- `url` — the exact page the chunk came from, for web sources; cite this
- `layer`, `framework` — what kind of authority the source carries, and for which stack
- `retrieved_at`, `stale` — when the source was last fetched, and whether that is older
  than the staleness threshold (90 days, echoed as `staleness_days`)
- `quote` — the exact indexed text

**Layers scope a search *within* a domain**, by the kind of authority you need —
`architecture` | `patterns` | `design-tokens` | `module:<name>`:

```bash
node /workspace/extra/tool-exec.js rag search "<question>" --domain web --layer architecture --k 5
```

**Stale sources are flagged, never hidden.** A hit with `stale: true` still answers the
question, but say so before relying on it and offer to refresh the source. `rag list` marks
the same sources, so you can check before a decision rather than after.

### Harder lookups: `--rerank` (opt-in)

For a difficult or high-stakes lookup (exact term / identifier / API name, or when the plain search is weak), add `--rerank`:

```bash
node /workspace/extra/tool-exec.js rag search "hard question" --domain <your-domain> --rerank --k 5
```

It retrieves a wider BM25+vector pool and reranks to the best `--k`, dropping index/boilerplate noise (context-precision 0.48 → 0.74 on the eval). **Cost:** one small Haiku call per search (~1–2s, billed to your budget) — use it only when a lookup is hard or the answer matters; the default is free.


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

## Curating the knowledge base

Books and PDFs are ingested **on the host** (the tool reads the file from the host
filesystem). Documentation sites are ingested **through the proxy from anywhere**, because
the fetching happens host-side too:

```bash
# books / PDFs — on the host (ssh agent@…):
node ~/agent-system/tools/rag/rag.js ingest <file.pdf> --title "..." --author "..." --domain <d>

# documentation sites — via the proxy, from inside a container:
#   many URLs make ONE source; each chunk keeps its own page URL for citation
node /workspace/extra/tool-exec.js rag ingest <url> [<url> ...] \
  --title "..." --author "..." --domain <d> --layer <architecture|patterns|design-tokens> \
  --framework <vue|react|agnostic|…>

node /workspace/extra/tool-exec.js rag refresh <source_id|title>   # re-fetch, re-chunk, re-embed
node /workspace/extra/tool-exec.js rag set-meta <source_id> --layer <l> --framework <f>
node /workspace/extra/tool-exec.js rag remove <source_id|title>    # confirm-gated: dry-run + token
node /workspace/extra/tool-exec.js rag list
node /workspace/extra/tool-exec.js rag stats
```

Rules that keep the index worth trusting:

- **Prose, not raw code.** From a repo take `docs/`, `README`, `*.md`; skip `src/`, tests,
  `node_modules`.
- **Chunked by heading** (H1/H2/H3) — one chunk, one concept. Never fixed-size splits.
- **Deduplicated by URL.** A URL already in the index is refused; `refresh` it instead of
  ingesting a second copy. `refresh` keeps the source id, so existing citations still resolve.
- **Curated URL manifests** live on the host at `agent-system/tools/rag/sources/*.txt`, one
  file per source — that is what a refresh re-fetches, and where a page is added or dropped.
- **Fast-moving framework docs are not stored long-term** (release notes, provider-specific
  OAuth docs). Fetch those fresh at task time and cite the version you read.

`ingest`, `refresh`, `set-meta` and `remove` are classified as **writes** by the tool proxy and
are audit-logged; `remove` additionally requires a confirmation token.
