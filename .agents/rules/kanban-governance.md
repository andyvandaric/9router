---
name: kanban-governance
trigger: always_on
description: "Antigravity Kanban and Universal Agentic task lifecycle synchronization rules and project scoping."
---

# Antigravity Kanban & Universal Agentic Task Lifecycle Governance (MANDATORY AGENT BEHAVIOR)

Every agent (Claude Code CLI, Antigravity IDE, OpenCode Interpreter, Hermes worker agents, or Lead Orchestrator) MUST proactively adhere to the Kanban board lifecycle and maintain full operational awareness across the four hierarchical card tabs:
1. **Files & Blueprints (`files`, `blueprint_path`)**: Registered file paths and linked PRD blueprint documents (`.claude/plans/<slug>/index.md`).
2. **Plan Checklist & Pre-Audit Report (`plan_content`, `pre_verification_content`)**: Structured Markdown task checklist (`- [ ]`, `- [x]`) enforcing TDD RGR discipline and pre-execution architectural audit evidence.
3. **Metadata & Commits (`commit_ids`, `assignee`, `worker`)**: Linked git commit SHAs, acting agent identity, and execution state.
4. **Walkthrough & Verification (`walkthrough_content`)**: Comprehensive test logs, empirical verification, and Definition of Done (DoD) evidence.

---

## 1. Priority Classification & SLA Governance (P0 - P3)

Every Kanban task MUST be assigned an explicit priority tier governing its scheduling precedence, triage sequence, and operational urgency:

| Tier | Code & Level | Indicator | Semantic Scope & Trigger Conditions | Scheduling & Execution SLA |
|---|---|---|---|---|
| **P0** | `P0 - Urgent (Critical)` | 🔴 | Production outages, severe regressions, critical security vulnerabilities, corrupted state, or release-blocking build breaks. | Immediate execution. Preempts all ongoing non-P0 tasks. Continuous swarm/triage until resolved. |
| **P1** | `P1 - High` | 🟠 | Core milestone deliverables, primary feature requirements, major architectural refactoring, and critical UX fixes. | Top backlog/ready priority. Scheduled in the immediate active wave or sprint. |
| **P2** | `P2 - Medium` | 🔵 | Standard engineering enhancements, routine refactoring, non-breaking technical debt, and operational chores. | Default priority for standard tasks. Executed sequentially after P0 and P1 items. |
| **P3** | `P3 - Low` | ⚪ | Minor polish, non-blocking cosmetic updates, documentation nits, or exploratory nice-to-haves. | Opportunistic execution. Deferrable when higher-priority queues are populated. |

### Priority Assignment Rules
- **Default Tier**: If priority is unspecified during task creation, it defaults to `P2 - Medium` (`"medium"`), unless the task originates from a PRD milestone deliverable (which defaults to `P1 - High` / `"high"`).
- **Dynamic Escalation**: Any defect that blocks compilation, breaks live CI/CD gates, or halts daemon execution MUST be immediately escalated to `P0 - Urgent (Critical)` (`"urgent"`).
- **API Mapping**: The `priority` field accepts lowercase tokens: `"urgent"` (P0), `"high"` (P1), `"medium"` (P2), and `"low"` (P3).

---

## 2. Five-Column Lifecycle Governance (`Backlog` ➔ `Ready` ➔ `In Progress` ➔ `Review` ➔ `Done`)

The Kanban board enforces a deterministic 5-column lifecycle progression. Tasks flow sequentially through these states without skipping validation checkpoints:

```
[ Backlog ] ──> [ Ready ] ──> [ In Progress ] ──> [ Review ] ──> [ Done ]
      │               │               │                │             ▲
      │               │               └──(Fail/Reject)─┘             │
      │               └──────────────────(Dual Verification Gate)────┘
```

1. **Backlog (`backlog`)**:
   - Unclaimed, raw, or unscheduled tasks awaiting initial grooming, architectural review, or blueprint association.
   - Newly discovered bugs or unassigned feature proposals originate here.
