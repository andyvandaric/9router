---
name: second-brain-governance
trigger: model_decision
description: "Authoritative ACS Sovereign Second Brain memory governance: single DB, contentless code index, hippocampus recall, dual done-path sync, safe purge, unidirectional dependencies."
---

# Second Brain Governance

Authoritative governance for the ACS Sovereign Second Brain (`acs-memory`). All agents writing to, reading from, or indexing memory MUST comply. Violations are audit findings.

---

## Invariant 1: Single Sovereign DB

- The sole memory database is `acs-memory.db`, resolved exclusively via `cliconfig.MemoryDBPath()` (`ACS_MEMORY_DB` override, else `~/.acs/memory/acs-memory.db`).
- `acs-memory.db` is isolated from the research cache `articles.db`. Never read research articles as memory entries or write memory entries into the articles store.
- DO NOT author local `*MemoryDBPath()` resolvers in any package. Consume the `cliconfig` facade.
- Env-scoped runs MUST NOT cross-contaminate prod memory: dev/staging callers resolve their own data dir; purge/sync gates verify the target path before mutation.

## Invariant 2: Contentless Code Indexing

- The code index stores metadata only (path, symbol, trigram tokens). Indexed rows carry `content=''` — zero bytes of source code persist in the DB.
- Sync is hybrid delta: pre-query mtime drift check refreshes stale files before FTS MATCH; full reindex is a fallback, not the default path.
- `search_code` requires `query` of minimum 3 chars. `limit` is clamped to max 50, never rejected.
- DO NOT persist file bodies, diffs, or secrets into code index rows to "speed up" recall.

## Invariant 3: Hippocampus Instant Recall Hook

- On user prompt submit, the hippocampus hook injects relevant memory context automatically with a `<0.5ms` budget on cache hit.
- Recall is read-only: the hook MUST NOT write entries, mutate ranks, or trigger reindex during injection.
- On miss or timeout, the hook degrades to empty context. It MUST NOT block the prompt pipeline or surface errors to the user.
- Agents MUST NOT bypass recall by re-implementing ad-hoc memory prefetch in prompts.

## Invariant 4: Dual Done-Path Task Sync

- Every completed task is recorded to the DB via the dual done-path: Kanban status transition to `done` AND blueprint `walkthrough_content` sync.
- `TaskCompletion` records carry `task_id`, `project`, `title`, `blueprint_path`, `plan_content`, and `walkthrough_content`. Empty plan/walkthrough content is rejected at sync time.
- Agents MUST NOT mark tasks `done` in chat without the DB sync landing. A `done` claim without a stored entry is an unverified claim.
- Retries on sync failure use bounded backoff; duplicate completions are deduplicated by `task_id`, never double-inserted.

## Invariant 5: Two-Phase Safe Purge

- Purging legacy markdown memory is a two-phase operation: Phase 1 writes a restorable tarball backup; Phase 2 deletes the source files.
- Purge MUST verify backup integrity (tarball exists, non-empty, lists expected entries) before any delete executes.
- Destructive patterns (`rm`, `delete`, `truncate`, `reset`) require explicit user confirmation per investigation discipline.
- If verification fails, the purge aborts with state unchanged. Blind retry of the delete phase is forbidden.

## Invariant 6: Unidirectional Dependencies

- Dependency direction is strictly `agentic -> memory`. The `memory` package MUST NOT import `agentic`, `server`, or daemon lifecycle packages.
- Shared path/config resolution flows through `cliconfig` only. `memory` MUST NOT resolve env vars or ports directly.
- New imports into `memory` require a cycle check (`go list` / `go vet`). Introducing a circular import is a blocking defect.
- Test helpers live inside `memory` test files. Exporting test-only hooks for external packages is forbidden.

## Invariant 7: Legacy OMC Unwiring

- All OMC flat-file memory routines (`.omc/notepad.md`, `.omc/project-memory.json`, `.omc/shared-memory/`, `.omc/wiki/` direct writes) are DEPRECATED. All memory writes MUST route through `acs-memory.db` (SQLite WAL).
- Legacy endpoints serve read-only compat shims (`/api/omc/*` with `X-ACS-Deprecated` header). Direct writes to flat-file memory paths MUST be rejected.
- `disallowed_tools` in tool-profiles SHALL enforce the lockout. Agents MUST NOT reintroduce flat-file memory writers to bypass the DB.

## Invariant 8: Code Search Primacy

- `search_code` (SQLite FTS trigram, sub-10ms) is the Tier 1 primary code search. Agents MUST query `search_code` before falling back to text search.
- `Grep`/`Glob` are fallback only when `search_code` returns zero hits or the query is a raw regex unsuited to trigram. Fallback usage MUST be justified by the miss, never the default path.
- Personas MUST declare this hierarchy in their Investigation Protocol blocks. Omitting the hierarchy is an audit finding.

---

## CLI Command Dictionary (`acs memory`)

The `acs memory` CLI command suite provides sovereign control over the Second Brain SQLite WAL database:

