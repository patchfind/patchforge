# vLLM Migration Guidelines

## Issue
Advisories against older `vllm` (unsafe pickle deserialization in the
distributed/ZeroMQ path, DoS in the OpenAI-compatible server). Upgrading moves
several engine and sampling arguments.

## Refactoring Rules
1. `SamplingParams(max_tokens=..., best_of=...)`: `best_of` is deprecated —
   drop it or migrate to `n` with `use_beam_search` removed from
   `SamplingParams` and passed via `BeamSearchParams`.
2. `LLM(model=..., tokenizer_mode=..., trust_remote_code=True)`: leave
   `trust_remote_code` only where the model repo is first-party; otherwise
   remove it and flag for review — it is remote code execution by design.
3. `llm.generate(prompts, sampling_params)` still returns `RequestOutput`;
   `output.outputs[0].text` is unchanged. Do not rewrite result plumbing.
4. `AsyncLLMEngine.from_engine_args` — `EngineArgs` fields `max_num_batched_tokens`
   and `gpu_memory_utilization` keep their names; `max_context_len_to_capture`
   is renamed to `max_seq_len_to_capture`.
5. Never enable the `--api-key`-less OpenAI server on `0.0.0.0` in test fixtures.

## Verification
`pytest -k "not gpu"` in the sandbox; vLLM import requires CUDA in many builds,
so if collection fails on hardware grounds report it as INFRA_BLOCKED rather
than as a failed patch.
