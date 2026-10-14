---
name: mcp-governance
trigger: always_on
description: "MCP tool selection matrix, 4-tier browser synergy, anti-bot tiers, and lazy-loading best practices."
---

# MCP Tool Selection Matrix & Browser Automation Governance

Authoritative standard for selecting tools across built-in capabilities, ACS MCP servers, and browser automation engines to maximize token efficiency, accuracy, and anti-bot reliability.

---

## 0. Authoritative 4-Tier Execution Hierarchy (Speed & Latency Invariant)

All agents and models across the ACS ecosystem MUST strictly adhere to the ratified 4-tier execution speed hierarchy:

> **Tie-breaker:** Native acs:core stdio (mcp__plugin_acs_core__*) selalu pertama, REST :20130 hanya saat stdio down, namespace lama terpisah hanya untuk Antigravity IDE.

1. **Tier 1 (Primary for Agents / Zero-Shell)**: Native MCP Tools `acs:core`
   - **Tools**: `kanban_update`, `kanban_artifacts`, `kanban_summary`, `kanban_card_by_ref`, `kanban_create`, `kanban_claim_files`, `kanban_list`, `search_memory`, `read_memory`, `save_memory`, `get_memory_graph`, `prune_memory`, `memory_summary`, `search_code`, `searchGitHub`, `web_search_exa`, `deep_research_exa`, `answer_exa`, `resolve-library-id`, `query-docs`, `lsp_*` (all via `acs:core`), etc.
   - **Latency**: <2ms (Invoked directly via persistent stdio RPC, 0x shell spawn overhead). MANDATORY primary choice for all agents!
   - **Anti-Raw-Shell Query Rule**: Sub-agents MUST NOT use raw shell tools (`find`, `grep`, `cat`, `curl` via Bash) to query code or project context. Always use Tier 1 Native MCP Tools.
2. **Tier 2 (CLI Fastpath)**: Binary Subcommands `acs ...`
   - **Commands**: `acs kanban summary`, `acs kanban create`, `acs kanban card`, `acs kanban artifacts`, `acs memory summary`, `acs memory code-search`, `acs stack status`, `acs adopt`.
   - **Latency**: 5-15ms (1x process spawn, in-process SQLite WAL, structured ANSI table output).
3. **Tier 3 (Direct Cache / Local Store)**: Direct SQLite WAL
   - **Access**: In-memory FTS5 queries and local synthesized article cache (`acs-memory.db`, `articles.db`). Latency <0.05ms in-memory.
4. **Tier 4 (Last-Resort Fallback ONLY)**: Stateless HTTP REST via `curl` (:20130)
   - **Latency**: 50-250ms (slowest path due to subshell spawn + curl process fork + TCP socket handshake).
   - **STRICT PROHIBITION**: STRICTLY FORBIDDEN whenever Tier 1 and Tier 2 are operational! Reserved exclusively as an emergency circuit breaker when the native MCP stdio transport is completely unavailable.

---

## 1. Information Retrieval & Research Matrix

| Requirement | Primary Tool | Fallback / Alternative | Scope & Rationale |
|---|---|---|---|
| **Fast & General Web Queries** | `acs:core` (`mcp__plugin_acs_core__web_search_exa`, `mcp__plugin_acs_core__answer_exa`) | `acs-search-rest` skill (Tier-4 REST `:20130`, stdio-down only) | Fast, low token cost, suitable for current news or quick factual lookups. |
| **Architectural Research & Deep Synthesis** | `acs:core` (`mcp__plugin_acs_core__deep_research_exa`, `mcp__plugin_acs_core__read_research_article`) | `acs-search-rest` skill (Tier-4 REST `:20130`, stdio-down only) | Semantic search via Exa, curated domains, deduplication, and structured synthesized digests. |
| **Library / Framework / SDK Documentation** | `acs:core` (`mcp__plugin_acs_core__resolve-library-id` -> `mcp__plugin_acs_core__query-docs`) | `acs-docs-rest` skill (Tier-4 REST `:20130`, stdio-down only) | Official, up-to-date documentation (React, Fiber, Tailwind, Next.js, Prisma, etc.). Prevents deprecated API hallucinations. |
| **Real-World Code Patterns (GitHub)** | `acs:core` (`mcp__plugin_acs_core__searchGitHub` via grep.app) | `acs-codesearch-rest` skill (Tier-4 REST `:20130`, stdio-down only) | Searches literal syntax/regex across millions of public GitHub repositories for battle-tested production patterns. |
| **Local Repository Code Search** | `acs:core` (`mcp__plugin_acs_core__search_code`, SQLite FTS trigram, sub-10ms) | `Grep` (content-only) / `Glob` (file-discovery) fallback on zero hits or regex patterns | `mcp__plugin_acs_core__search_code` is Tier 1 primary. Query it first; fall back to `Grep` (content-only) / `Glob` (file-discovery) only on zero hits or regex patterns. |