2. **Ready (`ready`)**:
   - Fully groomed, planned, and approved tasks ready for immediate pickup.
   - Requires completed PRD Blueprint path (`blueprint_path`), claimed target files (`files`), and pre-execution architectural checklist (`plan_content`).
   - Hard Gate 1/1B verification score (≥97%) achieved prior to transitioning to Ready.
3. **In Progress (`in_progress`)**:
   - Actively claimed task undergoing implementation by a designated agent or developer.
   - **MANDATORY IMMEDIATE TRANSITION**: The exact moment execution begins (after PRD approval or upon picking up a direct fix), the Lead Orchestrator or executing agent MUST IMMEDIATELY update the card status to `in_progress` (scoped with `run_id` and `assignee`). Leaving active work in `ready` or `backlog` while implementation is running is STRICTLY FORBIDDEN.
   - Enforces strict TDD Red-Green-Refactor (RGR) cycle: write failing test (RED), implement minimal code (GREEN), clean structure (REFACTOR).
   - Checklist items in Tab 2 actively marked `- [x]` as subtasks complete.
4. **Review (`review`)**:
   - Implementation complete; awaiting verification sign-off, peer review, or user approval.
   - Independent verification sub-agents (e.g., `verifier`, `qa-tester`) validate artifacts against PRD specifications and run full automated test suites.
   - If regressions or blueprint deviations occur, the task is rejected back to `in_progress` with actionable feedback.
5. **Done (`done`)**:
   - Terminal state of verified completion.
   - Hard gate prerequisites: 100% checklist items completed (`- [x]`), valid git commit SHAs linked (`commit_ids`), pre-audit evidence attached (`pre_verification_content`), and comprehensive empirical walkthrough evidence attached (`walkthrough_content`).

---

## 3. Dual Verification Reports Protocol (Pre-Audit & Walkthrough)

High-integrity engineering requires empirical verification at both boundaries of the execution lifecycle:

### A. Pre-Audit Report (Tab 2: `pre_verification_content`)
- **Execution Timing**: Conducted before implementation starts (during transition from `Backlog` to `Ready` or `In Progress`).
- **Required Evidence**:
  - Codebase baseline verification against live disk AST ground truth.
  - Architectural assessment and Confidence Success Score (MUST reach ≥97%).
  - Pre-execution risk analysis, failure mode identification, and dependency mapping.
- **Submission**: Registered via `kanban_artifacts(task_id="<id>", pre_verification_content="...")`.
- **UI Indicator**: Displays a dedicated **Pre-Audit** badge on the task card when content is present.

### B. Post-Execution Walkthrough Report (Tab 4: `walkthrough_content`)
- **Execution Timing**: Authored upon implementation completion before marking `done`.
- **Required Evidence**:
  - Live test suite execution logs (100% PASS, zero failing assertions).
  - Typecheck, compiler, and linter diagnostic results (`lsp_diagnostics`, `go vet`, `biome check`).
  - Empirical verification that Definition of Done (DoD) criteria and PRD KPIs are fully satisfied.
  - Confirmation of zero regressions across adjacent subsystems.
- **Submission**: Registered via `kanban_artifacts(task_id="<id>", walkthrough_content="...")`.
- **UI Indicator**: Displays a dedicated **Walkthrough** badge on the task card when content is present.

---

## 4. Per-Column Dynamic Sorting Standards

To support structured task management across dense boards, every column provides independent sorting controls:

- **Sort Metric**: Tasks within each column are sorted by normalized timestamp:
  - **Primary**: `updated_at` (most recently modified).
  - **Fallback**: `created_at` (original creation timestamp if `updated_at` is identical or unavailable).
- **Direction Toggle**:
  - **Newest First (`DESC`)** (Default): Surfaces recently created or updated work to the top of the column.
  - **Oldest First (`ASC`)**: Surfaces aging work to identify stalled items or respect strict FIFO queue processing.
