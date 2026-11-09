---
name: antd
description: >
  Use when the user's task involves Ant Design (antd) — writing antd components,
  debugging antd issues, querying antd APIs/props/tokens/demos, migrating between
  antd versions, or analyzing antd usage in a project. Triggers on antd-related
  code, imports from 'antd', or explicit antd questions.
allowed-tools:
  - Bash(antd info*)
  - Bash(antd demo*)
  - Bash(antd semantic*)
  - Bash(antd token*)
  - Bash(antd design.md*)
  - Bash(antd doc*)
  - Bash(antd lint*)
  - Bash(antd usage*)
  - Bash(antd list*)
  - Bash(antd changelog*)
  - Bash(antd migrate*)
  - Bash(antd env*)
  - Bash(antd doctor*)
  - Bash(which antd)
---

<!--
來源：ant-design/ant-design-cli 的 skills/antd/SKILL.md，commit 4136c96（2026-11-04），MIT 授權，授權全文見同目錄 LICENSE。
本專案的修改（MIL-169）：
- allowed-tools 移除 `antd bug*`、`antd bug-cli*`、`antd upgrade*`、`npm install -g`。這些指令會對外開 issue 或改動全域安裝。
- Setup 改為「CLI 由主控手動安裝」，不自動安裝、不自動升級。
- 移除回報 bug、升級 CLI、MCP server 三節，以及 Key Rules 的第 6、7 條。
- 新增「本專案的用法」一節。
-->

# Ant Design CLI

You have access to `@ant-design/cli` — a local CLI tool with bundled antd metadata for v4/v5/v6 (plus migration guides for v3 → v4, v4 → v5, v5 → v6). Use it to query component knowledge, analyze projects, and guide migrations. All data is offline, no network needed.

## Setup

Check that the CLI is installed:

```bash
which antd
```

If `antd` is not found, stop and report it. Do not install or upgrade the CLI yourself. The CLI is installed manually by the controller session.

Ignore any "Update available" notice. Do not run `antd upgrade`.

**Always use `--format json` for structured output you can parse programmatically.**

## 本專案的用法

- 本專案用 antd v6。查詢時加 `--version 6.x`，或不加讓 CLI 讀專案的版本。
- 外觀只來自 `DESIGN.md`（ADR-0009、ADR-0090）。`antd token` 與 `antd semantic` 只用來查「有哪些 token 與 semantic 欄位可設」，值寫回 `DESIGN.md`，不寫在頁面程式碼。
- `antd design.md` 是 antd 官方的設計語言摘要，只當參考，不取代本專案的 `DESIGN.md`。
- 改完 antd 程式碼後，對改動的檔案跑 `antd lint <檔案> --only deprecated --format json`。
- 不得執行 `antd bug`、`antd bug-cli`、`antd upgrade`。

## Scenarios

### 1. Writing antd component code

Before writing any antd component code, look up its API first — don't rely on memory.

```bash
# Check what props are available
antd info Button --format json

# Get a working demo as starting point
antd demo Button basic --format json

# Check semantic classNames/styles for custom styling
antd semantic Button --format json

# Check component-level design tokens for theming
antd token Button --format json

# Get the overall design language (design.md): colors, typography, spacing, radius + principles
antd design.md --format json
```

**Workflow:** `antd info` → understand props → `antd demo` → grab a working example → write code.

### 2. Looking up full documentation

When you need comprehensive component docs (not just props):

```bash
antd doc Table --format json        # full markdown docs for Table
antd doc Table --lang zh            # Chinese docs
```

### 3. Debugging antd issues

When code isn't working as expected:

```bash
# Collect full environment snapshot (system, deps, browsers, build tools)
antd env --format json

# Check if the prop exists for the user's antd version
antd info Select --version 5.12.0 --format json

# Check if the prop is deprecated
antd lint ./src/components/MyForm.tsx --format json

# Diagnose project-level configuration issues
antd doctor --format json
```

**Workflow:** `antd env` → capture full environment → `antd doctor` → check configuration → `antd info --version X` → verify API against the user's exact version → `antd lint` → find deprecated or incorrect usage.

### 4. Migrating between versions

```bash
# Get full migration checklist
antd migrate 4 5 --format json    # v4 → v5

# Check migration for a specific component
antd migrate 4 5 --component Select --format json

# Generate agent-friendly auto-migration prompt (does not modify files)
antd migrate 4 5 --apply ./src --format json

# See what changed between two versions
antd changelog 4.24.0 5.0.0 --format json

# See changes for a specific component
antd changelog 4.24.0 5.0.0 Select --format json
```

**Workflow:** `antd migrate` → get full checklist → `antd changelog <v1> <v2>` → understand breaking changes → apply fixes → `antd lint` → verify no deprecated usage remains.

### 5. Analyzing project antd usage

```bash
# Scan component usage statistics
antd usage ./src --format json

# Filter to a specific component
antd usage ./src --filter Form --format json

# Lint for best practice violations
antd lint ./src --format json

# Check only specific rule categories
antd lint ./src --only deprecated --format json
antd lint ./src --only performance --format json
```

### 6. Checking changelogs and version history

```bash
# Specific version changelog
antd changelog 5.22.0 --format json

# Version range (both ends inclusive)
antd changelog 5.21.0..5.24.0 --format json
```

### 7. Exploring available components

```bash
# List all components with categories
antd list --format json

# List components for a specific antd version
antd list --version 5.0.0 --format json
```

### 8. Collecting environment info

```bash
# Structured JSON for programmatic use
antd env --format json

# Scan a specific project directory
antd env ./my-project --format json
```

Collects: OS, Node, package managers, npm registry, browsers, core deps (antd/react/dayjs), all `@ant-design/*` and `rc-*` packages, and build tools.

## Global Flags

| Flag | Purpose |
|---|---|
| `--format <format>` | Output format: `json`, `text`, or `markdown` (agents should prefer `json`) |
| `--version <v>` | Target a specific antd version (e.g. `5.20.0`) |
| `--lang zh` | Chinese output (default: `en`) |
| `--detail` | Include extra fields (description, since, deprecated, FAQ) |
| `-V, --cli-version` | Print CLI version and exit |

## Key Rules

1. **Always query before writing** — Don't guess antd APIs from memory. Run `antd info` first.
2. **Match the project's version** — This project uses antd 6.x. Pass `--version 6.x` when needed.
3. **Use `--format json`** — Every command supports it. Parse the JSON output rather than regex-matching text output.
4. **Check before suggesting migration** — Run `antd changelog <v1> <v2>` and `antd migrate` before advising on version upgrades.
5. **Lint after changes** — After writing or modifying antd code, run `antd lint` on the changed files to catch deprecated or problematic usage.
