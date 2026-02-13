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
| `DECERN_GATE_JUDGE_ENABLED` | No | When `true` or `1`, the judge step runs after validate. Default: disabled. Set to `true` once your Decern backend exposes the judge endpoint. |
| `DECERN_JUDGE_PATH` | No | Path to the judge endpoint. Default: `/api/decision-gate/judge`. |
| `DECERN_GATE_JUDGE_TIMEOUT_MS` | No | Timeout for the judge API call in ms. Default: `60000`. |

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
3. **Extract refs** — From PR title/body or commit message: `decern:<id>`, `DECERN-<id>`, or URLs containing `/decisions/<id>`. If multiple refs are present, only the **last** one is used for the judge step.
4. **Validate** — Calls `GET ${DECERN_BASE_URL}/api/decision-gate/validate?decisionId=<id>` (or `adrRef=...`) with `Authorization: Bearer ${DECERN_CI_TOKEN}`. If no referenced decision is approved, the gate blocks and the judge step is **not** run.
5. **Judge** (optional, when `DECERN_GATE_JUDGE_ENABLED` is set to `true`) — After validate passes, calls `POST ${DECERN_BASE_URL}${DECERN_JUDGE_PATH}` with the **full diff** (subject to exclusions and a 2MB cap; see [Judge (LLM as a judge)](#judge-llm-as-a-judge)) and the single decision ref (ADR or decision ID). The backend uses an LLM to decide whether the diff is consistent with the decision. If the judge does not allow the change, the gate blocks.

**Fail-closed:** Timeout, network error, or 5xx → exit 1. Never log the token.

## Trunk-based development

decern-gate works with a **trunk-based** workflow (single main branch, direct pushes or short-lived branches) **only if CI passes explicit refs**.

- **With `CI_BASE_SHA` and `CI_HEAD_SHA` set** — It works as intended. Configure CI so that:
  - **Base** = commit before the push (e.g. previous main tip or `GIT_PREVIOUS_COMMIT`)
  - **Head** = current commit (e.g. `GIT_COMMIT` or `HEAD`)

  The Jenkins example in [CI examples](#ci-examples) already does this for pushes to main: `CI_BASE_SHA="${GIT_PREVIOUS_COMMIT:-origin/main}"` and `CI_HEAD_SHA="${GIT_COMMIT}"`. The diff is then “what this push changed” and the gate applies correctly.

- **Without `CI_BASE_SHA` / `CI_HEAD_SHA` (fallback only)** — Behavior is wrong for direct pushes to main. The fallback uses `origin/main...HEAD` (or `origin/master...HEAD`). On a direct push to main, after the push `origin/main` and `HEAD` are the same commit, so the diff is empty → no changed files → the gate always passes and never checks decisions.

**Summary:** Use trunk-based with decern-gate by having CI set `CI_BASE_SHA` and `CI_HEAD_SHA` (e.g. previous commit vs current commit). Relying on the default fallback is not suitable for direct pushes to main.

## Judge (LLM as a judge)

When validate passes and the judge is **enabled** (`DECERN_GATE_JUDGE_ENABLED=true`), the CLI calls a **judge** endpoint so that the Decern backend (or your service) uses an LLM to check whether the **diff is consistent with** the referenced decision. The judge is **disabled by default**; the judge runs only after validate, and if validate fails, the CI is blocked and the judge is never called.

### Flow

1. **Validate** — High-impact change detected and at least one decision ref present. CLI calls validate; if `valid` is not `true`, gate blocks and **judge is not called**.
2. **Build diff** — CLI builds the full `git diff base...head` with exclusions and cap (see below).
3. **Call judge** — `POST` to `DECERN_JUDGE_PATH` with the payload below. One decision only: if multiple refs were found (e.g. ADR-001 and ADR-002), the **last** one (e.g. ADR-002) is sent.
4. **Result** — Backend returns `allowed: true` or `allowed: false` with optional `reason`. Gate passes only when `allowed === true`.

### Payload sent to the judge API

`POST ${DECERN_BASE_URL}${DECERN_JUDGE_PATH}` with:

- **Headers:** `Content-Type: application/json`, `Authorization: Bearer ${DECERN_CI_TOKEN}`.
- **Body (JSON):**

| Field | Type | Description |
|-------|------|-------------|
| `diff` | string | Full unified diff (`git diff base...head`), with exclusions applied and total size capped at **2 MB**. |
| `truncated` | boolean | `true` if the diff was truncated to 2 MB (backend may treat as partial context). |
| `baseSha` | string | Git base ref used for the diff (e.g. `origin/main` or a commit SHA). |
| `headSha` | string | Git head ref (e.g. `HEAD` or a commit SHA). |
| `adrRef` | string | **Exactly one of** `adrRef` or `decisionId` is present. ADR reference (e.g. `ADR-002`). |
| `decisionId` | string | Decision UUID when the ref is not an ADR. |

**Exclusions applied by the CLI before sending:**

- **Images and heavy assets** — Files with extensions such as `.png`, `.jpg`, `.gif`, `.webp`, `.svg`, `.mp4`, `.pdf`, `.woff2`, etc. are **excluded** from the diff. The CLI logs a warning listing these paths; they are not sent to the backend and are not judged.
- **Per-file size** — If one file’s diff (patch) is larger than **1 MB**, that file’s diff is excluded and a warning is logged.
- **Total size** — The concatenated diff sent in `diff` is at most **2 MB**. If the total would exceed 2 MB, the CLI truncates and sets `truncated: true`.

Example request body:

```json
{
  "diff": "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,3 +1,4 @@\n ...",
  "truncated": false,
  "baseSha": "origin/main",
  "headSha": "HEAD",
  "adrRef": "ADR-002"
}
```

### Response expected from the judge API

- **Status:** `200 OK`.
- **Body (JSON):**

| Field | Type | Description |
|-------|------|-------------|
| `allowed` | boolean | `true` if the change is considered consistent with the decision; `false` to block the gate. |
| `reason` | string (optional) | Short explanation (e.g. for logs or CI output). |

Example success: `{"allowed": true, "reason": "Change aligns with ADR-002."}`  
Example block: `{"allowed": false, "reason": "Diff introduces a new DB column not mentioned in the decision."}`

On non-2xx or network error, the CLI treats the judge as failed and **blocks** the gate (fail-closed).

If the backend returns `allowed: false` with a reason indicating the judge feature is not available for the current plan (e.g. “Judge is available on Team plan and above.”), the CLI **does not block**: it logs the reason as a warning and passes the gate.

### Backend implementation guide (Decern or your service)

The endpoint that receives the judge payload should:

1. **Authenticate** — Verify `Authorization: Bearer <DECERN_CI_TOKEN>`.
2. **Resolve the decision** — Using `adrRef` or `decisionId`, load the decision content (title, body, conclusion) from your store.
3. **Run the LLM judge** — Prompt the model with the decision text and the `diff`. Ask for a structured verdict: e.g. “Is this diff consistent with and justified by this decision? Reply with JSON: `{\"allowed\": true|false, \"reason\": \"...\"}`.”
4. **Handle large diffs** — The payload is already capped at 2 MB and may be marked `truncated: true`. Recommended strategies:
   - **Single-shot with truncation:** If the diff fits your model’s context window, send it as-is. If `truncated` is true, you may add a note in the prompt that the diff was truncated.
   - **Summarize then judge:** If the diff is very long, first call the LLM to produce a short summary (files changed, nature of changes), then a second call to judge “decision + summary” and return `allowed` + `reason`.
   - **Fail-closed** — On LLM timeout, error, or invalid response, return `allowed: false` with a reason (e.g. “Judge unavailable”).
5. **Return** — Respond with `200` and `{ "allowed": true|false, "reason": "..." }`.

The LLM and API key stay on your backend; the CLI never sees them.

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
- `References: found N ref(s) — id1, id2` or `none`
- Per-decision validate result: `Decision <id>: valid.` or `FAIL — <reason>`
- If judge enabled: `Judge: checking diff against decision <ref>...`, optional warnings for excluded/truncated diff, then `Judge: allowed.` or `Gate: blocked — judge: <reason>`
- `Gate: passed.` or `Gate: blocked — ...`

Exit 0 only when: (1) no high-impact patterns matched, or (2) at least one referenced decision is validated as approved **and** (if judge is enabled) the judge returns `allowed: true`.