- **Deterministic Tie-Breaker**: When task timestamps are identical, the sorting engine uses a deterministic secondary tie-breaker on task ID (`task.id`), guaranteeing consistent order without UI jitter during live polling or WebSocket updates.

---

## 5. Direct Execution Card Standard (Single-Turn & Direct Fix Tasks)

Tasks executed directly without a multi-phase PRD blueprint (e.g. single-file bug fixes, targeted chores, rapid refactoring) MUST adhere to high-quality Kanban card authoring standards. Barren cards are strictly prohibited.

### Mandatory Direct Execution Card Payload
Every direct execution task card MUST include:
1. **Title**: Structured conventional commit naming pattern (`fix(subsystem): concise description` or `feat(subsystem): concise description`). Max 70 characters.
2. **Description**: Concise, self-contained explanation summarizing the problem statement, affected components, and implemented solution.
3. **Plan Checklist (`plan_content`)**: MUST contain at least 2 atomic checklist items enforcing execution discipline:
   - `- [x] Isolate defect and verify failure mechanism`
   - `- [x] Implement fix in <target_files>`
   - `- [x] Verify with test runner and typechecker`
4. **Claimed Target Files (`files`)**: Array of file paths touched or modified by the task.
5. **Linked Commits (`commit_ids`)**: Comma-separated git commit SHAs documenting the work.
6. **Walkthrough Evidence (`walkthrough_content`)**: Fresh test runner output, pass/fail assertions, and verification summary required prior to moving the task to `done`.

### Enforcement Invariant
Automated reconcilers and agents MUST reject marking direct execution tasks `done` if `plan_content` or `commit_ids` are empty.

---

## 6. Universal Multi-Agent Awareness & Proactive Inspection

> ⛔ **BUILTIN MCP FIRST INVARIANT (MANDATORY)**:
> All Kanban operations (query, create, update status, claim files, submit artifacts, and card inspection) **MUST strictly adhere to the 4-Tier Execution Hierarchy**:
> 1. **Tier 1 (Primary for Agents / Zero-Shell)**: Native MCP Tools `acs:core` (`kanban_update`, `kanban_artifacts`, `kanban_summary`, `kanban_card_by_ref`, `kanban_create`, `kanban_claim_files`, `kanban_list`) via persistent stdio RPC (<2ms latency). MANDATORY primary choice for all agents!
> 2. **Tier 2 (CLI Fastpath)**: Binary Subcommands `acs kanban ...` (`acs kanban summary`, `acs kanban create`, `acs kanban card`, `acs kanban artifacts`, `acs kanban list`, `acs kanban sync`, `acs kanban move`) with 5-15ms latency.
> 3. **Tier 3 (Direct Cache / Local Store)**: Direct SQLite WAL queries to local database (`agentic.GetTask`, `agentic.GetKanbanSummary`). Latency <0.05ms in-memory.
> 4. **Tier 4 (Last-Resort Fallback ONLY)**: Stateless HTTP REST via `curl` (:20130).
> **STRICT PROHIBITION**: Calling curl or raw HTTP endpoints while Tier 1 or Tier 2 is operational is STRICTLY FORBIDDEN! Stateless REST via `curl` is reserved exclusively as an emergency fallback when the native MCP stdio transport crashes completely.

