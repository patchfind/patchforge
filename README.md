# PatchForge

An agent that fixes vulnerable dependencies. Give it a repository; it finds
known CVEs, upgrades the pinned versions, refactors the code the upgrade breaks,
proves the fix with the repo's own tests, and stops for a human before it opens
a pull request.

Built on [TrueForge](https://github.com/truefoundry/trueforge), TrueFoundry's
open-source agent harness.

---

## The problem

An LLM will happily tell you `yaml.load` is unsafe. That is not the hard part.

The hard part is the work either side of that sentence: knowing *which* of your
pinned dependencies have advisories, knowing what the safe version is, making the
change, discovering that the upgrade broke three call sites, fixing those,
running the tests, and stopping before anything touches your repository.

PatchForge does that work. The model is one component; most of the system is the
infrastructure that lets it act safely.

---

## Architecture

```
┌───────────────────────────────────────────────────────────────────────────┐
│  PLANE 1 — TrueForge control plane          http://localhost:8790         │
│  Configured once in the UI. Holds every credential.                       │
│                                                                           │
│   Models            Connectors         Skills            Sandbox          │
│   Gemini            GitHub MCP         7 git-backed      local, or        │
│   (your API key)    (your PAT)         SKILL.md packs    Daytona          │
└───────────────┬───────────────────────────────────────────────────────────┘
                │  referenced BY NAME only — no secrets cross this line
                ▼
┌───────────────────────────────────────────────────────────────────────────┐
│  PLANE 2 — PatchForge                                                     │
│                                                                           │
│   ┌──────────────┐   repo URL    ┌──────────────────┐                     │
│   │ checkpoint-  │──────────────>│  pool-monitor    │                     │
│   │ gateway :3002│               │      :8080       │                     │
│   │              │               └────────┬─────────┘                     │
│   │ • repos      │                        │ manifest via GitHub REST      │
│   │ • live trace │                        ▼                               │
│   │ • diff +     │               ┌──────────────────┐      ┌───────────┐  │
│   │   approve    │               │ advisory-service │─────>│  OSV.dev  │  │
│   └──────▲───────┘               │      :8081       │<─────│           │  │
│          │                       └────────┬─────────┘      └───────────┘  │
│          │ WebSocket                      │ Redis cache, 24h              │
│          │ trace                          │                               │
│          │                    RabbitMQ ── tasks.patching                  │
│          │                                │  (one task per CVE package)   │
│          │                                ▼                               │
│   ┌──────┴────────────────────────────────────────────────┐               │
│   │            trueforge-harness  :3000 / :3001           │               │
│   │                                                       │               │
│   │   consumes task ─> opens a TrueForge session          │               │
│   │     QA subagent      : pytest in sandbox (fails)      │               │
│   │     Migration subagent: apply skill, edit code        │               │
│   │     QA subagent      : pytest again (passes)          │               │
│   │     ★ PAUSE at create_pull_request ──> Redis          │               │
│   └───────────────────────────────────────────────────────┘               │
└───────────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼  only after you click Approve
                       GitHub MCP ──> branch, commit, pull request
```

Seven containers: four services plus Postgres, Redis and RabbitMQ. TrueForge
runs alongside as the control plane.

---

## How it works

### 1. Detection

`pool-monitor` reads the dependency manifest through GitHub's REST API and hands
the pinned versions to `advisory-service`, which batches them against
[OSV.dev](https://osv.dev) and caches results in Redis for 24 hours.

Version resolution is the interesting part. A package with three advisories
fixed in `5.4`, `6.0` and `6.0.1` resolves to `6.0.1` — the **maximum** of the
minimum fixes, because anything lower still leaves one advisory open. Upgrades
crossing a major boundary are flagged `breaking_upgrade`.

**It fails closed.** If OSV is unreachable the service returns `503`, never an
empty result. An empty vulnerability list is a meaningful answer — "this package
is clean" — so a scanner must never let a network failure imitate one.

### 2. Skill routing

Each vulnerable package is matched to a migration guide. These are git-backed
`SKILL.md` packs that TrueForge clones into the sandbox:

| Skill | Fixes |
|---|---|
| `pyyaml` | `yaml.load` → `yaml.safe_load` (CVE-2020-14343) |
| `jinja2` | missing `autoescape` → XSS |
| `llama-index` | the 0.9 → 0.10 namespace split |
| `vllm` | sampling and engine argument renames |
| `ragas` | 0.1 → 0.2 metric classes |
| `nemoguardrails` | Colang 2.0 and the self-check rails |
| `arize-phoenix` | tracing moved to `phoenix.otel` |

A package with no matching skill still gets a task, but the agent works without
a guide — so the trace records `skill: none` rather than pretending otherwise.

### 3. Patching

The harness opens a TrueForge session per task and runs two subagents:

- **QA** runs `pytest` in the sandbox *first*, to capture how it fails before
  anything changes. That failure is the evidence the problem is real.
- **Migration** reads the trace and the skill, then applies the minimal change.
- **QA** runs the tests again.

Context is compacted at 50k tokens so long fix/test loops do not lose the
thread.

### 4. The human gate

The pause is not polling. The harness declares:

```ts
requireApprovalForTools: ['create_pull_request']
```

TrueForge suspends the turn mid-flight and the state goes to Redis under
`patchforge:interceptor:<taskId>`, so a pause survives a harness restart. The UI
renders a Monaco side-by-side diff with the passing test log; the PR only opens
after you click Approve.

Deliberately narrowed from TrueForge's `["@write","@destructive"]` default: the
agent commits freely to its own throwaway branch and stops only where the change
becomes a proposal against your repository.

---

## Quick start

```bash
cp .env.example .env      # set GITHUB_TOKEN; leave TRUEFOUNDRY_API_KEY empty
./scripts/start.sh        # TrueForge + PatchForge, in dependency order
```

It waits on every health check, then reports what is still unconfigured:

```
+ TrueForge on :8790          (sandbox: enabled)
+ advisory-service on :8081
+ pool-monitor on :8080
+ checkpoint-gateway on :3002

==> Plane 1 (configure at http://localhost:8790)
  ! model:  none — Settings > Models
  ! mcp:    none — Settings > Connectors
  ! skills: none — Settings > Skills
  + sandbox: built-in local sandbox
```

Every `!` is a step below.

---

## Setup

### Model — Settings → Models

Add a **Google Gemini** provider with your key. Two fields matter and they are
different things:

| Field | Meaning |
|---|---|
| `model_id` | sent to Google **verbatim** — must be a real id |
| `name` | local label; forms the FQN |

Confirm the FQN, then put it in `.env` as `TRUEFORGE_MODEL`:

```bash
curl -s localhost:8790/api/v1/models
# "name":"google-gemini/gemini-3.6-flash"
```

For well-known providers the provider name **is** its type, so the FQN starts
`google-gemini/`, not `truefoundry/`.

### GitHub — Settings → Connectors

GitHub's official remote MCP server ships in TrueForge's catalog. Nothing to
host. Paste a PAT with `contents:write`, `pull_requests:write`, `metadata:read`.

The stored header must be exactly `Bearer ghp_...` — two parts, non-empty
second. Anything else gives `Authorization header is badly formatted`, which
is a *formatting* error: a wrong token returns `unauthorized` instead.

Put the same PAT in `.env` as `GITHUB_TOKEN`. Services use it read-only for
manifests and diffs; the agent's writes go through the connector, behind the
approval gate.

### Skills — push, then register

Skills are **git-backed**; there is no file upload. `config/skills-repo/` is
already laid out correctly.

```bash
cd config/skills-repo
git init -b main && git add . && git commit -m "PatchForge skills"
git remote add origin https://github.com/<you>/patchforge-skills.git
git push -u origin main
```

Then register all seven — names must match `SKILL_MAP` in
`services/advisory-service/app/main.py`, which is what routes a CVE to a guide:

```bash
export TF=http://localhost:8790
export SKILLS_REPO_URL=https://github.com/<you>/patchforge-skills
for s in pyyaml jinja2 llama-index vllm ragas nemoguardrails arize-phoenix; do
  curl -s -X PUT $TF/api/v1/settings/skills -H 'Content-Type: application/json' \
    -d "{\"manifest\":{\"type\":\"git\",\"name\":\"$s\",\"url\":\"$SKILLS_REPO_URL\",
    \"path\":\"skills/$s\",\"ref\":\"main\",\"description\":\"Migration guide for $s.\"}}"
done
```

### Sandbox

Skills mount into a sandbox, so without one they cannot be used at all.

| Option | Setup | Visible in the UI |
|---|---|---|
| Built-in | nothing on `STANDALONE=true` | no — implicit |
| Local Daytona | `./scripts/start.sh --with-daytona` | yes, as a provider |

Check it is live before going further:

```bash
curl -s localhost:8790/api/v1/capabilities
# {"sandbox":{"enabled":true},"skill":{"enabled":true}}
```

If `false`, the sandbox needs `bwrap`, `socat` and `rg`. In Docker it also needs
`--security-opt seccomp=unconfined`, because bubblewrap requires unprivileged
user namespaces. `./scripts/trueforge-local.sh` prints the exact cause and fix.

### Verify everything

```bash
./scripts/doctor.sh                    # header format + model id
GEMINI_API_KEY=... ./scripts/doctor.sh # also checks the id against Google
```

Then create a session with the spec the harness actually sends:

```bash
curl -s -X POST $TF/api/v1/sessions -H 'Content-Type: application/json' -d '{
  "agent":{"spec":{
    "model":{"name":"google-gemini/gemini-3.6-flash"},
    "instructions":"preflight",
    "skills":[{"name":"pyyaml"}],
    "mcp_servers":[{"name":"github",
                    "require_approval_for_tools":["create_pull_request"]}],
    "config":{"sandbox":{"enabled":true}}}}}'
```

| Response | Meaning |
|---|---|
| `200` + session id | Plane 1 is correct |
| `422 provider not configured` | model FQN wrong |
| `422 Unknown MCP server` | connector name mismatch |
| `422 Unknown skill` | not registered, or name ≠ `SKILL_MAP` |
| `422 skills require a sandbox` | sandbox down |

---

## Run a patch

Open <http://localhost:3002> and add a repository.

A repo needs three things, and most public ones miss at least one:

1. **Exact `==` pins.** `PyYAML>=5.0` cannot resolve to one version, so OSV is
   never queried and the scan reports `NO_PINS`.
2. **A package with a matching skill.**
3. **A test that proves the fix.**

`tests/mock_repos/vulnerable-demo/` satisfies all three. Push it and add it:

```
advisory-service (live OSV):
  PyYAML  5.3.1  -> 5.4      skill=pyyaml    2 CVEs
  Jinja2  2.11.2 -> 3.1.6    skill=jinja2   10 CVEs

pytest before the fix:  1 failed, 3 passed
pytest after the fix:   4 passed
```

Expect **`QUEUED_FOR_PATCHING`**. `NO_PINS` means nothing was checked — it does
not mean the repo is clean.

---

## Layout

```
sm/
├── README.md                    this file
├── RUNBOOK.md                   command-by-command operations
├── intro.md                     why each piece is shaped the way it is
├── docker-compose.yml
├── config/
│   ├── plane1/*.json            settings-API payloads
│   └── skills-repo/             push to git; TrueForge clones from here
├── services/
│   ├── pool-monitor/            Node — registry, scheduler, dispatch
│   ├── advisory-service/        Python — OSV, caching, version resolution
│   ├── trueforge-harness/       TypeScript — agent runtime, approval gate
│   └── checkpoint-gateway/      Next.js — repos, trace, diff, approve
├── scripts/
│   ├── start.sh                 bring everything up
│   ├── doctor.sh                diagnose Plane 1
│   ├── trueforge-local.sh       control plane
│   ├── daytona-local.sh         optional sandbox provider
│   ├── setup.sh / cleanup.sh    dependencies
└── tests/mock_repos/            the vulnerable fixture
```

---

## Commands

```bash
./scripts/start.sh [--with-daytona] [--no-trueforge]
./scripts/start.sh status | stop
./scripts/doctor.sh
./scripts/setup.sh [--build]
./scripts/cleanup.sh [--dry-run] [--docker]
```

---

## Design notes

**Secrets live in Plane 1.** Services reference model, connector and skills by
name; TrueForge holds the credentials and redacts them on read. The one
exception is `GITHUB_TOKEN`, used read-only for manifests and diffs.

**Reads are not agent actions.** Fetching a manifest is a plain HTTP GET, so it
goes straight to GitHub's REST API. An earlier version ran a `github-mcp-gateway`
container for this; it was deleted, because routing a file read through a tool
server bought nothing but another service to operate.

**The scanner fails closed.** Covered above, and worth restating: it is the one
place where a silent failure would be indistinguishable from good news.

**The UI is same-origin.** The browser talks only to `:3002`; Next proxies to the
backends server-side. Cross-origin calls made the UI depend on CORS headers,
published backend ports, and build-time URLs matching how the page was opened —
and a browser reports all three failures identically as a CORS error.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `:8080` / `:8081` "unreachable" | APIs; `/` returns a JSON index | that JSON *is* it working |
| CORS / `NetworkError` in the UI | stale bundle | `docker compose up -d --build checkpoint-gateway`, hard refresh |
| `Authorization header is badly formatted` | empty token, doubled `Bearer`, or a `${...}` placeholder | re-enter the PAT; `./scripts/doctor.sh` |
| `unauthorized` from GitHub | genuinely wrong or expired PAT | new token |
| `sandbox.enabled: false` | bubblewrap blocked or missing | `seccomp=unconfined`, or install `bwrap socat rg` |
| `422 provider not configured` | FQN mismatch | `./scripts/doctor.sh` |
| `NO_PINS` | no exact `==` pins found | nothing was checked; use a pinned repo |
| `fetch failed` on every task | harness cannot reach TrueForge | `extra_hosts` mapping; check `TRUEFOUNDRY_BASE_URL` |
| `503 Advisory database unavailable` | OSV unreachable | correct by design — it refuses to report "clean" |

---

## Status

**Verified** against a live TrueForge: control plane UI and API; all four
settings endpoints; sandbox live; harness preflight; reusable agent publish;
session creation both by spec and by name; MCP connect inside a turn; live OSV
scanning with correct skill routing; local Daytona reachable.

**Not verified:** a complete agent run end to end, which needs a working Gemini
key and GitHub connector. Every stage either side of the model call is
exercised; the model call itself has only been observed failing correctly on a
placeholder key.
