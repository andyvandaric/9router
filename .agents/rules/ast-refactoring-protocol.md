---
name: ast-refactoring-protocol
trigger: refactor, ast, ast-grep, syntax-transform, rename, symbol, tree-sitter, code-mod, batch-replace, pattern-replace
description: "AST-driven automated refactoring protocol: rules for using ast_grep_search, ast_grep_replace, and LSP rename vs line-based Edit, meta-variable patterns for TS/JS/Go/Python, dryRun preview, and compile verification guardrails."
---

# AST-Driven Automated Refactoring Protocol

This document defines the authoritative standard for Abstract Syntax Tree (AST)-driven code refactoring and semantic symbol renaming.
Adherence to this protocol prevents syntax regressions, unintended replacements in comments or string literals, and multi-file refactoring drift caused by naive text manipulation (such as regex, plain string replacement, or raw line-by-line edits).

---

## 1. When to Use AST/LSP vs Line-Based Edits

| Operation Scenario | Mandatory Tool | Scope & Rationale |
|---|---|---|
| **Cross-File Symbol / Identifier Renaming (Functions, Variables, Interfaces, Types)** | `lsp_prepare_rename` -> `lsp_rename` | Precise semantic renaming across the workspace; does not alter comments, string literals, or shadowing local identifiers. |
| **Repeated Syntax Pattern Transformations (Code-mods / Anti-pattern Replacement)** | `ast_grep_search` -> `ast_grep_replace` | Parses Tree-Sitter AST syntax; ignores whitespace/indentation discrepancies and safely manipulates sub-trees. |
| **Large File Refactoring (>200 LOC) with Multiple Pattern Instances** | `ast_grep_replace` | Prevents line-offset errors and partial edits across large files. |
| **Cleaning or Replacing Logging, Error Handling, and Deprecated APIs** | `ast_grep_replace` | Captures complete expressions alongside dynamic parameter lists (`$$$ARGS`). |
| **New Feature Additions / Isolated Local Modifications (<30 LOC)** | Native `Edit` / `Write` | Faster and more direct for localized single-file logic without repeating structural patterns. |
| **Non-Code File Edits (Markdown, Config JSON/YAML, Plain Text)** | Native `Edit` / `Write` / `Grep` | AST matchers target Tree-Sitter-supported programming languages only. |

### Mandatory Rules
- **DO NOT** use global regex replacements (`sed`, plain string replace) to rename functions, types, or API invocations across codebases when the target has an AST representation.
- **MUST** evaluate whether the refactoring is solvable via `lsp_rename` (for pure symbol renaming) or `ast_grep_replace` (for structural expression and block transformations).

---

## 2. Meta-Variable Syntax Patterns (Tree-Sitter AST)

`ast_grep` utilizes meta-variables to capture AST nodes:
- `$NAME`: Captures exactly **one** AST node (identifier, expression, or literal).
- `$$$ARGS`: Captures **zero or more** consecutive AST nodes (function arguments, statements inside a block, parameter lists).

### A. TypeScript / JavaScript / TSX
- **Console Log to Structured Logger:**
  - Pattern: `console.log($MSG)`
  - Replacement: `logger.info($MSG)`
- **Loop Modernization:**
  - Pattern: `$ARRAY.forEach(($ITEM) => { $$$BODY })`
  - Replacement: `for (const $ITEM of $ARRAY) { $$$BODY }`
- **Standardized Error Wrapping:**
  - Pattern: `catch ($ERR) { throw $ERR }`
  - Replacement: `catch ($ERR) { throw new Error(\`Operation failed: \${$ERR}\`) }`
- **Module Import Restructuring:**
  - Pattern: `import { $$$IMPORTS } from 'legacy-module'`
  - Replacement: `import { $$$IMPORTS } from '@/lib/new-module'`

### B. Go
- **Standardized Error Wrapping:**
  - Pattern: `if err != nil { return err }`
  - Replacement: `if err != nil { return fmt.Errorf("$OP: %w", err) }`
- **Function Signature Migration:**
  - Pattern: `func $NAME($$$ARGS) ($RET, error) { $$$BODY }`
  - Replacement: `func $NAME(ctx context.Context, $$$ARGS) ($RET, error) { $$$BODY }`