- **Universal Obligation**: Regardless of execution runtime (Claude Code CLI, Antigravity, OpenCode, or Hermes), agents receiving technical assignments MUST inspect active tasks on the Kanban board prior to modifying code.
- **Project Scope**: Always resolve the active workspace directory name (e.g., repository root basename).
- **Dedicated Primary Query**: `kanban_list(project="<active-workspace-name>")` — list active cards per project; optionally filter with `status="..."`.
- **Direct Card Resolver**: `kanban_card_by_ref(ref="<url_or_id>", include="plan,walkthrough,pre_verification")` (Accepts full browser URLs, query strings, or task IDs; returns complete 4-tab card payload).
- **Instant Telemetry**: `kanban_summary(project="<active-workspace-name>")` — total, status distribution, and active tasks brief.
- **Port Candidate Resolution**: `{{ACS_PORT}}` (Dev `20150`, Prod `20130`, Staging `20155`) applies ONLY to Tier 4 stateless REST fallback when MCP transport is fully down. If dev does not respond, probe alternative active ports.
- **Claiming Backlog/Ready Items**: If a matching card exists in `backlog` or `ready`, claim and transition it to `in_progress` via `kanban_update(task_id="<id>", status="in_progress", assignee="<actor>")`.
### Step 0: Mandatory Pre-Creation Search Probe & 3-Tier Anti-Duplication
Before invoking `kanban_create`, agents MUST execute:
1. `kanban_list(project="<project>")` (optionally with `status="..."`), or `kanban_card_by_ref(ref="<url_or_id>")` for a known reference.
2. Check for active cards with matching `blueprint_path`, similar title, or semantic overlap.
3. If an existing card is found or `is_duplicate: true` is returned, claim and update the existing card via `kanban_update`.
4. Card creation leverages 3-Tier Hybrid Anti-Duplication (Tier 1 FTS5/metadata, Tier 2 Trigram >= 0.70, Tier 3 BGE-M3 Vector >= 0.75) with zero-token offline fallback.
   - Tier 1 Metadata/FTS5: exact `blueprint_path`, commit SHAs, claimed files, FTS5 title match.
   - Tier 2 Syntactic & Intent Overlap: stemmed Jaccard + character trigram similarity >= 0.70.
   - Tier 3 Vector Semantic Cosine Similarity: BGE-M3 >= 0.75.
   - Zero-Token Fallback Guarantee: when 9router (`:20128`) is unreachable, creation degrades gracefully to Tier 1 + Tier 2 only. No token cost, no hard failure.
   - Blueprint Auto-Sync Invariant: `kanban_create` is strictly forbidden for PRD blueprints (`.claude/plans/<slug>/index.md`), which auto-sync via `blueprint-sync`. Always resolve the existing card by `blueprint_path`.
- **Two Distinct Workflows (Direct Execution vs PRD Blueprint)**:
  1. **PRD Blueprint Workflow (`.claude/plans/<slug>/index.md`)**:
     - `kanban_create` is **STRICTLY FORBIDDEN**.
     - PRD blueprints are automatically discovered, parsed, and synced to Kanban cards by the background `blueprint-sync` engine.
     - Agents MUST NOT manually create duplicate cards. Always resolve the existing auto-synced card by matching `blueprint_path` (via `kanban_card_by_ref` or querying `blueprint_path`), claim it, and transition it via `kanban_update`.
  2. **Direct Execution Workflow (Tasks WITHOUT PRD Blueprint)**:
     - For single-turn, ad-hoc, or direct fix tasks touching <3 files and zero database/architecture changes, `kanban_create(project="<proj>", title="<title>", ...)` is permitted ONLY if no card exists.
     - Initialize a new card in `in_progress` via `kanban_create` (Tabs 1 & 2 mandatory):
       ```json
       {
         "project": "<active-workspace-name>",
         "title": "fix(scope): concise description with TDD RGR",
         "description": "Technical scope description",
         "status": "in_progress",
         "priority": "high",
         "tag": "bugfix | direct-fix | backend",
         "assignee": "claude | antigravity | opencode | hermes",
         "files": ["path/to/target1.go", "path/to/target2.ts"],
         "plan_content": "- [ ] Step 1: Investigation & contract specification (input/output/error)\n- [ ] Step 2: RED — Write failing test & verify runner failure\n- [ ] Step 3: GREEN — Minimal implementation to pass test\n- [ ] Step 4: REFACTOR — Clean structure while maintaining green tests\n- [ ] Step 5: Verification & regression sweep",
         "pre_verification_content": "### Pre-Audit Report\n- Baseline verification against live AST ground truth: CONFIRMED.\n- Confidence Success Score: 98%."
       }
       ```
