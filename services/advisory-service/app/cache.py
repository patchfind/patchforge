"""Redis caching layer. Degrades to a no-op when Redis is unreachable."""
from __future__ import annotations

import json
import logging
import os
from typing import Any

import redis.asyncio as redis

log = logging.getLogger(__name__)

TTL_SECONDS = int(os.getenv("ADVISORY_CACHE_TTL", "86400"))  # 24h per planv1 DoD


class Cache:
    def __init__(self, url: str | None = None) -> None:
        self._url = url or os.getenv("REDIS_URL", "redis://redis:6379/0")
        self._client: redis.Redis | None = None
        self.hits = 0
        self.misses = 0

    async def connect(self) -> None:
        try:
            self._client = redis.from_url(self._url, decode_responses=True)
            await self._client.ping()
            log.info("advisory cache connected to %s", self._url)
        except Exception as exc:  # noqa: BLE001 - cache is optional, never fatal
            log.warning("advisory cache unavailable (%s); running uncached", exc)
            self._client = None

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()

    @property
    def healthy(self) -> bool:
        return self._client is not None

    async def get(self, key: str) -> Any | None:
        if self._client is None:
            return None
        try:
            raw = await self._client.get(key)
        except Exception as exc:  # noqa: BLE001
            log.warning("cache get failed for %s: %s", key, exc)
            return None
        if raw is None:
            self.misses += 1
            return None
        self.hits += 1
        return json.loads(raw)

    async def set(self, key: str, value: Any, ttl: int = TTL_SECONDS) -> None:
        if self._client is None:
            return
        try:
            await self._client.setex(key, ttl, json.dumps(value))
        except Exception as exc:  # noqa: BLE001
            log.warning("cache set failed for %s: %s", key, exc)


cache = Cache()
