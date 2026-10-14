---
trigger: always_on
---

# Git Multi-Tier Lifecycle & Multi-Agent Worktree Concurrency Governance

Authoritative governance for all agents (Lead Orchestrator and Worker Subagents) managing Git branch lifecycles, environment promotion pipelines (Dev ➔ Staging ➔ Prod), and concurrent multi-agent / multi-session execution without merge conflicts.

---

## 🏛️ SECTION 1: Three-Tier Environment Promotion Pipeline (Dev ➔ Staging ➔ Prod)

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                       LEVEL 1: DEVELOPMENT (Sandbox)                        │
│  - Branch: Feature branch 'feat/<name>' (branched from 'dev' or 'staging')  │
│  - Runtime: Local development sandbox, isolated test stores                 │
│  - Guard Rule: Direct execution against Staging/Prod databases is FORBIDDEN │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ 🚪 GATE 1: DEV ➔ STAGING
                                       │    1. Code compilation / typecheck (0 errors)
                                       │    2. Package test suites (100% pass)
                                       │    3. Clean git working tree
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       LEVEL 2: STAGING (Pre-Release Arena)                  │
│  - Branch: 'staging'                                                        │
│  - Runtime: Isolated staging daemon and test environment                    │
│  - Database: Isolated staging database, zero production data contamination  │
│  - Versioning: Release Candidate (vX.Y.Z-rc.N)                              │
│  - Guard Rule: Direct mutations to Production database are HARD-BLOCKED     │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ 🚪 GATE 2: STAGING ➔ PROD (5-Gate Evaluator)
                                       │    1. Gate 1: Git Cleanliness (Branch 'staging')
                                       │    2. Gate 2: Workspace Compile / Typecheck (0 errors)
                                       │    3. Gate 3: Full Regression Test Suite (100% pass)
                                       │    4. Gate 4: Database Schema Parity Audit
                                       │    5. Gate 5: Live Daemon / Endpoint Sweep
                                       │    6. Terminal Interactive Sign-off [Y/n]
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       LEVEL 3: PRODUCTION (Sovereign GA)                    │
│  - Branch: 'main' (STRICTLY PROTECTED / READ-ONLY for development)          │
│  - Runtime: Production runtime environment                                  │
│  - Database: Production stores (Verified buyers only)                       │
│  - Versioning: Official General Availability vX.Y.Z                         │
│  - Deployment: Automated release pipeline via pipeline gates                │
│  - Post-Deploy Check: Live smoke verification and endpoint probe             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 👥 SECTION 2: Conflict-Free Multi-Agent & Multi-Session Concurrency Protocol

When multiple AI agents or concurrent developer sessions operate simultaneously in the repository:

### 1. Git Worktree Isolation & Mandatory Startup Gate (R1)
Two agents or sessions MUST NOT modify the same physical working directory and git branch concurrently.

Every newly initialized session MUST execute the **Startup Gate**:
1. **Probe Worktrees & Active Claims**:
   ```bash
   git worktree list
   # Check active claims via JSON registry:
   # <repo-root>/.claude/state/session-claims/<session-id>.json
   ```
2. **Conflict Evaluation Protocol**:
   - The SessionStart hook automatically parses active session claims.
   - If an active session occupies the same branch or worktree:
     - **STOP IMMEDIATELY!** DO NOT proceed with file edits or git mutations.
     - Report directly to the user detailing the owning session ID, reserved files, and latest heartbeat timestamp.
     - Present two explicit remediation paths:
       a) **Explicit Take-over**: Take over stale sessions (>2 hours without heartbeat updates) upon explicit user confirmation.
       b) **Isolated Worktree Allocation**: Create an independent git worktree on a distinct feature branch (`feat/*`).
3. **Dedicated Worktree Allocation**:
   Agents executing parallel or multi-phase tasks MUST use Git Worktrees:
   ```bash
   git worktree add .claude/worktrees/agent-auth feat/auth-pipeline
   ```
   - Each worktree maintains an independent checkout and branch.
   - Clean up worktrees upon task completion and branch merge:
     ```bash
     git worktree remove .claude/worktrees/agent-auth
     ```

