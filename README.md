# decern-gate

CLI that gates high-impact changes in CI: if your diff touches migrations, infra, or lockfiles, the pipeline requires a reference to an **approved** decision (e.g. in the PR description or commit message). Works on any CI using only **git** and **env vars** (GitHub Actions, GitLab CI, Jenkins, Bitbucket, Azure DevOps).

## Usage (local)

```bash
# Build (from repo root or package dir)
cd packages/decern-gate && npm install && npm run build

# Run (set env first)
export DECERN_BASE_URL=https://your-app.vercel.app
export DECERN_CI_TOKEN=your-workspace-ci-token
node dist/bin.js
# or, if linked: decern-gate
```

From repo root:

```bash
node packages/decern-gate/dist/bin.js
```

Or via npx (once published):

```bash
npx decern-gate
```

## Configuration

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DECERN_BASE_URL` | Yes (when decision required) | Base URL of the Decern app (e.g. `https://app.example.com`). No trailing slash. |
| `DECERN_CI_TOKEN` | Yes (when decision required) | CI token for the workspace (from Decern Dashboard → Workspace → Token CI). Never logged. |
| `DECERN_GATE_TIMEOUT_MS` | No | Timeout for the validate API call in ms. Default: `5000`. |
| `DECERN_VALIDATE_PATH` | No | Path to the validate endpoint. Default: `/api/decision-gate/validate`. |
| `DECERN_GATE_REQUIRE_LINKED_PR` | No | When `true` or `1`, the gate blocks unless the decision has this PR linked in Decern (validate API must return `hasLinkedPR: true`). If the API does not return `hasLinkedPR`, the gate blocks and suggests linking the PR or updating the API. |
| `DECERN_GATE_EXTRA_PATTERNS` | No | Comma-separated list of extra path/basename patterns that require a decision. Paths (containing `/`) match if the file path includes the string (e.g. `my-app/config/`); otherwise treated as basename exact match (e.g. `secret.conf`). Example: `DECERN_GATE_EXTRA_PATTERNS=internal/,config/prod.json`. |
| `CI_BASE_SHA` | No | Base commit for diff (e.g. target branch). |
| `CI_HEAD_SHA` | No | Head commit for diff (e.g. current branch). |
| `CI_PR_TITLE` | No | PR/MR title; used to extract `decern:<id>` if set. |
| `CI_PR_BODY` | No | PR/MR description; used to extract decision refs. |
| `CI_COMMIT_MESSAGE` | No | Full commit message; used if PR vars are not set. |

If `CI_BASE_SHA` and `CI_HEAD_SHA` are not set, the CLI tries `origin/main...HEAD`, then `origin/master...HEAD`, then `HEAD~1...HEAD`.

#### How to get DECERN_CI_TOKEN (workspace CI token)

The **workspace CI token** is created in the Decern app: open **Dashboard → Workspace** (the workspace you use for the repo), then the section **Token CI (Decision Gate)**. Only the workspace owner can generate or revoke it. The token is shown **once** at creation; store it in your CI secrets (e.g. `DECERN_CI_TOKEN`). It is never logged by the CLI.

#### DECERN_VALIDATE_PATH (default + override)

By default the CLI calls `/api/decision-gate/validate`. To use a different path (e.g. a proxy or another deployment), set `DECERN_VALIDATE_PATH` to the path only (e.g. `/api/v1/validate`). The URL is built from `DECERN_BASE_URL` + this path; the `decisionId` query param is always set by the CLI. Override only if your Decern instance exposes the validate endpoint elsewhere.

### Example command and output

```bash
export DECERN_BASE_URL=https://app.example.com
export DECERN_CI_TOKEN=your-token
node dist/bin.js
```

Example output when no high-impact files changed:

```
Changed files: 3
Decision required: NO
Reason: No high-impact file patterns matched.
```

### Validate endpoint (curl)

