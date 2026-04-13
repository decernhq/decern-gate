# decern-gate

CI gate that evaluates every pull request against your Architecture Decision Records (ADRs) using your BYO LLM. Blocks violations, warns on ambiguity, and detects new architectural patterns not covered by existing ADRs.

## Commands

```bash
decern gate              # Evaluate PR against ADRs (default)
decern init              # Bootstrap: analyze codebase, propose ADR drafts
decern adr sync          # Push ADR index to cloud dashboard
decern verify-evidence   # Verify an evidence export bundle
```

## How the gate works

1. Reads approved ADRs from `docs/adr/*.md` (local filesystem)
2. Gets the PR diff (`git diff base...head`)
3. **Scope pre-filter**: skips ADRs whose glob patterns don't match changed files
4. **LLM evaluation**: for each relevant ADR, sends a scope-filtered diff to your BYO LLM (concurrent, limit configurable)
5. **Confidence threshold**: violations below threshold are degraded from blocking to warning
6. **Signal detection**: in parallel, scans for new architectural patterns not covered by any ADR (1-3 signals max)
7. Reports evidence to cloud (if configured)

## Verdicts

| Result | Meaning | Blocks CI? |
|---|---|---|
| `pass` | Diff respects the ADR | No |
| `violation` + `blocking` + confidence >= threshold | Clear violation | **Yes** |
| `violation` + `blocking` + confidence < threshold | Ambiguous, degraded to warning | No |
| `violation` + `warning` | Advisory only | No |
| `unrelated` | ADR not relevant to this diff | No |
| `skipped` | Scope pre-filter, no LLM call | No |
| `error` | LLM failure, fail-open | No (logged) |

## Environment variables

### Required

| Variable | Description |
|---|---|
| `DECERN_LLM_BASE_URL` | LLM API base URL (e.g. `https://api.anthropic.com` or `https://api.openai.com/v1`) |
| `DECERN_LLM_API_KEY` | LLM API key |
| `DECERN_LLM_MODEL` | Model ID (e.g. `claude-sonnet-4-6`, `gpt-4o`) |

### Optional

| Variable | Default | Description |
|---|---|---|
| `DECERN_ADR_DIR` | `docs/adr` | Path to ADR directory |
| `DECERN_BASE_URL` | — | Cloud dashboard URL (enables reporting) |
| `DECERN_CI_TOKEN` | — | Workspace CI token (enables reporting) |
| `DECERN_CONFIDENCE_THRESHOLD` | `0.75` | Min confidence to block (0-1) |
| `DECERN_EVAL_CONCURRENCY` | `3` | Max parallel LLM calls for ADR evaluation |
| `CI_BASE_SHA` | auto-detected | Base commit for diff |
| `CI_HEAD_SHA` | auto-detected | Head commit for diff |
| `CI_PR_URL` | — | PR URL (for cloud PR comments) |
| `CI_PR_TITLE` | — | PR title |

## Recommended models

Tested and recommended for production: `claude-sonnet-4-6`, `claude-opus-4-6`, `gpt-4o`, `gpt-4.1`, `gpt-5`, `gemini-2.5-pro`.

Smaller models (gpt-4o-mini, claude-haiku) work but produce more false negatives. A runtime warning is logged when using a non-recommended model.

## CI examples

### GitHub Actions

```yaml
- name: Decern gate
  run: npx decern gate
  env:
    DECERN_LLM_BASE_URL: https://api.anthropic.com
    DECERN_LLM_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
    DECERN_LLM_MODEL: claude-sonnet-4-6
    DECERN_BASE_URL: ${{ secrets.DECERN_BASE_URL }}
    DECERN_CI_TOKEN: ${{ secrets.DECERN_CI_TOKEN }}
    CI_PR_URL: ${{ github.event.pull_request.html_url }}
```

### GitLab CI

```yaml
decern-gate:
  script: npx decern gate
  variables:
    DECERN_LLM_BASE_URL: https://api.anthropic.com
    DECERN_LLM_API_KEY: $ANTHROPIC_API_KEY
    DECERN_LLM_MODEL: claude-sonnet-4-6
```

## ADR format

```yaml
---
id: ADR-007
title: Use PostgreSQL for persistence
status: approved
enforcement: blocking
scope:
  - src/db/**
  - migrations/**
supersedes: null
date: 2026-04-10
---

## Context
...

## Decision
...

## Consequences
...
```

## Evidence

When `DECERN_BASE_URL` + `DECERN_CI_TOKEN` are set, the gate reports to the cloud:
- Hash-chained, Ed25519-signed evidence record per gate run
- ADR evaluations with confidence scores
- Signal data (Case C)
- PR comments for violations and nudges

## License

Apache-2.0
