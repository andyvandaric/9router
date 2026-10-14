---
name: ssot-config-governance
trigger: model_decision
description: "Single Source of Truth enforcement for config/path resolution: cliconfig facade discipline, no-duplicate-resolver ban, env isolation invariants, and drift detection."
---

# SSOT Config Governance & Path Resolution Standards

Authoritative Single Source of Truth (SSOT) standards for configuration resolution, system paths, database locations, and environment boundaries within the ACS ecosystem.

---

## 1. Single Facade Architecture (`cliconfig`)
All code in `src/internal/` MUST import and invoke centralized facade functions from `acs/internal/cliconfig`. Ad-hoc path resolution and direct parsing of path environment variables outside the facade package are strictly prohibited.

| Target Configuration | SSOT Facade Function | Underlying Provider | Standard Consumers |
|---|---|---|---|
| **Claude Settings Path** | `cliconfig.ClaudeSettingsPath()` | `os.UserHomeDir` + Precedence Env | `setup`, `server`, `doctor`, `agentic`, `uninstall`, `updater` |
| **Claude Config/Home Dir** | `cliconfig.ClaudeHomeDir()` | `CLAUDE_HOME` > `CLAUDE_CONFIG_DIR` > `~/.claude` | `setup`, `updater`, `agentic` |
| **Hermes Root Dir** | `cliconfig.HermesRoot()` | `hermespaths.Resolve().Home` | `agentic`, `gateways`, `server`, `doctor`, `setup` |
| **Hermes Profiles Dir** | `cliconfig.HermesProfilesDir()` | `filepath.Join(HermesRoot(), "profiles")` | `agentic`, `gateways`, `server` |
| **9router SQLite DB** | `cliconfig.NineRouterDBPath()` | `NINEROUTER_DB` > `UserConfigDir("9router")` | `server`, `daemon`, `doctor` |
| **ACS Skills Source Root** | `cliconfig.SkillsRoot()` | `ACS_SKILL_SOURCE_ROOT` > `env.SkillsDir()` | `agentic`, `setup`, `uninstall`, `doctor`, `toolprofile` |
| **Runtime Data Directory** | `env.DataDir()` / `cliconfig.DataDir()` | `~/.acs/data[-dev|-staging]` | `service`, `daemon`, `updater`, `kanban`, `pyenv` |

---

## 2. ⛔ Strict Prohibitions (No-Duplicate-Resolver Ban)
1. **DO NOT** author local path resolver helpers (such as `*SettingsPath()`, `*ConfigDir()`, `*DBPath()`) in any package. Always consume `cliconfig`.
2. **DO NOT** read environment variables (`USERPROFILE`, `HOME`, `APPDATA`, `CLAUDE_HOME`, `ACS_CLAUDE_SETTINGS`, `NINEROUTER_DB`) directly to resolve global configuration paths. Environment variable resolution belongs exclusively inside `cliconfig/paths_facade.go`.
3. **DO NOT** swallow configuration errors silently (`defaultConfig(), nil`). Failures reading `constants.json` MUST produce transparent errors or explicit invocations of `cliconfig.LoadOrDefault()`.
4. **DO NOT** hardcode service port numbers (`20128`, `20130`, `20150`, `20155`) in backend logic. Use `env.DashboardPort()` / `env.DaemonPort()` or explicit environment mappings.

---

## 3. Filesystem Mutation Safety Gates (mkdir / rmdir Zero-Ask Policy)
`Bash(mkdir *)` and `Bash(rmdir *)` operate in the `allow` bucket (zero-ask) to prevent autonomous long-running task interruptions. System safety is enforced via 5 layered gates:

1. **Root-Scope Hard Deny**: `Bash(rmdir /)` and `Bash(rmdir /*)` are hard-blocked via the `deny` bucket, alongside `rm -rf /`, `rm -rf /*`, `rm -rf {{PROJECT_ROOT}} and `rm -rf /c/*`.
2. **Project-Scope Boundary**: `mkdir`/`rmdir` MUST target paths strictly inside the active project workspace (`cwd`), temporary runtime directories (`%TEMP%`/`/tmp`), or ACS runtime roots (`~/.acs/`, `.claude/worktrees/`). Touching `{{PROJECT_ROOT}}:\Program Files`, `/etc`, `/usr`, `/System`, top-level `$HOME`, or drive roots is FORBIDDEN.
3. **Recursive-Delete Gate**: `rmdir` with recursive flags (`/s`, `/q`, `-r`, `--recursive`) or pipeline `rm -rf` outside `.claude/worktrees/`, `.acs/temp/`, and build output directories MUST require user confirmation.
4. **CLI-Only Settings Writes**: Modifications to `settings.json` (including permissions) MUST pass `automation.ValidateClaudePermissionRule` before application. Unvalidated direct edits are forbidden.
5. **Self-Healing Synchronization**: Running `acs setup` or `acs setup --force` prunes obsolete `Bash(rmdir *)` permissions from the `ask` bucket automatically, ensuring cross-machine policy convergence.

---

## 4. Pre-Write Inspection Checklist
Before introducing or modifying code involving configuration paths:
1. Verify if the target path is already exposed by `cliconfig`.
2. If a new path is required: declare it canonically in `constants.json` and expose it via `src/internal/cliconfig/paths_facade.go`.
3. Add unit test assertions ensuring parity across Windows, Linux, and macOS.

---

## 5. Web Ecosystem Version SSOT Invariant
`packages/ui-shared/lib/version.ts` is the single source of truth for ACS binary release versions across all UIKode web portals.
- **Dynamic Interpolation**: Any component displaying version badges or metadata (e.g. `HomeProductSuite.astro`, `AcsHero.astro`, `jsonld.ts`) MUST import and dynamically interpolate `ACS_VERSION` and `ACS_RELEASE_DATE` from `packages/ui-shared/lib/version.ts`.
- **Hardcoding Ban**: Hardcoding version numbers in component default props, Astro template attributes, or schema markup is strictly forbidden.
- **Automated Pipeline Bump**: The release pipeline (`tools/pipeline/portal.py`) MUST automatically update `version.ts` on every release via `_bump_version_ts`, ensuring zero version drift across web portals upon release.
<!-- ACS workflow v1.6.1+cdbf20a -->
<!-- ACS workflow v1.33.0+897b87d -->