### 2. Cross-Session Claim File Protocol (R2)
Because internal agent task lists are not synchronized across independent CLI processes, agents MUST rely on the filesystem claim registry as the single source of truth for concurrency:
- **Registry Directory**: `.claude/state/session-claims/<session-id>.json`.
- **Claim Schema**:
  ```json
  {
    "sessionId": "<unique-session-id>",
    "branch": "feat/<feature-name>",
    "worktree": ".claude/worktrees/<name>",
    "files": ["path/to/file1.go", "path/to/file2.ts"],
    "createdAt": "2026-09-15T05:00:00Z",
    "updatedAt": "2026-09-15T05:30:00Z",
    "taskDescription": "Concise summary of active task"
  }
  ```
- **Claim Execution Rules**:
  1. **Registration at Startup**: The SessionStart hook registers the base claim; the session appends touched paths via `heartbeatClaim`.
  2. **Periodic Heartbeat**: Refresh `updatedAt` on phase transitions or at minimum every 30 minutes via `heartbeatClaim`.
  3. **Stale Lease Window**: Claims without heartbeat updates exceeding 2 hours are marked stale and become reclaimable.
  4. **Release upon Completion**: The SessionEnd hook automatically invokes `releaseClaim` on process termination.
  5. **Pre-Edit File Gate**: Git guard hooks block destructive blanket operations overlapping active claims held by other sessions.

### 3. Prohibition of Destructive Git Commands in Shared Working Trees (R3)
In a shared working tree, uncommitted edits belonging to another session can be permanently destroyed by unconstrained git commands.
- **FORBIDDEN COMMANDS WHEN WORKING TREE CONTAINS OTHER SESSIONS' UNSTAGED WORK**:
  - ❌ `git stash` (blanket/bare stash): Traps another session's uncommitted work.
  - ❌ `git checkout -- .` / `git restore .` (blanket restore): Discards concurrent work.
  - ❌ `git clean -fd` / `git clean -fdx`: Permanently deletes new untracked files authored by peers.
  - ❌ `git reset --hard`: Wipes all uncommitted changes across all sessions.
- **PERMITTED GRANULAR OPERATIONS**:
  - ✅ Granular Stash: Stash only explicitly owned files:
    ```bash
    git stash push -m "session-A-wip" -- path/to/my-file1.go
    ```
  - ✅ Granular Discard: Discard only files registered to the current session's claim:
    ```bash
    git restore path/to/my-file1.go
    ```

### 4. Commit Hygiene & Strict Granular Staging (R4)
To prevent cross-session contamination of the git log:
- **STRICTLY PROHIBITED**:
  - ❌ `git add .` or `git add -A` when concurrent modified files exist.
  - ❌ `git commit -a` / `git commit -am "..."` (blindly stages all modified files).
  - ❌ Bare one-line commits for non-trivial changes (`feat`, `fix`, `refactor`, `perf`, or changes modifying 2+ files). All non-trivial commits MUST adhere to [`.agents/rules/git-semantic-commit-standard.md`](git-semantic-commit-standard.md).
- **MANDATORY COMMIT PROTOCOL**:
  1. **Explicit Staging**: Stage specific files individually:
     ```bash
     git add src/internal/service.go src/internal/service_test.go
     ```
  2. **Inspect Cached Diff**: Verify staged paths before committing:
     ```bash
     git diff --cached --name-only
     ```
     Ensure 100% of staged files belong exclusively to the active session.
  3. **Rich Semantic Conventional Commit**: Author commits adhering to [`.agents/rules/git-semantic-commit-standard.md`](git-semantic-commit-standard.md):
     - Header `<type>(<scope>): <concise imperative summary>` (max 72 chars, no trailing period).
     - Body containing Problem Statement & Motivation (WHY), bulleted `### Key Changes` (WHAT), and bulleted `### Verification & Evidence` (HOW).
     - Footer with `Refs:` and `Co-Authored-By:`.