### 1.1 Overview of 9 `acs:core` Search Sub-Tools

The `acs:core` search sub-tools run as standalone runtime responses producing structured responses optimized without raw HTML bloat:

| Sub-Tool | Primary Use Case | Response Characteristics | Key Parameters |
|---|---|---|---|
| **`answer_exa`** | Direct factual Q&A without browsing multiple links. | Concise text answer directly addressing the question. | `query`: string, `text`: true |
| **`web_search_exa`** | General semantic web search requiring multi-source summaries. | Structured digest containing titles, verified URLs, and snippets. | `query`: string, `numResults`: int |
| **`deep_research_exa`** | Comprehensive architectural research and technology comparisons. | In-depth synthesized reports spanning multiple domains. | `query`: string, `detail_level`: "comprehensive" |
| **`entity_search_exa`** | Company, startup, product, or organizational profiling. | Structured profiles (overview, founders, funding, capabilities). | `query`: string, `category`: "company" / "research" |
| **`find_similar_exa`** | Discovering alternatives, similar libraries, or competitor URLs. | Comparative functional analysis and alternative references. | `url`: string |
| **`web_fetch_exa`** | Extracting clean text from specific URLs without HTML noise. | Pure Markdown eliminating markup and script garbage. | `urls`: string[] |
| **`agent_research_exa`** | Autonomous multi-step research requiring chain-of-thought analysis. | Multi-stage structured investigative reports. | `query`: string, `maxWaitSeconds`: int |
| **`read_research_article`** | Consuming pre-synthesized research articles from local SQLite stores. | Zero-latency local responses without network consumption. | `id` / `slug`: string |
| **`list_research_articles`** | Browsing the local catalog of synthesized research articles. | Indexed catalog listing (titles, topics, synthesis dates). | `limit`: int, `query`: string |

### Search Anti-Patterns
- ❌ DO NOT use general web search for library documentation available via `acs:core` (`query-docs`).
- ❌ DO NOT extract URLs using browser scrapers when text content alone is required; use `web_fetch_exa`.
- ❌ DO NOT use `searchGitHub` for high-level conceptual questions; supply concrete code patterns or literal regexes.
- ❌ **Grep/Search with File Path Patterns**: NEVER use `Grep` or `Search` with glob or path patterns (e.g. `**/*.md`, `scripts/*.js`, `agentic-stack/**/*.md`). Grep searches file content only and will timeout on monorepos. ALWAYS use `Glob` for file and path discovery.

---

## 2. Browser Automation Synergy & Anti-Bot Tiers (Single Source of Truth)

Browser automation hierarchy structured by interactivity level and target defenses:

```text
[Visual Screen / DevTools]      -> Tier 0: Built-in Chrome DevTools
[Headless Background]           -> Tier 1: ACS Browser (CloakBrowser MCP)
[Hardened Anti-Bot Fingerprint] -> Tier 2: Camoufox (Stealth Firefox Fork)
[Interactive Captcha Bypass]    -> Tier 3: SeleniumBase UC Mode
```

| Tier | Engine / Tool | Characteristics & Protocol | Use Cases |
|---|---|---|---|
| **Tier 0** | **Built-in Chrome DevTools** | - Desktop visible window<br>- Full DOM access & CSS inspection<br>- Zero stealth overhead | - Local UI visual debugging (SolidJS/Vite)<br>- CSS layout, font, responsiveness audits<br>- Interactive user co-browsing |
| **Tier 1** | **ACS CloakBrowser (`acs:core` browser sub-tools)** | - Headless Chromium + Playwright<br>- Local REST daemon (:20130 / :20150)<br>- 80 tools: route intercept, cookies, OCR, tracing, storage, persistent profiles<br>- Cloak stealth layer (fingerprints, timezones, locales) | - Standard to moderate background scraping<br>- Form submissions, DOM snapshots, OCR, PDF generation<br>- Automated tasks without intrusive window popups<br>- Standard Cloudflare / basic bot detection |
| **Tier 2** | **Camoufox Engine** | - Anti-detect Firefox C++ fork<br>- Morphing TLS JA3/JA4, Canvas, WebGL, AudioContext, Font enumeration<br>- Non-Chromium signature | - Targets with aggressive Cloudflare Turnstile, Datadome, Akamai, or Kasada blocking Chromium CDP runtimes |
| **Tier 3** | **SeleniumBase (UC Mode)** | - Undetected-ChromeDriver + CDP reconnection<br>- PyAutoGUI humanized mouse movements<br>- reCAPTCHA v2/v3 & Turnstile click solutions | - Active interstitial verification captchas requiring humanized mouse interaction and advanced evasion |

