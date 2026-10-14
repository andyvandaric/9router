---
name: investigation-protocol
trigger: model_decision
description: "Live ground-truth probing, anti-shortcut audit discipline, fallback chain protocol, and state awareness."
---

# Investigation Discipline & Anti-Shortcut Protocol

Authoritative rules for systematic investigation, ground-truth verification, and loop avoidance across all agent tasks.

---

## 1. Investigate Before Action (Anti-Blind Execution Invariant)
- Prior to modifying state (database, source files, system configuration, services), agents MUST inspect current disk and AST state directly.
- Prior to applying fixes, agents MUST diagnose root causes. Blind, unprincipled patching without isolating the failure mechanism is strictly forbidden.
- Do not rely on assumptions: probe, verify empirically, and then proceed with implementation.
- **Enforced Programmatic Gate**: Any attempt to modify code or files without probing live ground-truth or without a verified PRD Blueprint (>=97% confidence) is blocked by the PreToolUse `prd-workflow-gate` and `scope-guard`. Blind execution is prohibited across all agents and models.
- **Direct Execution Exemption (Flag-Gated)**: Direct Execution is permitted if and only if flagged with `direct_execution: true` in the Agent `tool_input` (or prompt token `direct_execution: true`) AND adhering to the micro-chunk ceilings (<=2 files, 1 domain, <100 LOC, zero DB/DDL, zero API break). Unflagged dispatches are blocked; a supplied `blueprint_path` always voids this exemption.

---

## 2. Live Ground-Truth Over Stale Cache (Anti-Shortcut Rule)
- Always probe active manifests and disk state directly (`manifest.json`, `settings.json`, active config directories).
- Historical audit files and research logs (`.claude/audit/*.md`, `.claude/research/*.md`) are historical context, NOT live sources of truth.
- Inspect active codebases, test fixtures, and live runtime configurations to eliminate stale regurgitation.

---

## 3. Fallback Chain Protocol & 2-Strike Rule
- When an approach fails: diagnose WHY it failed, then pivot to a fundamentally distinct strategy.
- If the same approach fails twice: STOP. Step back and reconsider assumptions from scratch.
- If three distinct approaches fail consecutively: halt execution and present a comprehensive diagnosis to the user before proceeding further.

---

## 4. Adaptive Build Tooling & Pipeline Discovery (Stack-Agnostic Awareness)
Prior to modifying code or planning features across ANY project or repository, agents MUST adaptively discover and align with the project's native build system:
1. **Tier 1 (Task Runners / Orchestrators)**: Probe project root for `justfile`, `Makefile`, `Taskfile.yml`, `deno.json`, or `package.json:scripts`. The project's native task runner recipes (e.g., `just dev`, `make test`, `npm run build`, `cargo test`) ALWAYS take precedence over bare compiler calls.
2. **Tier 2 (Stack Manifests)**: Probe `go.mod`, `Cargo.toml`, `pyproject.toml`, `pom.xml`, `composer.json`, `build.gradle`, `*.csproj` to understand dependencies, build tags, and language constraints.
3. **Tier 3 (Project Invariants)**: Inspect local `CLAUDE.md`, `README.md`, and pipeline scripts (`tools/pipeline/`, `scripts/`) for multi-tier environment tags (`dev`, `staging`, `prod`), embedded asset requirements, and release gates.
4. **Builder Impact Invariant**: Whenever an agent introduces new endpoints, dependencies, CLI flags, configuration paths, or embedded assets, the agent MUST evaluate and adapt the project's build tools in the SAME sub-phase. Leaving build tools broken for manual terminal execution is strictly forbidden.

### Task Runner Hierarchy & `just dev` Integration Workflow
In ACS Core development, `just dev` is the authoritative default integration command:
- **Fast Syntax & Compile Check**: `just go-build`
- **Targeted Package Regression**: `just go-test-pkg <pkg>`
- **Incremental Verification**: `just test`
- **Full Dev Integration (Build + Test + Install + Restart + Smoke)**: `just dev` (MANDATORY for service lifecycle, daemon schedulers, gateway changes, runtime dashboard behavior, or installed binary changes).
- **Comprehensive Monorepo Suite**: `just test-all`
- **Fallback Protocol**: Direct invocations of `python -m tools.pipeline.*`, `go build`, or `go test` are STRICTLY FALLBACK mechanisms permitted only when `just` is unavailable on the host.