The CLI calls `GET ${DECERN_BASE_URL}${DECERN_VALIDATE_PATH}?decisionId=<id>` with a Bearer token. Example without a real token:

```bash
curl -s -H "Authorization: Bearer YOUR_CI_TOKEN" \
  "https://your-app.example.com/api/decision-gate/validate?decisionId=550e8400-e29b-41d4-a716-446655440000"
```

Response when approved: `200` with `{"valid":true,"decisionId":"...","status":"approved"}`. Otherwise `401`, `404`, or `422` with `{"valid":false,"reason":"..."}`.

## How it works

1. **Changed files** — `git diff --name-only base...head`.
2. **Policy** — If any file matches high-impact patterns (migrations, Dockerfile, lockfiles, workflows, etc.), a decision is **required**.
3. **Extract refs** — From PR title/body or commit message: `decern:<id>`, `DECERN-<id>`, or URLs containing `/decisions/<id>`.
4. **Validate** — Calls `GET ${DECERN_BASE_URL}/api/decision-gate/validate?decisionId=<id>` with `Authorization: Bearer ${DECERN_CI_TOKEN}`. First approved decision wins; otherwise exit 1.

**Fail-closed:** Timeout, network error, or 5xx → exit 1. Never log the token.

## CI examples

Three snippets for GitHub Actions, GitLab CI, and Jenkins. Set `DECERN_BASE_URL` and `DECERN_CI_TOKEN` as secrets or variables in your CI.

### 1) GitHub Actions

```yaml
- name: Decern gate
  env:
    DECERN_BASE_URL: ${{ secrets.DECERN_BASE_URL }}
    DECERN_CI_TOKEN: ${{ secrets.DECERN_CI_TOKEN }}
    CI_BASE_SHA: ${{ github.event.pull_request.base.sha }}
    CI_HEAD_SHA: ${{ github.event.pull_request.head.sha }}
    CI_PR_TITLE: ${{ github.event.pull_request.title }}
    CI_PR_BODY: ${{ github.event.pull_request.body }}
  run: node packages/decern-gate/dist/bin.js
  # or: npx decern-gate
```

For push (no PR), omit `CI_PR_*`; the CLI will use the last commit message.

### 2) GitLab CI

```yaml
decern-gate:
  script:
    - export DECERN_BASE_URL=$DECERN_BASE_URL
    - export DECERN_CI_TOKEN=$DECERN_CI_TOKEN
    - export CI_BASE_SHA=$CI_MERGE_REQUEST_DIFF_BASE_SHA
    - export CI_HEAD_SHA=$CI_COMMIT_SHA
    - export CI_PR_TITLE=$CI_MERGE_REQUEST_TITLE
    - export CI_PR_BODY=$CI_MERGE_REQUEST_DESCRIPTION
    - node packages/decern-gate/dist/bin.js
  variables:
    DECERN_BASE_URL: $DECERN_BASE_URL
    DECERN_CI_TOKEN: $DECERN_CI_TOKEN
```

Set `DECERN_BASE_URL` and `DECERN_CI_TOKEN` in GitLab CI/CD variables (masked).

### 3) Jenkins (generic shell)

```bash
export DECERN_BASE_URL="https://your-decern-app.com"
export DECERN_CI_TOKEN="$(cat /run/secrets/decern_ci_token)"
export CI_BASE_SHA="${GIT_PREVIOUS_COMMIT:-origin/main}"
export CI_HEAD_SHA="${GIT_COMMIT}"
# If you have PR title/body in env, set CI_PR_TITLE and CI_PR_BODY
node packages/decern-gate/dist/bin.js
```

## Output (deterministic)

- `Changed files: N`
- `Decision required: YES` or `NO` + reason
- `Found decision refs: id1, id2` or `none`
- `Validation result: OK (...)` or `FAIL for <id> — <reason>`

Exit 0 only when either decision is not required, or at least one referenced decision is validated as approved.