### Integration Status
- `acs:core` browser sub-tools are the primary active driver for all agentic browser automation.
- `camoufox` and `seleniumbase` serve as host-level fallbacks when Tier 1 encounters bot defense blocks.

### 2.1 Dynamic Headed/Headless Mode Switching & Persistent Profiles (SSOT)
- **Runtime Mode Toggle Endpoint**:
  - `POST htt{{PROJECT_ROOT}}/127.0.0.1:20130/api/mcp/browser/mode` (Prod) / `:20150` (Dev).
  - Payload: `{"headed": true, "profileName": "uikode-profile"}`.
  - Toggles between `--headless` and `--headed` with dynamic argument injection (`--caps all --headed --profile-dir <path>`).
- **Standardized Profile Isolation**:
  - Profiles are stored under `~/.acs/acs-browser-data/<profileName>`.
  - Windows DPAPI encryption protects cookies and credentials within the profile directory.
- **Human-in-the-Loop Co-Automation**:
  - When 2FA or interactive login is required on protected web apps (e.g. `/uiadm`), the agent toggles to `--headed`.
  - The browser window is brought to the foreground (`ShowWindow`, `SetForegroundWindow`).
  - Human user assists with login/OTP; agent retains full automation control and verifies state via MCP tools (`browser_snapshot`, `browser_click`, etc.).
- **Reaper Exemption & Warm-Up**:
  - Active headed sessions are automatically exempted from the 30-minute idle reaper to preserve human sessions during debugging.
  - On toggle to headed mode, the daemon automatically performs background warm-up navigation to trigger Chromium's UI initialization.

---

## 3. Code Navigation: Native Tools vs `acs:core` LSP Sub-Tools

| Feature | Tier 1 Primary (`search_code`) | ACS LSP sub-tools (`acs:core`) | Selection Rule |
|---|---|---|---|
| **String & Pattern Scans** | `search_code` (`acs-memory`, SQLite FTS trigram, sub-10ms) | `Grep` (content-only fallback) | `search_code` MUST be queried first. Fall back to `Grep` (content-only) only on zero hits or regex patterns. Use for initial exploration, log messages, comments, and configuration content. Use `Glob` for filename and path discovery. |
| **Symbol Definition & Jumps** | `search_code` (text search) / Native Grep | `acs:core` (`lsp_definition`) | `search_code` is primary for text search; `acs:core` LSP sub-tools are primary for AST symbols. Use `acs:core` (`lsp_definition`) when accurate semantic AST jumps across complex Go packages or TypeScript projects are required. |
| **Type Checking & Diagnostics** | Compilers (`go vet`, `bun test`) | `acs:core` (`lsp_diagnostics`) | Use `acs:core` (`lsp_diagnostics`) during large refactoring tasks to verify type consistency without running full build cycles. |
| **Workspace Symbols** | `search_code` | `acs:core` (`lsp_workspace_symbols`) | Query `search_code` first; use `acs:core` (`lsp_workspace_symbols`) when tracing interface implementations across disparate packages. |

---

## 4. Context Window Protection & Lazy-Loading Best Practices

MCP tool schemas introduce significant context overhead. `acs:core` browser sub-tools number 80 tools; loading them eagerly consumes substantial prompt context.

### Golden Rules for Token Conservation:
1. **Default to Lazy Loading**:
   - Non-critical MCP tools MUST be loaded lazily (full schemas retrieved only upon explicit tool invocation).
   - DO NOT expose bulk scraping or specialized browser tools in the primary eager context unless essential.
2. **Targeted Scoping**:
   - DO NOT dump entire page DOM strings into the prompt context when a single element is needed.
   - Use focused CSS selectors, `browser_verify_element_visible`, or targeted snapshots.
