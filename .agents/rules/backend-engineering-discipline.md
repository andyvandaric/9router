---
name: backend-engineering-discipline
trigger: backend, tdd, rgr, red-green, red-green-refactor, test-driven, unit test, test suite, test harness, api, endpoint, database, handler, service, go, python, rust, typescript
description: "Universal backend engineering discipline and strict TDD cycle (Red-Green-Refactor): enforces writing failing tests first before implementation, test harness, strict typing, error wrapping, async/concurrency, and zero production DB mutation."
---

# Universal Backend Engineering Discipline (Agnostic Stack)

Authoritative architectural and execution guidelines for backend development across language stacks (Go, TypeScript/Node.js, Python, Rust, Java/C#).

---

## 1. Agnostic Code Standards

### Go
- **Error Handling**: MUST handle every error and wrap with operational context:
  ```go
  if err != nil {
      return fmt.Errorf("execute operation %s: %w", target, err)
  }
  ```
- **Parallelism / Concurrency**: MUST use `errgroup.WithContext` for synchronized parallel tasks.
- **Concurrency Limits**: MUST adapt dynamically to host memory tiers.

### TypeScript / Node.js
- Strict mode active; DO NOT use type `any` (use `unknown` or bounded generics).
- Prefer `const` over `let`. Use early returns instead of deeply nested `if/else`.
- **Immutability**: Use spread syntax `{ ...item, status: 'done' }`, `[...items, newItem]`. DO NOT mutate shared state objects or arrays in place.
- **Parallel Execution**: Use `Promise.all` or `Promise.allSettled` for independent asynchronous calls.

### Python
- MUST provide explicit type annotations (`typing` module or Python 3.10+ union types `str | None`).
- Use Pydantic or dataclasses for data modeling and service boundary contracts.
- Use context managers (`with` statements) for resource lifecycles (database connections, files, locks).
- Enforce structured asynchronous concurrency using `asyncio.gather` or `asyncio.TaskGroup`.

### Rust
- Use `Result<T, E>` with the `?` operator; wrap error context using `anyhow` or `thiserror`.
- DO NOT use `.unwrap()` in production paths (acceptable in unit tests only).

---

## 2. Universal TDD Cycle (Red-Green-Refactor) — SINGLE SOURCE OF TRUTH (MANDATORY STRICT)

**DO NOT write implementation code before a unit or integration test has been authored and proven to fail (RED).**
Agents MUST NOT implement functions, API endpoints, or business logic without an active test harness.

### 5-Step TDD RGR Protocol:
1. **Define Contracts & Expectations**: Specify inputs, outputs, invariants, and error contracts upfront.
2. **RED (Failing Test)**:
   - Write the minimal unit/integration test exercising the expected behavior.
   - Run the test runner (e.g., `go test -v ./pkg -run TestX` or `bun test`).
   - **CONFIRM FAILING TEST (RED)** due to the expected functional deficiency (not syntax or import errors).
3. **GREEN (Minimal Implementation)**:
   - Write the smallest possible implementation to pass the test.
   - DO NOT introduce speculative abstractions or unnecessary helpers. Focus solely on passing tests.
4. **REFACTOR**:
   - Clean up code structure, eliminate redundancy, and apply KISS > DRY > YAGNI while maintaining green tests.
   - Respect file limits (tolerance 300 LOC, hard block at 500 LOC, functions ≤50 LOC, max nesting ≤3 levels).
5. **Regression Guard Sweep**:
   - Run full package tests (`go test ./...` or `just test`) to verify zero unintended regressions.
   - **DO NOT** weaken, delete, or bypass failing test assertions.

### TDD Scope Matrix

| Scope of Work | Mandatory TDD RGR? | Execution Protocol |
|---|---|---|
| Business logic, algorithms, calculations | **MANDATORY** | Failing test -> Run fail -> Minimal implementation -> Pass -> Refactor |
| API handlers, route endpoints, payloads | **MANDATORY** | HTTP mock test -> Run fail -> Wire handler -> Pass |
| Database queries, migrations, stores | **MANDATORY** | Isolated temp DB test -> Run fail -> Implement -> Pass |
| Bug fixes & issue reproduction | **MANDATORY** | Write reproduction test -> Run fail -> Fix code -> Pass |
| Pure UI styling (Tailwind CSS, visual tweaks) | Exempt | Direct implementation -> Browser visual verification |
| Router constants, imports, documentation | Exempt | Static analysis & linter checks |

---

## 3. Test Database Isolation (Zero Production DB Mutation)

**DO NOT connect test suites to live or production SQLite databases.**
- Invoking `db.Open()` without path isolation risks running `DELETE`, `TRUNCATE`, or `UPDATE` operations against user production data.
- **MUST use Isolated Temporary Databases**:
  - Individual test level: `tempDB := filepath.Join(t.TempDir(), "test.sqlite"); db.InitWithPath(tempDB); t.Cleanup(func() { db.Close() })`.
  - Package level: `TestMain(m *testing.M)` with an isolated temp directory via `os.TempDir()`.
- All mocks, fixtures, and database assertions MUST target temporary databases cleaned up immediately on test completion.

---

## 4. General Function & Naming Discipline
- Maximum 50 lines per function, maximum 3 logical nesting levels.
- Named constants for magic values (`const MAX_RETRY_COUNT = 3`).
- Naming conventions: Verb-Noun pattern (`fetchUserData`, `validateToken`, `calculateHash`).
- Avoid ambiguous abbreviations in public variables (`query` not `q`, `timeoutSeconds` not `t`).

---

## 5. Subprocess Execution & Memory Governance

- **Zero Console Window Standard**: Windows subprocess execution MUST adhere strictly to the central rules in `CLAUDE.md` using `internal/executil`.
- **Node.js Heap Clamping**: Node.js child processes spawned from the backend MUST use `executil.ClampNodeMemoryLimit(env)` (`--max-old-space-size=2048`) to prevent memory exhaustion and browser OOM crashes.
- **Windows File Lock Quarantine**: Executable and npm update processes on Windows MUST utilize pre-flight quarantine staging directories to prevent `EBUSY / -4082` lock collisions.

---

## 6. Runtime Boundary Contracts (Mandatory Across All Stacks)

These rules govern behavioral contracts referenced by `prd-blueprint-standard.md`.

### A. Universal Principles (Stack-Agnostic)

- **Runtime Validation at Trust Boundaries**: Every input crossing an untrusted boundary (HTTP payload, CLI arguments, message queues, file imports) MUST be validated by an executable schema at runtime. Static types alone are insufficient. Validation failures MUST produce a standardized, structured error contract. Raw framework errors MUST NOT leak to callers.
- **Monetary Values as Integers**: Monetary amounts MUST be represented as integer units (cents, smallest denomination). Floating-point numbers are FORBIDDEN for currency. Domain adjustment formulas (suffixes, fees, discounts) MUST be documented as invariants and tested via deterministic assertions.
- **Normalized Idempotency Keys**: Inputs MUST be deterministically canonicalized prior to hashing or deduplication (sort collections by business keys, trim whitespace, normalize string cases). Equivalent input permutations MUST yield identical idempotency keys.
- **Atomic Multi-Record Writes**: Operations touching multiple records within a single business transaction MUST be wrapped in transactional primitives with all-or-nothing semantics. If any item fails, the entire transaction MUST roll back. Test suites MUST include failure-rollback scenarios.

### B. Stack Implementation Examples (Illustrative Guidance)

- **TypeScript / Hono / Drizzle-SQLite**: Zod schema with `zValidator`; structured response envelope `{success, error, code, details}`; database transactions via `BEGIN IMMEDIATE ... COMMIT`.
- **Go**: Struct validation (`go-playground/validator` or equivalent); standard API error structs; transactional persistence via driver `sql.Tx`.
- **Python**: Pydantic models for boundary validation; standardized FastAPI response schemas; transaction management via ORM transaction managers.

---

## 7. Process Isolation, Concurrency & Resilience Invariants (Mandatory)

1. **Targeted Non-Tree-Kill Process Lifecycle**:
   - When restarting or terminating single background services (such as the core dashboard or proxy layers), NEVER use recursive tree-kill (`taskkill /F /T`). ALWAYS use targeted single-PID termination (`taskkill /F /PID <pid>` / `StopSingleProcess(pid)`) to ensure child or peer background services (such as 9router on port 20128) are not inadvertently terminated.
2. **Singleton Database Pool Lifecycle (`open9rDB`)**:
   - Calling `defer db.Close()` on singleton connection pools (`open9rDB()`) is STRICTLY FORBIDDEN. Singleton database pools must remain open for the entire process lifetime and only close during graceful shutdown via `Close9rDB()`. Premature closure causes fatal `sql: database is closed` errors and use-after-free panics across concurrent handlers.
3. **SafeGo Goroutine Panic Shield & WebSocket Concurrency**:
   - All background goroutines MUST be wrapped with `SafeGo` (`server.SafeGo`) to intercept panics and log stack traces. Naked `go func() { ... }()` calls that risk crashing the entire OS process on unexpected panics are prohibited.
   - WebSocket client connections (`wsClient`) MUST be guarded by a per-connection `writeMu sync.Mutex` before invoking `conn.WriteMessage` to prevent concurrent write panics and frame interleaving.
4. **Auto-Heal & Watchdog Anti-Flapping**:
   - HTTP health check probes must have a timeout of at least 8 seconds with a 2x consecutive failure retry buffer.
   - All auto-heal and respawn loops MUST integrate the persistent `watchdog.RestartTracker` (max 3 restarts per 15-minute window) and enforce a minimum 45-second cold-boot grace period to eliminate flapping and cascading death loops.

---

## 8. Ban on Shell-Based File Writing (Strict Native Write & Edit Invariant)

1. **Mandatory Native Tooling**: All agents MUST create and update files using the native `Write` and `Edit` tools. Native tools ensure atomic updates, preserve CRLF/LF line endings, integrate with file tracking harnesses, and execute 10x faster with zero subprocess overhead.
2. **Absolute Prohibition of Shell Workarounds**: Using shell hacks such as `echo ... > file`, `cat << 'EOF' > file`, `powershell Set-Content`, `python -c "open('file','w').write(...)"`, or `echo ... | base64 -d > file` to create or update files on disk is STRICTLY FORBIDDEN. These workarounds bypass file safety checks, corrupt characters/newlines, trigger Windows console flashing, and produce dirty session transcripts.
3. **Read-Only Persona Contract**: If an agent persona is read-only (such as `oh-my-claudecode:architect` or `oh-my-claudecode:critic` where `Write` and `Edit` tools are intentionally omitted from its tool profile), the sub-agent is STRICTLY FORBIDDEN from using shell tricks (`base64`, `cat`, Python/Node scripts) to write files to disk. The sub-agent MUST output the full technical specification or markdown blueprint directly in its response text, allowing the Lead Orchestrator or an authorized `executor` sub-agent to persist it using the native `Write` tool.
<!-- ACS workflow v1.6.1+831dc6d -->
<!-- ACS workflow v1.33.0+b5ca42b -->