- **TDD RGR Discipline in Cards**: For tasks involving logic, APIs, calculations, or schemas, `plan_content` MUST NOT skip the RED (failing test) checkpoint.

---

## 7. Blueprint Auto-Linking Protocol (`.claude/plans/<slug>/index.md`)

When work references an authoritative PRD Blueprint:
1. **Zero-Duplicate Invariant (`kanban_create` FORBIDDEN)**: PRD blueprints in `.claude/plans/<slug>/index.md` are automatically synchronized to Kanban via `blueprint-sync`. Agents MUST NOT invoke `kanban_create`. Calling `kanban_create` for blueprint plans creates duplicate zombie cards and is strictly prohibited.
2. **Auto-Link Resolution**: Agents MUST resolve the existing card by matching `blueprint_path` (`.claude/plans/<slug>/index.md`) via `kanban_card_by_ref` or querying tasks by `blueprint_path`, claim it, and update status using `kanban_update`.
3. **Automated Synchronization**:
   - Status changes in Master Plans (`🟡 PROPOSED` ➔ `backlog`, `🔄 IN PROGRESS` ➔ `in_progress`, `✅ COMPLETED` ➔ `done`) MUST mirror between Markdown plans and Kanban cards.
4. **Tab 1 File Registration**: Register all target files in **Files & Blueprints** via `kanban_claim_files(task_id="<id>", files=[...])` to provide full review visibility.

---

## 8. Active Progress Progression & Checklist Updating (Tab 2)

- **Checklist Maintenance**: Agents MUST NOT leave Plan Checklists empty or stagnant during active execution.
- **Update Checkpoints**: As milestones complete, update checkboxes (`- [ ]` to `- [x]`) via `kanban_artifacts(task_id="<id>", plan_content="...", walkthrough_content="...", commit_ids="...")`:
  ```json
  {
    "plan_content": "- [x] Step 1: Investigation & codebase audit\n- [ ] Step 2: Core implementation\n- [ ] Step 3: Test suite & UI verification",
    "walkthrough_content": "### Progress Update\n- Investigation complete in target module.",
    "commit_ids": ""
  }
  ```
- **State Transitions**:
  - Transition to `review` when awaiting explicit user sign-off or verifier gate evaluation.
  - Remain in `in_progress` while executing ongoing subtasks or phases.

---

## 9. Task Completion & Full Artifact Attachment (DONE — Tabs 3 & 4)

Prior to or upon transitioning a card to `done`, agents MUST attach final verification artifacts:
1. **Verify Checklist Completion (Tab 2)**: All checkboxes in `plan_content` MUST evaluate to `- [x]`.
2. **Attach Commit SHAs (Tab 3)**: Record git commit SHAs in `commit_ids`.
3. **Verify Pre-Audit Evidence (Tab 2)**: Ensure `pre_verification_content` contains architectural baseline audit.
4. **Author Comprehensive Walkthrough (Tab 4)**: Include test suite outputs, command evidence, and confirmation of zero regressions in `walkthrough_content`.
5. **Submit Artifacts**:
   `kanban_artifacts(task_id="<id>", plan_content="...", walkthrough_content="...", commit_ids="...", pre_verification_content="...")`:
   ```json
   {
     "plan_content": "- [x] Step 1: Investigation complete\n- [x] Step 2: Implementation verified\n- [x] Step 3: Full test suites passing",
     "walkthrough_content": "### Walkthrough & Verification\n- Implementation complete in target module.\n- Test runner: 100% PASS.\n- Zero functional regressions.",
     "pre_verification_content": "### Pre-Audit Report\n- Baseline verification verified before execution.\n- Confidence score: 98%.",
     "commit_ids": "abc1234"
   }
   ```
6. **Mark Done**:
   `kanban_update(task_id="<id>", status="done")`.

---

## Tri-Partite State Lifecycle Synchronization FSM