| Subcommand | Syntax / Flags | Description & Operational Contract |
|---|---|---|
| status, summary | acs memory status [--json] / acs memory summary [--json] | Displays Second Brain telemetry: active vs. superseded entries, category counts (decision, convention, pattern, etc.), code index footprint (code_files, code_lines), and SQLite WAL database size. |
| `prune` | `acs memory prune [--dry-run] [--force] [--days=<N>] [--category=<cat>]` | Evicts expired TTL entries (`expires_at < now`) and purges obsolete superseded entries beyond retention window (default 30 days). Defaults to safe `--dry-run`; `--force` executes actual DB deletion. |
| `sync` | `acs memory sync` | Reconciles and verifies memory index in SQLite WAL (`acs-memory.db`). Deprecated physical markdown creation (`.omc/wiki/MEMORY.md`) to prevent dual SSOT and git working tree drift. |
| `unwire` | `acs memory unwire [--path=<dir>] [--dry-run] [--archive-dir=<dir>]` | Scans legacy flat-file memory paths (`~/.claude/projects/.../memory/*.md`, `.omc/wiki/*.md`, `.claude/memory/*.md`, `.omc/notepad.md`, `.omc/project-memory.json`), ingests via Unified Pipeline (`IngestEntry` with Tier 1 SHA256 dedupe), archives originals to compressed `.tar.gz` in `.omc/archive/`, overwrites physical files with non-destructive `StandardTombstone`, and places `.unwired` sentinel file. |
| `graph` | `acs memory graph [--limit=<N>] [--offset=<N>]` | Dumps knowledge relation graph (`memory_relations`) in JSON format, containing semantic edges (`supersedes`, `superseded_by`, `contradicts`, `contradicted_by`, `relates_to`) populated with `from_title` and `to_title`. |
| `code-search` | `acs memory code-search <query> [--path-filter=<prefix>] [--limit=<N>]` | Instant (<10ms) Tier 1 Primary code search via FTS5 trigram tokenization. Automatically filters minified bundles (`dist/`, `build/`, `node_modules/`, `.git/`), resolves multi-root paths, and yields 3-line contextual snippets. Zero source code persisted in DB. |
| `migrate` | `acs memory migrate [--source=<dir>]` | Batch migrates legacy markdown files into SQLite WAL with metadata extraction (frontmatter title, summary, tags, content). |
| `index-code` | `acs memory index-code [--path=<dir>]` | Re-scans workspace directory and incrementally indexes file trigram tokens into virtual table `code_fts` based on SHA256 and modification time checks. |

---

## SQLite WAL Database Schema (`acs-memory.db`)

All persistent Second Brain data resides in `~/.acs/memory/acs-memory.db` (or `ACS_MEMORY_DB` override) operating exclusively in SQLite WAL mode (`PRAGMA journal_mode = WAL`, `PRAGMA synchronous = NORMAL`, `PRAGMA mmap_size = 268435456`, `PRAGMA cache_size = -8000`):

### 1. Table `memory_entries` (Core Sovereign Records)
Primary relational store for all persistent engineering knowledge, architecture decision records, and task walkthroughs.

```sql
CREATE TABLE IF NOT EXISTS memory_entries (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    project_slug        TEXT NOT NULL,                      -- Project isolation identifier (default: "acs")
    category            TEXT NOT NULL,                      -- "decision", "convention", "pattern", "reference", "session-log", "architecture", "debugging"
    title               TEXT NOT NULL,                      -- Concise descriptive title
    summary             TEXT,                               -- High-density executive summary
    content             TEXT,                               -- Full markdown or text payload
    blueprint_path      TEXT,                               -- Path to PRD blueprint if task-linked
    task_id             TEXT,                               -- Kanban task identifier if task-linked
    related_article_ids TEXT,                               -- JSON array of linked research article IDs
    tags                TEXT,                               -- Comma/whitespace separated keywords
    is_active           INTEGER NOT NULL DEFAULT 1,         -- 1 = active record, 0 = superseded / expired
    status              TEXT NOT NULL DEFAULT 'active',     -- "active", "superseded", "expired"
    superseded_by       INTEGER DEFAULT NULL,               -- Foreign ID of superseding memory entry
    ttl_seconds         INTEGER NOT NULL DEFAULT 0,         -- Time-To-Live in seconds (0 = persistent forever)
    expires_at          INTEGER DEFAULT NULL,               -- Unix epoch timestamp when entry expires
    content_sha         TEXT DEFAULT NULL,                  -- SHA256 content hash for Tier 1 deduplication (<0.01ms)
    title_norm          TEXT DEFAULT NULL,                  -- Lowercase normalized title for trigram matching
    supersede_reason    TEXT DEFAULT NULL,                  -- "title_trigram_match", "multi_tag_and_title_similarity", "semantic_contradiction", "explicit"
    created_at          INTEGER NOT NULL,                   -- Unix epoch creation timestamp
    updated_at          INTEGER NOT NULL                    -- Unix epoch modification timestamp
);

-- Performance Indexes
CREATE INDEX IF NOT EXISTS idx_memory_entries_slug_updated ON memory_entries(project_slug, updated_at);
CREATE INDEX IF NOT EXISTS idx_memory_entries_category ON memory_entries(category);
CREATE INDEX IF NOT EXISTS idx_memory_entries_active ON memory_entries(is_active, category);
CREATE INDEX IF NOT EXISTS idx_memory_entries_status ON memory_entries(status);
CREATE INDEX IF NOT EXISTS idx_memory_entries_expires_at ON memory_entries(expires_at);
CREATE INDEX IF NOT EXISTS idx_memory_entries_sha ON memory_entries(project_slug, content_sha);
```