### 5. Scoped Pre-Commit Quality Gates (R5)
Pre-commit hooks operate in staged-scoped mode:
- Secret scanning inspects only additions in `git diff --cached`.
- Compilation, static analysis (`go vet`), and formatters (`gofmt`) run against staged packages only.
- If pre-commit gates fail on dependencies outside the active session scope:
  1. STOP; DO NOT use `--no-verify` blindly.
  2. Report the conflict and isolate work into an independent Git Worktree.

### 6. Lost-Work Detection & Safe Stash Recovery Protocol (R6 & R8)
- If git diff disappears unexpectedly, or compiler errors flag missing modules that were previously completed:
  1. **STOP CODING IMMEDIATELY**. Do not rewrite code from memory over a corrupted git state.
  2. Inspect git status and reflog:
     ```bash
     git status --short
     git stash list
     git reflog -n 20
     ```
  3. **Safe Stash Recovery (R8 — HARD RULE)**:
     - DO NOT run `git checkout stash@{N} -- <path>` or `git stash pop` on a dirty working tree.
     - Create an isolated recovery branch:
       ```bash
       git checkout -b recover/<feature-name>
       git stash apply stash@{N}
       ```
     - Verify tests on the isolated branch, commit cleanly, and merge back. Drop stash only after successful commit verification.

### 7. Air-Gapped File Boundaries (Exclusive File Allocation)
When dispatching sub-agents, the Lead Orchestrator MUST partition file boundaries:
- **Single Ownership Principle**: Exactly one agent may edit a specific file at any given time.

### 8. Task Locking & Concurrency Discipline
- Before initiating work, agents MUST claim the task: `TaskUpdate(status: "in_progress")`.
- Agents MUST NOT claim tasks already active under another agent.

### 9. Sequential Merge Protocol (Rebase First)
When integrating feature branches into shared staging:
1. **First Come, First Merged**: The first completed branch merges directly.
2. **Rebase Before Merge**: Subsequent branches MUST rebase onto the updated target branch before submission:
   ```bash
   git fetch origin
   git rebase origin/staging
   ```
3. **Verify Locally**: Re-run local test suites in the worktree prior to merging.

---

## 🔄 SECTION 3: Zero-Drift Branch Reconciliation Protocol (MANDATORY)

To prevent stranded commits and cross-branch drift:

### 0. Mandatory Local Auto-Commit Upon Phase Completion (R7)
Every sub-phase or wave verified as DONE (passing tests and `- [x]` DoD checklist) MUST be committed locally IMMEDIATELY without waiting for user confirmation.
- **Local commits are safe, atomic, and reversible.** Confirmation is required ONLY for `git push`, PR creation, or branch merges.
- **R7.1 Cost-Optimized Commit Delegation Invariant**: For all verified local auto-commits, the Lead Orchestrator MUST delegate git operations to `git-master` using `model: "haiku"`. Dedicated high-reasoning models (Opus/Fable) are strictly reserved for planning, architecture, and review gates.
- Staging files explicitly -> verify via `git diff --cached --name-only` -> commit conventional message per [`.agents/rules/git-semantic-commit-standard.md`](git-semantic-commit-standard.md):
  ```bash
  git add <scoped-files>...
  git diff --cached --name-only
  git commit -m "feat(scope): concise description (phase-XX)" \
             -m "Motivation paragraph explaining WHY this phase was implemented." \
             -m "### Key Changes
  - file1: added implementation
  - file2: updated tests" \
             -m "### Verification & Evidence
  - just test: 100% pass
  - just go-build: 0 errors" \
             -m "Refs: .claude/plans/<suite>/index.md
  Co-Authored-By: Claude Code <{{AUTHOR_EMAIL}}>"
  ```
- Accumulating multiple uncommitted completed phases is strictly forbidden. Complete one phase -> commit -> advance to the next.

