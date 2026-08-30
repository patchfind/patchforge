# Plane 1 — TrueForge control plane config

**Setup steps live in [`../intro.md`](../intro.md).** This folder holds the
inputs those steps use.

```
config/
├── plane1/          # request bodies for the TrueForge settings API
│   ├── model-provider.json   → PUT /api/v1/settings/model-providers
│   ├── mcp-server.json       → PUT /api/v1/settings/mcp-servers
│   ├── skills.json           → PUT /api/v1/settings/skills  (one per entry)
│   ├── sandbox-provider.json → PUT /api/v1/settings/sandbox-providers
│   │                           (Daytona Cloud only; skip it on STANDALONE)
│   └── agent.json            → POST /api/v1/agents  (reusable agent;
│                               the harness publishes this at boot)
├── skills-repo/     # push to Git; TrueForge sparse-clones each skill dir
│   └── skills/<name>/SKILL.md
└── harness-bindings.yaml     # the name strings Plane 2 reads back
```

## These files are not read by anything at runtime

TrueForge keeps Plane 1 config in its own database, written through the settings
API. The JSON here is copy-paste ready for those endpoints — mounting this
folder into a container does nothing. A seeder that applies it automatically is
listed as not-yet-built in `intro.md`.

## The four assets

| Asset | Bound by | Where Plane 2 gets it |
|---|---|---|
| Model | FQN `google-gemini/gemini-3-6-flash` | `TRUEFORGE_MODEL` |
| MCP server | name `github` | `TRUEFORGE_MCP_SERVER` |
| Skills | name, per package | `SKILL_MAP` in advisory-service |
| Sandbox | **nothing** — tenant singleton | `config.sandbox.enabled: true` |

The first three are matched by exact string and 422 if missing. `intro.md` §6
has a one-command check that validates all four before you start Plane 2.

## Two corrections to the original plan

- **Skills cannot be uploaded as files.** They are Git-only (`type: 'git'`,
  GitHub/GitLab HTTPS URL + ref). Hence `skills-repo/`.
- **Daytona's endpoint is an environment variable, not a config field.** The
  provider schema carries only an `api_key`. The endpoint comes from
  `DAYTONA_API_URL` in the **TrueForge process's** environment, which the
  Daytona SDK falls back to. Unset it for Daytona Cloud; set it for a
  self-hosted server (see intro.md §9.1 — the caveats are real). Either way the
  key needs **Snapshot** permission, not just Sandboxes.

Secrets never live here: the Gemini key goes into TrueForge, and `GITHUB_TOKEN`
goes to the MCP gateway.