3. **Payload Sanitization**:
   - When fetching research via `acs:core` search sub-tools, use `detail_level: "short"` or `"normal"`. Reserve `"comprehensive"` strictly for exhaustive architectural audits.
4. **Session & Tab Cleanup**:
   - Close tabs and browser sessions (`browser_close`) upon task completion to prevent memory leaks in background daemons.

---

## 5. Stdio Process Lifecycle & Idle Auto-Sleep

- **Automated Memory Reclamation**: MCP stdio servers driving heavy engines (`acs:core` browser sub-tools / Chromium) are supervised by an idle reaper with a 30-minute timeout.
- **Idle Sleep Execution**: If zero `tools/call` invocations occur within 30 minutes, stdio processes are terminated cleanly (`s.sleep()`), freeing Chromium and Node.js resources back to the operating system.
- **Transparent Lazy Awakening**: Tool registrations persist in catalog registries. Incoming tool requests wake sleeping servers instantly without loss of functionality.
- **Heap Clamping Enforcement**: Node.js stdio servers spawned by bridges inherit `NODE_OPTIONS="--max-old-space-size=2048"` via `executil.ClampNodeMemoryLimit`.
<!-- ACS workflow v1.6.1+ca3ddd2 -->

---

## 6. Native Stdio Plugin Harness (`plugin:acs:core`) & On-Demand Architecture

Starting in v1.18.0, Claude Code operates via the native plugin harness (`.claude-plugin/plugin.json`) invoking `acs mcp serve` via in-process Stdio IPC (0 TCP ports):

### 6.1 Bundled tools (37 active + 8 session-bus FROZEN = 45 catalog) under `acs:core`

| Group | Count | Tools (`mcp__plugin_acs_core__*`) |
|---|---|---|
| Memory | 6 | `search_memory`, `read_memory`, `save_memory`, `get_memory_graph`, `prune_memory`, `memory_summary` |
| Search & Research | 9 | `answer_exa`, `web_search_exa`, `deep_research_exa`, `web_fetch_exa`, `find_similar_exa`, `entity_search_exa`, `agent_research_exa`, `read_research_article`, `list_research_articles` |
| Code | 2 | `search_code`, `searchGitHub` |
| Documentation | 2 | `resolve-library-id`, `query-docs` |
| Kanban | 7 | `kanban_list`, `kanban_create`, `kanban_update`, `kanban_artifacts`, `kanban_claim_files`, `kanban_card_by_ref`, `kanban_summary` |
| Knowledge Base | 3 | `knowledge_search`, `knowledge_get`, `knowledge_topics` |
| Language Server (LSP) | 8 | `lsp_definition`, `lsp_references`, `lsp_hover`, `lsp_document_symbols`, `lsp_workspace_symbols`, `lsp_diagnostics`, `lsp_install`, `lsp_status` |
| Session Bus (FROZEN) | 8 | `bus_sessions`, `bus_send`, `bus_broadcast`, `bus_inbox`, `bus_lock`, `bus_unlock`, `bus_whoami`, `bus_heartbeat` |

> **Notes:** Session-bus tools are FROZEN (DM-only awareness; never invoke bus.db/heartbeat via tools). The 80 CloakBrowser tools are isolated on demand (see §6.2), not in the eager catalog.

### 6.2 On-demand browser isolation (token budget)

The 80 CloakBrowser tools (`mcp__plugin_acs_core__browser_*`, `mcp__plugin_acs_core__cloak_*`) are excluded from root turn context and isolated
on demand to `acs-browser-agent` (sole EAGER owner) via `/browser --engine=cloak|camoufox|selenium`.
All other agents reach browser automation only by delegating to `acs-browser-agent`.
This preserves the prompt token budget (<2.3k tokens vs 20k+ for eager loading).
Load browser schemas lazily only upon explicit invocation (see Section 4).

### 6.3 Dual-track invariant

- **Claude Code CLI**: native Stdio Plugin Harness (`plugin:acs:core`), 0 TCP ports.
- **Antigravity IDE (`~/.gemini/`) and non-Claude consumers**: HTTP endpoints on port `:20130`.
- Legacy `mcp__acs-search__*`, `mcp__acs-memory__*`, `mcp__acs-docs__*`, `mcp__acs-codesearch__*` HTTP namespaces are preserved on `:20130` exclusively for Antigravity IDE.

---

## 7. Legacy → `acs:core` Alias Table (Single Source of Truth)

One row per tool. New FQN prefix is always `mcp__plugin_acs_core__`. Triggers are ID / EN.

