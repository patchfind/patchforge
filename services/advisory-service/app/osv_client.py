"""OSV.dev API wrapper: batched queries plus per-advisory detail fetches."""
from __future__ import annotations

import asyncio
import logging
import os

import httpx

from .cache import cache

log = logging.getLogger(__name__)


class OSVUnavailable(RuntimeError):
    """OSV could not be reached or returned an error.

    Raised rather than returning empty results: an empty vulnerability list is
    a meaningful answer ("clean"), and a scanner must never confuse the two.
    """

OSV_BASE = os.getenv("OSV_BASE_URL", "https://api.osv.dev/v1")
QUERYBATCH_URL = f"{OSV_BASE}/querybatch"
VULN_URL = f"{OSV_BASE}/vulns"

# OSV rejects oversized batches; chunk defensively.
BATCH_SIZE = int(os.getenv("OSV_BATCH_SIZE", "100"))
DETAIL_CONCURRENCY = int(os.getenv("OSV_DETAIL_CONCURRENCY", "8"))
TIMEOUT = httpx.Timeout(float(os.getenv("OSV_TIMEOUT", "20")))
# Advisory-id lists expire faster than the advisories themselves.
QUERY_TTL = int(os.getenv("OSV_QUERY_TTL", "3600"))


def _query_key(name: str, version: str, ecosystem: str) -> str:
    return f"osv:q:{ecosystem}:{name.lower()}:{version}"


def _verify() -> str | bool:
    """TLS trust store.

    Enterprises that terminate TLS at an inspecting proxy sign api.osv.dev with
    an internal root that is in the OS trust store but not in certifi's bundle,
    which is what httpx uses by default. Honour the conventional override
    variables, then fall back to the system bundle when one is present.
    """
    for var in ("OSV_CA_BUNDLE", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE"):
        path = os.getenv(var)
        if path and os.path.exists(path):
            log.info("using CA bundle from %s: %s", var, path)
            return path

    system_bundle = "/etc/ssl/certs/ca-certificates.crt"
    if os.path.exists(system_bundle):
        return system_bundle
    return True


class OSVClient:
    def __init__(self) -> None:
        self._client: httpx.AsyncClient | None = None
        self._detail_sem = asyncio.Semaphore(DETAIL_CONCURRENCY)

    async def connect(self) -> None:
        self._client = httpx.AsyncClient(timeout=TIMEOUT, verify=_verify())

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()

    @property
    def client(self) -> httpx.AsyncClient:
        if self._client is None:
            raise RuntimeError("OSVClient used before connect()")
        return self._client

    async def query_batch(
        self, deps: dict[str, str], ecosystem: str
    ) -> dict[str, list[str]]:
        """Map package name -> list of advisory ids. Order-preserving per OSV spec."""
        names = list(deps.keys())
        result: dict[str, list[str]] = {name: [] for name in names}

        # Resolve from cache first; only unknown pins go over the wire. Without
        # this the batch call dominates a warm request, since advisory detail
        # caching alone still pays one OSV round-trip per scan.
        uncached: list[str] = []
        for name in names:
            hit = await cache.get(_query_key(name, deps[name], ecosystem))
            if hit is None:
                uncached.append(name)
            else:
                result[name] = hit

        for start in range(0, len(uncached), BATCH_SIZE):
            chunk = uncached[start : start + BATCH_SIZE]
            queries = [
                {
                    "package": {"name": name, "ecosystem": ecosystem},
                    "version": deps[name],
                }
                for name in chunk
            ]
            try:
                resp = await self.client.post(
                    QUERYBATCH_URL, json={"queries": queries}
                )
                resp.raise_for_status()
            except httpx.HTTPError as exc:
                # Do NOT swallow this. Returning an empty id list here is
                # indistinguishable from "this package is clean", so a network
                # or TLS failure would silently report every dependency as
                # SECURE — a vulnerability scanner that fails open is worse
                # than one that is down. Propagate and let the caller 503.
                log.error("OSV querybatch failed for chunk %s: %s", start, exc)
                raise OSVUnavailable(
                    f"OSV query failed for {len(chunk)} package(s): {exc}"
                ) from exc

            # OSV returns `results` positionally aligned with `queries`.
            for name, entry in zip(chunk, resp.json().get("results", [])):
                ids = [v["id"] for v in (entry.get("vulns") or [])]
                result[name] = ids
                # Shorter TTL than advisory details: the id list for a pinned
                # version changes whenever a NEW advisory is published against
                # it, which is exactly what a monitoring service must notice.
                await cache.set(
                    _query_key(name, deps[name], ecosystem), ids, ttl=QUERY_TTL
                )

        return result

    async def get_vuln(self, vuln_id: str) -> dict | None:
        """Fetch one advisory. Cached indefinitely-ish — advisories are immutable
        in practice, and the 24h TTL bounds any correction lag."""
        key = f"osv:vuln:{vuln_id}"
        cached = await cache.get(key)
        if cached is not None:
            return cached

        async with self._detail_sem:
            try:
                resp = await self.client.get(f"{VULN_URL}/{vuln_id}")
                resp.raise_for_status()
            except httpx.HTTPError as exc:
                log.error("OSV detail fetch failed for %s: %s", vuln_id, exc)
                return None

        data = resp.json()
        await cache.set(key, data)
        return data

    async def get_vulns(self, ids: list[str]) -> list[dict]:
        if not ids:
            return []
        fetched = await asyncio.gather(*(self.get_vuln(i) for i in ids))
        return [v for v in fetched if v is not None]


osv = OSVClient()
