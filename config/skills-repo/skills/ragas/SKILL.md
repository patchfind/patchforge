# Ragas Migration Guidelines

## Issue
Ragas 0.2 renamed the core metrics and replaced the HuggingFace `Dataset`
input contract with `EvaluationDataset`.

## Refactoring Rules
1. Metric renames:
   - `answer_relevancy` -> `ResponseRelevancy`
   - `context_precision` -> `LLMContextPrecisionWithReference`
   - `context_recall` -> `LLMContextRecall`
   - `faithfulness` -> `Faithfulness` (class, not module-level instance)
2. Import site: `from ragas.metrics import Faithfulness, ResponseRelevancy`.
   Metrics are now classes — instantiate them: `Faithfulness()`.
3. Column renames in the dataset: `question` -> `user_input`,
   `answer` -> `response`, `contexts` -> `retrieved_contexts`,
   `ground_truth` -> `reference`.
4. `evaluate(dataset, metrics=[...])` now accepts `EvaluationDataset`:
   `EvaluationDataset.from_list(rows)`.
5. LLM/embedding wrappers: pass `llm=LangchainLLMWrapper(chat_model)` explicitly;
   the implicit OpenAI default is gone.

## Before / After
```python
# BEFORE
from ragas import evaluate
from ragas.metrics import faithfulness, answer_relevancy
result = evaluate(hf_dataset, metrics=[faithfulness, answer_relevancy])

# AFTER
from ragas import evaluate, EvaluationDataset
from ragas.metrics import Faithfulness, ResponseRelevancy
ds = EvaluationDataset.from_list(rows)   # keys: user_input, response, retrieved_contexts, reference
result = evaluate(ds, metrics=[Faithfulness(), ResponseRelevancy()])
```

## Verification
Run `pytest`. Score assertions may shift slightly between versions — widen
tolerances rather than pinning the old release.