Active execution MUST maintain a strict tri-partite finite state machine (FSM) in which three tracking surfaces — Kanban card, Claude Code Task list, and PRD phase status — transition in lockstep. Drift between any two surfaces is a violation. The topic worktree provides the physical execution isolation for the claimed work.

```
[ CLAIMED / IN PROGRESS ] ──> [ VERIFYING / IN REVIEW ] ──> [ RECONCILED / DONE ]
        State 1                        State 2                      State 3
         │                                 │                            ▲
         └──── Hard Gate 3 PASS ───────────┘                            │
         (Fail/Reject loops back to State 1) ───────────────────────────┘ (after commit)
```

### State 1 — CLAIMED / IN PROGRESS
All four surfaces MUST reflect active work simultaneously:
- **Kanban card**: `status: "in_progress"` (via `kanban_update`).
- **Claude Code Task list**: Task marked `in_progress` (via `TaskUpdate`).
- **PRD phase status**: Sub-phase header and master breakdown table marked `🔄 IN PROGRESS`.
- **Topic Worktree**: The phase's topic worktree is checked out (isolated execution environment).

### State 2 — VERIFYING / IN REVIEW
Implementation complete; verification in flight:
- **Kanban card**: `status: "review"` (via `kanban_update`).
- **Verifier Sub-Agent**: Hard Gate 3 test run executed independently (test suite, typecheck, linter, DoD checklist) by a verifier/QA sub-agent that is NOT the authoring worker.
- Rejection routes the card back to State 1 with a concrete rejection report until 100% GREEN.

### State 3 — RECONCILED / DONE
Terminal state; all surfaces reconciled atomically:
- **Conventional Git Commit**: `git-master` creates the atomic conventional commit (e.g. `feat(scope): ... (phase-XX)`).
- **PRD Checklist**: All sub-phase checkboxes marked `- [x]` and phase status set to `✅ DONE`.
- **Claude Code Task list**: Task marked `completed` (via `TaskUpdate`).
- **Kanban card**: Moved to `done` with commit SHAs recorded via `kanban_artifacts` (`commit_ids`).

### FSM Invariants
1. **No Skip**: Transitions are strictly sequential (State 1 ➔ State 2 ➔ State 3). Reaching `done` without a Hard Gate 3 PASS or missing `commit_ids` is strictly forbidden.
2. **Lockstep**: A state change on one surface MUST be mirrored to the other two surfaces in the same operational turn.
3. **Rejection Loop**: A failed Hard Gate 3 returns the card to State 1 (`in_progress`) with actionable feedback; the next attempt repeats State 2.

---

## 10. Multi-Agent Actor Identification & Commit Linking Protocol

In heterogeneous multi-agent collaboration environments:

### Agent Actor Detection
Environment variables resolve actor identity:
| Client / Environment | Detection Variable | Kanban Assignee |
|---|---|---|
| **Claude Code CLI** | `CLAUDE_CODE=1`, `CLAUDE_PROJECT_DIR`, or subagent context | `claude` |
| **Antigravity IDE** | `ANTIGRAVITY_AGENT=1`, `GEMINI_CLI=1`, `ANTIGRAVITY=1` | `antigravity` |
| **OpenCode Interpreter** | `OPENCODE=1` or `OPENCODE_SESSION_ID` | `opencode` |
| **Hermes / Kiro** | `HERMES_PROFILE`, `KIRO=1` | `hermes` |
| **Manual Developer** | Standard git author without agent environment flags | `developer` |

### Deterministic Commit Linking
- **Explicit Task ID Tagging**:
  Include the task ID in the commit message:
  `git commit -m "feat(scope): summary description (task-<id>)"`
  When a task id is known for this work, append the (task-<id>) token to the commit subject line (e.g. feat(scope): summary (task-abc123)). When no task id is known, emit the subject without any token — never invent or guess an id.
- **Strict Assignee Isolation**:
  Backend handlers associate incoming commits to active cards matching the detected actor and workspace, preventing cross-agent card collision.