### 0b. Mandatory PRD Blueprint Clean Working Tree Commit Invariant (R7b)
Whenever a PRD blueprint suite in `.claude/plans/<suite-name>/` is created, updated, completed, or reconciled:
- The agent MUST immediately commit all `.claude/plans/<suite-name>/*.md` files with a rich semantic commit:
  ```bash
  git add .claude/plans/<suite-name>/*.md
  git commit -m "docs(plans): reconcile <suite-name> PRD blueprint (phase-XX)" \
             -m "Problem Context (Why):
  Reconcile PRD blueprint status, sub-phase deliverables, and DoD checklists." \
             -m "Key Changes (What):
  - .claude/plans/<suite-name>/index.md: marked status completed
  - .claude/plans/<suite-name>/phase-*.md: updated task checklists" \
             -m "Verification Evidence:
  - git status: clean working tree, zero untracked plans" \
             -m "Co-Authored-By: Claude Code <{{AUTHOR_EMAIL}}>"
  ```
- **STRICTLY FORBIDDEN**: Leaving `.claude/plans/` files untracked (`??`) or modified (`M`) in the working tree upon completing a phase or task. All plans MUST be cleanly tracked and committed. Working tree must remain 100% clean at all phase boundaries.

### 1. Zero Stranded Commits in Development
Whenever work completes on a development branch:
- Ensure all tests pass 100%.
- Ensure commits are integrated toward staging without leaving dangling local heads.

### 2. CI/CD Watchdog & Live Runtime Verification
- After executing `git push origin <branch>`:
- DO NOT assume changes are automatically active.
- Monitor automated CI/CD runs to completion:
  ```bash
  gh run watch <run_id>
  ```
- Upon `SUCCESS`, validate live ground-truth endpoints (HTTP 200).

### 3. End-of-Session Self-Check (Zero-Drift Assertion)
Before signaling task completion:
1. `git status`: Working tree clean (zero uncommitted or untracked operational files).
2. `git branch`: Verified on expected branch.
3. `git diff origin/<branch>`: Zero forgotten un-pushed local commits.

---

## 🛑 Branch Protection Rules (HARD RULE)

1. **Branch `main` is READ-ONLY for Development**: Agents MUST NOT perform exploratory coding, feature development, or direct fixes on `main`.
2. **Promotion via Official Pipeline Only**: Updates enter `main` solely through verified pipeline promotion gates after all staging checks pass 100%.

---

## §10. MCP JSON Runtime Artifact Governance (R10)

The tracked root `.mcp.json` containing `{}` is a **TEMPLATE**, not live configuration. Daemon-merged configurations are machine-local runtime artifacts, not cross-machine source of truth.

- **(a) Prohibit in Feature Commits**: Changes to `.mcp.json` MUST NOT be included in any phase or feature commits. Verifiers MUST reject any wave containing `.mcp.json` in staged diffs.
- **(b) Manual Revert Ban**: DO NOT run `git checkout -- .mcp.json` or `git restore .mcp.json` (the local daemon rewrites it during sync). Use fixup commits if erroneously committed previously.
- **(c) Mandatory Verifier Check**: Every verification gate MUST assert:
  ```bash
  git diff --name-only | grep -x '\.mcp\.json' && echo "REJECT: .mcp.json in diff" || echo "OK: .mcp.json clean"
  ```
- Tracked root `.mcp.json` MUST remain `{}` in source control.
- **(d) Windows Index Lock Release & Shell Invariants**: On Windows, git operations MUST proactively force-release stale index locks before staging/committing: `powershell -NoProfile -NonInteractive -Command "& { if (Test-Path .git/index.lock) { Remove-Item .git/index.lock -Force }; git add ...; git commit ... }"`. Never enter repetitive git exit code 128 retry loops. Shell invariants: always use forward-slash paths (`/` or `{{PROJECT_ROOT}} never unescaped `\` in Bash); never assume `cd` persists across tool turns — use stateless CWD discipline via `git -C <dir>` or single-turn compound commands (`cd <dir> && <cmd>`).
<!-- ACS workflow v1.6.1+12dfa56 -->
<!-- ACS workflow v1.33.0+c8a2f8a -->
