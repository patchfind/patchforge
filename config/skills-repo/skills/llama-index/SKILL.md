# LlamaIndex Migration Guidelines

## Issue
Advisories against `llama-index` <0.10.20 (unsafe path handling / prompt-
injection in reader utilities). The upgrade to 0.10+ is a hard breaking change:
the monolithic package was split into `llama-index-core` plus integration
packages.

## Refactoring Rules
1. `from llama_index import X` -> `from llama_index.core import X`
   (`VectorStoreIndex`, `Settings`, `Document`, `StorageContext`, `ServiceContext`).
2. `ServiceContext` is removed. Replace with the global `Settings` object:
   `Settings.llm = ...`, `Settings.embed_model = ...`, `Settings.chunk_size = ...`.
3. Integrations move to their own namespaces and must be added to the manifest:
   - `llama_index.llms.openai` -> package `llama-index-llms-openai`
   - `llama_index.embeddings.huggingface` -> `llama-index-embeddings-huggingface`
   - `llama_index.vector_stores.faiss` -> `llama-index-vector-stores-faiss`
   - `llama_index.readers.file` -> `llama-index-readers-file`
4. `SimpleDirectoryReader` now lives in `llama_index.core.readers`.
5. `index.as_query_engine(service_context=ctx)` -> drop the kwarg; configure via
   `Settings` or pass `llm=` directly.

## Before / After
```python
# BEFORE
from llama_index import VectorStoreIndex, ServiceContext, SimpleDirectoryReader
ctx = ServiceContext.from_defaults(llm=llm, chunk_size=512)
index = VectorStoreIndex.from_documents(docs, service_context=ctx)

# AFTER
from llama_index.core import VectorStoreIndex, Settings, SimpleDirectoryReader
Settings.llm = llm
Settings.chunk_size = 512
index = VectorStoreIndex.from_documents(docs)
```

## Verification
Run `pytest`. Expect `ModuleNotFoundError` for any integration package missing
from `requirements.txt` — add the specific `llama-index-*` package rather than
reverting the import.