- **Mutex Lock/Unlock Wrapping:**
  - Pattern: `$MU.Lock(); $$$BODY; $MU.Unlock()`
  - Replacement: `$MU.Lock(); defer $MU.Unlock(); $$$BODY`

### C. Python
- **String Formatting Modernization:**
  - Pattern: `"%s" % ($VAL)`
  - Replacement: `f"{$VAL}"`
- **Context Manager Enforcement:**
  - Pattern: `$F = open($PATH); $$$BODY; $F.close()`
  - Replacement: `with open($PATH) as $F: $$$BODY`

---

## 3. Three-Step Refactoring Guardrails (Safe Execution Flow)

Every agent executing AST-driven refactoring MUST adhere to three sequential phases:

```text
[Phase 1: Search & Preview]
ast_grep_search (identify targets)
       ↓
ast_grep_replace (dryRun: true) ──→ Verify diff preview & node captures
       ↓
[Phase 2: Atomic Execution]
ast_grep_replace (dryRun: false) ──→ Apply changes to disk
       ↓
[Phase 3: Compile & Diagnostics Verification]
lsp_diagnostics / go test / tsc ──→ Verify 0 syntax errors & 0 type regressions
```

### Guardrail Checklist
1. **Preview First (`dryRun: true`)**:
   - MUST NOT execute `dryRun: false` without inspecting the diff output of `dryRun: true`.
   - Verify that meta-variables do not capture unintended expressions (such as truncated comments or broken nested blocks).
2. **Post-Replace Verification**:
   - For Go: Run `lsp_diagnostics` on modified files, or run `just go-build` / `just test`.
   - For TypeScript: Run `lsp_diagnostics`, `bun test`, or `tsc --noEmit`.
   - On syntax errors or compilation failures, immediately rollback or repair before proceeding.

---

## 4. AST Parse Verification Gate & Anti-Silent-Fallback Standard

When `ast_grep_search` or `ast_grep_replace` produces a syntax parse error or invalid capture on complex syntax (such as Go generics `[T any]` or TS template literal types):

1. **STRICT FALLBACK BAN**: The agent is STRICTLY FORBIDDEN from silently falling back to regex replacements, sed scripts, or blanket line edits on the affected file. The first unacknowledged fallback attempt is blocked by the `ast-verify-gate` hook (protocol exit code 2) with actionable stderr guidance.
2. **DIAGNOSTIC EMISSION**: The agent MUST emit an `AST_SYNTAX_ERROR` report specifying:
   - Target file & line number.
   - Exact syntax construct that caused the parse failure.
   - Recommended escalation path:
     - For pure symbol renaming -> `lsp_prepare_rename` -> `lsp_rename`.
     - For structural changes -> Guided manual edit with compiler verification (`go build` / `tsc --noEmit`).
3. **ESCALATION LADDER** (in order, stop at first that applies):
   - **L1 — Retry AST with narrower pattern**: shrink the pattern to the smallest failing construct, re-run `dryRun: true`. If the narrow pattern parses, proceed.
   - **L2 — LSP rename**: if the change is a pure symbol rename, use `lsp_prepare_rename` -> `lsp_rename` and verify with `lsp_diagnostics`.
   - **L3 — Guided manual edit**: acknowledge the hook warning, apply a minimal manual `Edit`, then immediately clear the gate via `lsp_diagnostics` / `go test` / `tsc --noEmit` on the file.
   - **L4 — Escalate to human/architect**: if L1–L3 all fail twice (2-Strike Rule), report `AST_SYNTAX_ERROR` with file, construct, and attempted patterns instead of retrying blindly.
4. **REJECTION TRIGGERS** (concrete cases the gate blocks):
   - `Edit`/`Write` on a parse-failed file before acknowledging the warning.
   - `sed`/`awk`/`perl -pi` shell fallbacks targeting a parse-failed file.
   - Deleting or hand-editing the gate state file (`.claude/state/ast-gate/<session>.json`) to bypass the block.
5. **CLEARANCE**: the failure record clears only via `lsp_diagnostics` or a compiler/test command (`go build`, `go test`, `tsc --noEmit`, `bun test`) targeting the file. Clearance restores normal edit flow.
<!-- ACS workflow v1.6.1+37d7707 -->
<!-- ACS workflow v1.33.0+b9288b1 -->
