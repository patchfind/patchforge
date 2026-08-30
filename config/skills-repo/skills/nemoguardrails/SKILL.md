# NeMo Guardrails Migration Guidelines

## Issue
Advisories in older `nemoguardrails` covering sandbox escape in Colang action
execution and incomplete jailbreak detection. Upgrading also introduces
Colang 2.0 syntax alongside the 1.0 parser.

## Refactoring Rules
1. `RailsConfig.from_path("./config")` is unchanged — keep it. Do not inline
   rails into Python strings during the patch.
2. `LLMRails(config).generate(messages=[...])` is the supported entrypoint;
   the legacy `generate(prompt=...)` positional form is deprecated.
3. If `config.yml` sets `colang_version: "2.x"`, flow definitions must use
   `flow` (not `define flow`) and `user said` / `bot say`. Do not mix versions
   in one config directory.
4. Enable the input rail `self check input` and output rail `self check output`
   with prompts defined in `prompts.yml` — these are the prompt-injection
   defenses the CVEs concern.
5. Custom actions registered with `@action()` must not shell out; if an existing
   action calls `os.system`/`subprocess`, flag for human review.

## Verification
Run `pytest`. Guardrails tests hitting a live LLM must be marked and skipped in
the sandbox — report skipped counts explicitly.