- **Fallback Independent Commit Cards**:
  Commits created without an active matching card are isolated to standalone commit cards (`commit-<sha>`) to preserve clean audit trails.

---

## 11. Native MCP Tools & CLI Command Suite (ACS Core v1.7.0+)

Agents and developers can interact with the Kanban board directly via native tools:

### Native MCP Tools (`mcpacs`)
| Tool Name | Parameters | Purpose |
|---|---|---|
| `kanban_list` | `{"project": "...", "status": "..."}` | List active cards per project |
| `kanban_create` | `{"project": "...", "title": "...", "files": [...], "plan_content": "...", "priority": "urgent\|high\|medium\|low"}` | Create new card with Tab 1 & Tab 2 filled (STRICTLY for Direct Execution tasks without PRD; FORBIDDEN for PRD blueprints which auto-sync via `blueprint-sync`) |
| `kanban_update` | `{"task_id": "...", "status": "...", "priority": "...", "assignee": "..."}` | Move card status (`backlog` ➔ `ready` ➔ `in_progress` ➔ `review` ➔ `done`) or update priority |
| `kanban_artifacts` | `{"task_id": "...", "plan_content": "...", "pre_verification_content": "...", "walkthrough_content": "...", "commit_ids": "..."}` | Update checklist, pre-audit, walkthrough evidence, and commits |
| `kanban_claim_files` | `{"task_id": "...", "files": [...]}` | Register claimed files on Tab 1 |
| `kanban_card_by_ref` | `{"ref": "..."}` | Resolve card ref (URL, query, or task ID) to full 4-tab payload |
| `kanban_summary` | `{"project": "..."}` | In-process instant SQLite WAL Kanban telemetry (<0.1ms query, sub-5ms MCP) returning total, status distribution, and active tasks brief |

### CLI Subcommands (`acs kanban`)
- `acs kanban summary [--project <name>]`: Instant in-process SQLite WAL status summary and active tasks.
- `acs kanban list [--project <name>] [--status <status>]`: View tabular board in terminal.
- `acs kanban create --title <t> [--project <p>] [--priority <p>] [--assignee <a>] [--desc <d>]`: Create a new Kanban task card directly from CLI.
- `acs kanban card <task-id>`: Inspect full 4-tab card details and artifacts for a task.
- `acs kanban artifacts <task-id> [--plan <t>] [--walkthrough <t>] [--commits <c>] [--pre-audit <p>]`: Update checklist, pre-audit, walkthrough evidence, and commits.
- `acs kanban sync [--project <name>]`: Reconcile all `.claude/plans/*/index.md` and sub-phases to SQLite.
- `acs kanban move <task-id> <status>`: Transition card status directly.
- `acs kanban approve --blueprint-path <path> [--project <p>] --approver <name>`: Mark blueprint as APPROVED in SQLite with Standing Delegated Authority support.

---

## 12. Blueprint Approval & Standing Delegated Authority Protocol

To prevent execution bottlenecks while preserving strict governance gates:

### Universal Standing Approval Authority (Zero Hardcoding)
1. **CEO / Lead Orchestrator**: Persona `Anke van der Meer` (`anke`, `lead-orchestrator`, `ceo`) holds universal standing delegated authority from the Owner. Orders, blueprints, and approvals signed by Anke bypass repo-local `.claude/approvers.json` restrictions and can be approved directly.
2. **Dynamic Workstation Owner / Active Git User**: The primary workstation owner resolved dynamically from environment (`git config user.name`, `git config user.email`, `$USER`, `$USERNAME`, or generic token `owner`/`suite-owner`) holds intrinsic standing approval authority across all projects without hardcoded personal identities.
3. **Approvers Allowlist Fallback**: If repo-local `.claude/approvers.json` is absent, the approval engine automatically checks global `~/.claude/approvers.json` before evaluating suite owner rules. Standing authority takes precedence over missing local configuration files.

<!-- ACS workflow v1.7.0 -->
<!-- ACS workflow v1.33.0+fe58ee9 -->
