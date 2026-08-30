# Arize Phoenix Migration Guidelines

## Issue
Older `arize-phoenix` versions ship an unauthenticated web UI bound to all
interfaces and carry path-traversal advisories in the dataset export routes.
Phoenix 4/5 also moved instrumentation into separate OpenInference packages.

## Refactoring Rules
1. `phoenix.trace.<framework>` instrumentors moved out of the main package:
   - `openinference-instrumentation-llama-index`
   - `openinference-instrumentation-openai`
   Add them to the manifest; import as
   `from openinference.instrumentation.llama_index import LlamaIndexInstrumentor`.
2. Replace `px.launch_app()` + manual handler wiring with:
   ```python
   from phoenix.otel import register
   tracer_provider = register(project_name="patchforge")
   LlamaIndexInstrumentor().instrument(tracer_provider=tracer_provider)
   ```
3. `phoenix.active_session()` -> `px.Client()` for programmatic span queries.
4. `px.launch_app(host="0.0.0.0")` in application code must be narrowed to
   `127.0.0.1` unless an explicit deployment config says otherwise.
5. Do not pin `opentelemetry-sdk` below what `phoenix.otel` requires.

## Verification
Run `pytest`. Tracing is side-effecting only; a green suite plus a successful
`from phoenix.otel import register` import is sufficient.