| New `acs:core` tool | Old namespace | Owner EAGER agent | Mode | Triggers ID / EN |
|---|---|---|---|---|
| `answer_exa` | `mcp__acs-search__answer_exa` | acs-researcher | eager | jawab cepat / quick answer |
| `web_search_exa` | `mcp__acs-search__web_search_exa` | acs-researcher | eager | cari web / web search |
| `deep_research_exa` | `mcp__acs-search__deep_research_exa` | acs-researcher | eager | riset mendalam / deep research |
| `web_fetch_exa` | `mcp__acs-search__web_fetch_exa` | acs-researcher | eager | ambil isi URL / fetch URL content |
| `find_similar_exa` | `mcp__acs-search__find_similar_exa` | acs-researcher | eager | cari URL serupa / find similar URLs |
| `entity_search_exa` | `mcp__acs-search__entity_search_exa` | acs-researcher | eager | profil perusahaan / company profile |
| `agent_research_exa` | `mcp__acs-search__agent_research_exa` | acs-researcher | eager | riset otonom / autonomous research |
| `read_research_article` | — (new in `acs:core`) | acs-researcher | eager | baca artikel lokal / read local article |
| `list_research_articles` | — (new in `acs:core`) | acs-researcher | eager | daftar artikel / list articles |
| `kanban_list` | `mcp__acs__kanban_list` | lead-orchestrator, division-pm, sprint-manager | eager | daftar tugas / list tasks |
| `kanban_create` | `mcp__acs__kanban_create` | lead-orchestrator, division-pm, sprint-manager | eager | buat kartu / create card |
| `kanban_update` | `mcp__acs__kanban_update` | lead-orchestrator, division-pm, sprint-manager | eager | ubah status / update status |
| `kanban_artifacts` | `mcp__acs__kanban_artifacts` | lead-orchestrator, division-pm, sprint-manager | eager | sinkron bukti / sync evidence |
| `kanban_claim_files` | `mcp__acs__kanban_claim_files` | lead-orchestrator, division-pm, sprint-manager | eager | klaim file / claim files |
| `kanban_card_by_ref` | `mcp__acs__kanban_card_by_ref` | lead-orchestrator, division-pm, sprint-manager | eager | cari kartu / resolve card |
| `kanban_summary` | `mcp__acs__kanban_summary` | lead-orchestrator, division-pm, sprint-manager | eager | ringkasan papan / board summary |
| `search_memory` | `mcp__acs-memory__search_memory` | lead-orchestrator, code workers (16) | eager | ingat keputusan / recall decisions |
| `read_memory` | `mcp__acs-memory__read_memory` | lead-orchestrator | eager | baca memori / read memory |
| `save_memory` | `mcp__acs-memory__save_memory` | lead-orchestrator, code workers (16) | eager | simpan pelajaran / save learning |
| `get_memory_graph` | `mcp__acs-memory__get_memory_graph` | lead-orchestrator | eager | graf relasi / relation graph |
| `prune_memory` | `mcp__acs-memory__prune_memory` | lead-orchestrator | eager | bersihkan memori / prune memory |
| `memory_summary` | `mcp__acs-memory__memory_summary` | lead-orchestrator, division-pm, sprint-manager | eager | ringkasan memori / memory summary |
| `search_code` | `mcp__acs__search_code` | acs-code-intel, code workers (16) | eager | cari kode / search code |
| `searchGitHub` | `mcp__acs-codesearch__searchGitHub` | acs-code-intel | eager | pola GitHub / GitHub patterns |
| `resolve-library-id` | `mcp__acs-docs__resolve-library-id` | acs-docs-agent | eager | cari docs / find library docs |
| `query-docs` | `mcp__acs-docs__query-docs` | acs-docs-agent | eager | dokumentasi versi terbaru / latest version docs |
| `knowledge_search` | `mcp__acs__knowledge_search` | lead-orchestrator (shared Tier-1) | eager | cari wiki / search wiki |
| `knowledge_get` | `mcp__acs__knowledge_get` | lead-orchestrator (shared Tier-1) | eager | baca artikel / get article |
| `knowledge_topics` | `mcp__acs__knowledge_topics` | lead-orchestrator (shared Tier-1) | eager | daftar topik / list topics |
| `lsp_definition` | `mcp__acs-lsp__lsp_definition` | acs-code-intel | eager | definisi simbol / symbol definition |
| `lsp_references` | `mcp__acs-lsp__lsp_references` | acs-code-intel | eager | siapa memanggil / find callers |
| `lsp_hover` | `mcp__acs-lsp__lsp_hover` | acs-code-intel | eager | info tipe / type info |
| `lsp_document_symbols` | `mcp__acs-lsp__lsp_document_symbols` | acs-code-intel | eager | struktur file / file outline |
| `lsp_workspace_symbols` | `mcp__acs-lsp__lsp_workspace_symbols` | acs-code-intel | eager (devtools-optimizer: on-demand) | simbol workspace / workspace symbols |
| `lsp_diagnostics` | `mcp__acs-lsp__lsp_diagnostics` | acs-code-intel | eager (devtools-optimizer: on-demand) | cek error compiler / check compiler errors |
| `lsp_install` | `mcp__acs-lsp__lsp_install` | acs-code-intel, devtools-optimizer | eager | pasang server / install server |
| `lsp_status` | `mcp__acs-lsp__lsp_status` | acs-code-intel, devtools-optimizer | eager | status server / server status |
| `browser_navigate` | `mcp__acs-browser__browser_navigate` | acs-browser-agent only | on-demand (`/browser --engine`) | buka halaman / open page |
| `browser_snapshot` | `mcp__acs-browser__browser_snapshot` | acs-browser-agent only | on-demand (`/browser --engine`) | potret DOM / DOM snapshot |
| `browser_click` | `mcp__acs-browser__browser_click` | acs-browser-agent only | on-demand (`/browser --engine`) | klik elemen / click element |
| `browser_type` | `mcp__acs-browser__browser_type` | acs-browser-agent only | on-demand (`/browser --engine`) | ketik teks / type text |
| `browser_fill_form` | `mcp__acs-browser__browser_fill_form` | acs-browser-agent only | on-demand (`/browser --engine`) | isi form / fill form |
| `browser_select_option` | `mcp__acs-browser__browser_select_option` | acs-browser-agent only | on-demand (`/browser --engine`) | pilih opsi / select option |
| `browser_hover` | `mcp__acs-browser__browser_hover` | acs-browser-agent only | on-demand (`/browser --engine`) | arahkan kursor / hover |
| `browser_press_key` | `mcp__acs-browser__browser_press_key` | acs-browser-agent only | on-demand (`/browser --engine`) | tekan tombol / press key |
| `browser_scroll` | `mcp__acs-browser__browser_scroll` | acs-browser-agent only | on-demand (`/browser --engine`) | gulir halaman / scroll page |
| `browser_take_screenshot` | `mcp__acs-browser__browser_take_screenshot` | acs-browser-agent only | on-demand (`/browser --engine`) | verifikasi UI / verify UI |
| `browser_evaluate` | `mcp__acs-browser__browser_evaluate` | acs-browser-agent only | on-demand (`/browser --engine`) | jalankan JS / run JS |
| `browser_wait_for` | `mcp__acs-browser__browser_wait_for` | acs-browser-agent only | on-demand (`/browser --engine`) | tunggu elemen / wait for element |
| `browser_tabs` | `mcp__acs-browser__browser_tabs` | acs-browser-agent only | on-demand (`/browser --engine`) | kelola tab / manage tabs |
| `browser_console_messages` | `mcp__acs-browser__browser_console_messages` | acs-browser-agent only | on-demand (`/browser --engine`) | baca log konsol / read console logs |
| `browser_network_requests` | `mcp__acs-browser__browser_network_requests` | acs-browser-agent only | on-demand (`/browser --engine`) | pantau jaringan / inspect network |
| `browser_ocr` | `mcp__acs-browser__browser_ocr` | acs-browser-agent only | on-demand (`/browser --engine`) | baca teks gambar / OCR text |
| `browser_pdf_extract_text` | `mcp__acs-browser__browser_pdf_extract_text` | acs-browser-agent only | on-demand (`/browser --engine`) | ekstrak PDF / extract PDF |
| `browser_close` | — (new in `acs:core`) | acs-browser-agent only | on-demand (`/browser --engine`) | tutup sesi / close session |
| `cloak_stealth_audit` | `mcp__acs-browser__cloak_stealth_audit` | acs-browser-agent only | on-demand (`/browser --engine`) | audit siluman / stealth audit |
| `cloak_detection_test` | `mcp__acs-browser__cloak_detection_test` | acs-browser-agent only | on-demand (`/browser --engine`) | uji deteksi / detection test |
<!-- ACS workflow v1.33.0+e24042d -->