---

## 5. Windows Zero-Console Flash Invariant (`internal/executil`)

All child processes, scheduled tasks, background daemons, and CLI probes executed on Windows MUST run 100% in the background without spawning visible terminal, cmd, or conhost popup windows. Console flashes disrupt user focus, degrade developer experience, and trigger OS focus-stealing bugs.

### Subprocess Execution Rules
1. **Mandatory Centralized Helper**:
   - ALL subprocess execution in Go MUST use `acs-cli/internal/executil` (`executil.Command`, `executil.HideWindow`, `executil.HideBackgroundWindow`).
   - Authoring ad-hoc local `hideCommandWindow` helpers in other packages is STRICTLY FORBIDDEN.
2. **Execution Class Flags**:
   - **CLI Probes / Short-Lived Commands**:
     `executil.HideWindow(cmd)` sets `CreationFlags |= 0x08000000` (`CREATE_NO_WINDOW`) and `HideWindow: true`. DILARANG use `DETACHED_PROCESS` on short-lived probes to prevent breaking stdout/stderr pipes.
   - **Background Daemons & Long-Running Services**:
     `executil.HideBackgroundWindow(cmd)` sets `CreationFlags |= (0x08000000 | 0x00000008)` (`CREATE_NO_WINDOW | DETACHED_PROCESS`) and `HideWindow: true`.
   - **Supervisor & Breakaway Management**:
     Use `CREATE_NO_WINDOW | DETACHED_PROCESS`. DILARANG use `CREATE_BREAKAWAY_FROM_JOB` (0x01000000) as it triggers Windows Access Denied errors and forces console spawning.
3. **External Scripting & Task Runners**:
   - **Windows Task Scheduler (`schtasks`)**:
     Commands MUST be wrapped: `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -Command "& '...'"`
   - **Node.js / JavaScript child_process**:
     Pass `windowsHide: true` on every `execSync`, `spawn`, or `exec` call.

---

## 6. Windows Shell & Subprocess Invariants (Tooling Stability)

Every agent executing shell operations on Windows MUST adhere to these 5 pillars:

1. **Forward-Slash Paths in Bash Tool**: Always use forward-slashes (`/` or `{{PROJECT_ROOT}} in all file paths and command arguments. Unescaped backslashes (`\`) act as escape characters in Git Bash POSIX sh and are strictly forbidden.
2. **Stateless Working Directory (Stateless CWD)**: Agent threads reset cwd between tool turns. Never assume `cd` persists across turns. Use native directory flags (`git -C <dir> status`) or single-turn compound commands (`cd <dir> && <cmd>`).
3. **PowerShell Single-Line Wrapper**: When PowerShell execution is required, wrap explicitly: `powershell -NoProfile -NonInteractive -Command "& { ... }"`. PowerShell-specific syntax (`@'...'@` here-strings, `$env:VAR`, backtick continuations) is strictly forbidden in the Bash tool.
4. **Proactive Git Index Lock Release**: On Windows, proactively force-release stale index locks before staging/committing: `powershell -NoProfile -NonInteractive -Command "& { if (Test-Path .git/index.lock) { Remove-Item .git/index.lock -Force } }"`. Never enter repetitive git exit code 128 retry loops.
5. **Tier 1 Native MCP Primacy**: Always prefer Native MCP Tools `acs:core` (`search_code`, `search_memory`, `kanban_*`, `lsp_*`) over raw CLI shell queries (`find`, `grep`, `cat`, `curl` via Bash). Raw CLI querying is an anti-pattern. NEVER use `Grep` with path patterns (e.g. `**/*.md`, `scripts/*.mjs`) — Grep searches content only and times out on broad scans; ALWAYS use `Glob` for file path discovery.
<!-- ACS workflow v1.6.1+84189ab -->
<!-- ACS workflow v1.33.0+de28d6b -->