### 2. Virtual Table `memory_fts` (Full-Text Search)
FTS5 external content table indexed over `title`, `summary`, `content`, and `tags`:

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    title,
    summary,
    content,
    tags,
    content='memory_entries',
    content_rowid='id'
);
```

### 3. Table `memory_relations` (Semantic Knowledge Graph)
Stores directed semantic and lifecycle edges linking memory entities:

```sql
CREATE TABLE IF NOT EXISTS memory_relations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id    INTEGER NOT NULL,                            -- Source memory entry ID
    to_id      INTEGER NOT NULL,                            -- Target memory entry ID
    relation   TEXT NOT NULL,                               -- "supersedes", "superseded_by", "contradicts", "contradicted_by", "relates_to"
    created_at INTEGER NOT NULL                             -- Unix epoch timestamp
);

CREATE INDEX IF NOT EXISTS idx_memory_relations_pair ON memory_relations(from_id, to_id);
```

### 4. Code Indexing Tables (`code_files`, `code_lines`, `code_fts`)
Contentless trigram indexing engine providing sub-10ms code search without persisting source files in DB:

```sql
CREATE TABLE IF NOT EXISTS code_files (
    path  TEXT PRIMARY KEY,                                 -- Relative file path
    mtime INTEGER NOT NULL,                                 -- Last modified timestamp
    sha   TEXT NOT NULL                                     -- File content SHA256
);

CREATE TABLE IF NOT EXISTS code_lines (
    rowid INTEGER PRIMARY KEY,
    path  TEXT NOT NULL,                                    -- Associated file path
    line  INTEGER NOT NULL                                  -- Line number (1-indexed)
);

CREATE VIRTUAL TABLE IF NOT EXISTS code_fts USING fts5(
    path,
    line UNINDEXED,
    text,
    tokenize='trigram',
    content=''                                              -- Zero source code persisted
);
```

### 5. Table `memory_query_cache` (Synaptic Memory Recall Cache)
High-speed lookup cache delivering sub-0.2ms recall for frequent search queries and hippocampus hooks:

```sql
CREATE TABLE IF NOT EXISTS memory_query_cache (
    query_hash       TEXT PRIMARY KEY,                      -- Normalized query hash
    query_text       TEXT NOT NULL,                         -- Original query string
    digest_json      TEXT NOT NULL,                         -- Pre-computed search digest JSON payload
    hit_count        INTEGER NOT NULL DEFAULT 1,            -- Frequency counter for synaptic potentiation
    last_accessed_at INTEGER NOT NULL,                      -- Unix epoch timestamp of last cache hit
    created_at       INTEGER NOT NULL                       -- Unix epoch timestamp of cache creation
);
```

---

## Native MCP Tools (`mcpacs`)

Agents interact with the Second Brain SQLite WAL database directly via 6 native MCP tools under `plugin:acs:core`:

| Tool Name | Parameters | Purpose |
|---|---|---|
| `search_memory` | `{"query": "...", "category": "...", "limit": 10}` | Search ACS memory via FTS5 full-text search. |
| `read_memory` | `{"id": 123, "slug": "..."}` | Read persistent memory entry by ID or slug. |
| `save_memory` | `{"title": "...", "category": "...", "content": "...", "tags": "..."}` | Save structured memory entry with optional TTL. |
| `get_memory_graph` | `{"limit": 10, "offset": 0}` | Get semantic memory relations graph (nodes and edges). |
| `prune_memory` | `{"dry_run": true\|false}` | Trigger memory TTL expiry and scratchpad purge. |
| `memory_summary` | `{}` | In-process instant SQLite WAL memory telemetry (<0.1ms query, sub-5ms MCP). |

---

## Invariant 9: Memory Recall Path Discipline

- `get_memory_graph` is ONLY for relation-graph analysis (edges: `supersedes`, `contradicts`, `relates_to`). It MUST NOT be used for topic recall.
- Topic recall MUST use `search_memory` with a short query (<= 6 words) and a small `limit`, then `read_memory` per returned ID for full content.
- Shell / curl / REST fallback for memory recall is STRICTLY FORBIDDEN when native MCP tools (`search_memory`, `read_memory`) are operational.
- The default `get_memory_graph` limit stays small (<= 10). Fetching the full graph to "find" a topic is forbidden.
<!-- ACS workflow v1.33.0+0fda488 -->
