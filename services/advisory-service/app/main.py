"""PatchForge Advisory Intelligence Service (Module 1.2).

Resolves pinned dependency manifests against OSV.dev and returns the minimal
upgrade that clears every open advisory, plus the skill that teaches the agent
how to perform that upgrade.
"""
from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .cache import cache
from .models import (
    PackageQuery,
    PackageReport,
    ScanRequest,
    ScanResponse,
    Vulnerability,
)
from .osv_client import OSVUnavailable, osv
from .versions import extract_severity, resolve_safe_version

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("advisory")

# Package -> skill file registered in the TrueForge Skills Registry.
# Mirrors config/skills/registry.yaml `matches.package`.
SKILL_MAP = {
    "pyyaml": "pyyaml",
    "jinja2": "jinja2",
    "llama-index": "llama-index",
    "vllm": "vllm",
    "ragas": "ragas",
    "nemoguardrails": "nemoguardrails",
    "arize-phoenix": "arize-phoenix",
}


def skill_for(package: str) -> str | None:
    return SKILL_MAP.get(package.lower().replace("_", "-"))


@asynccontextmanager
async def lifespan(_: FastAPI):
    await cache.connect()
    await osv.connect()
    yield
    await osv.close()
    await cache.close()


app = FastAPI(
    title="PatchForge Advisory Service",
    version="1.0.0",
    lifespan=lifespan,
)


async def build_report(
    package: str, version: str, vuln_ids: list[str], ecosystem: str
) -> PackageReport:
    vulns = await osv.get_vulns(vuln_ids)

    entries: list[Vulnerability] = []
    for v in vulns:
        sev_type, score = extract_severity(v)
        entries.append(
            Vulnerability(
                id=v.get("id", "UNKNOWN"),
                aliases=v.get("aliases", []) or [],
                summary=v.get("summary")
                or v.get("details", "Security vulnerability detected")[:280],
                severity=sev_type,
                cvss_score=score,
                fixed_versions=sorted(
                    {
                        e["fixed"]
                        for a in v.get("affected", [])
                        for r in a.get("ranges", [])
                        for e in r.get("events", [])
                        if "fixed" in e
                    }
                ),
            )
        )

    recommended, breaking = resolve_safe_version(version, vulns, package, ecosystem)

    return PackageReport(
        package=package,
        ecosystem=ecosystem,
        current_version=version,
        # A package with advisories but no reachable fix is still vulnerable —
        # key off the advisory list, not off `recommended`.
        vulnerable=bool(entries),
        vulnerabilities=entries,
        recommended_version=recommended,
        breaking_upgrade=breaking,
        skill_hint=skill_for(package) if entries else None,
    )


# A scanner that cannot reach its advisory database must say so. Returning 200
# with an empty vulnerability list would read as "everything is clean" to
# pool-monitor, which would then skip patching entirely.
@app.exception_handler(OSVUnavailable)
async def _osv_unavailable(_request, exc: OSVUnavailable):
    log.error("OSV unavailable: %s", exc)
    return JSONResponse(
        status_code=503,
        content={"detail": f"Advisory database unavailable: {exc}"},
    )


@app.post("/api/v1/scan-dependencies", response_model=ScanResponse)
async def scan_dependencies(payload: ScanRequest) -> ScanResponse:
    """Batch entrypoint used by pool-monitor for a whole manifest."""
    before = cache.hits
    id_map = await osv.query_batch(payload.dependencies, payload.ecosystem)

    reports = await asyncio.gather(
        *(
            build_report(name, payload.dependencies[name], ids, payload.ecosystem)
            for name, ids in id_map.items()
        )
    )
    reports = list(reports)

    return ScanResponse(
        ecosystem=payload.ecosystem,
        scanned=len(reports),
        vulnerable_count=sum(1 for r in reports if r.vulnerable),
        reports=reports,
        cache_hits=cache.hits - before,
    )


@app.post("/api/v1/check-vulnerabilities", response_model=PackageReport)
async def check_vulnerabilities(payload: PackageQuery) -> PackageReport:
    """Single-package entrypoint (contract from steps.md Step 2)."""
    id_map = await osv.query_batch(
        {payload.package: payload.version}, payload.ecosystem
    )
    return await build_report(
        payload.package,
        payload.version,
        id_map.get(payload.package, []),
        payload.ecosystem,
    )


# Browsers block cross-origin calls without these headers. Nothing in the UI
# calls this service today, but it is a public API on its own port and the
# failure mode (an opaque CORS error) is expensive to debug.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o for o in os.getenv("CORS_ORIGIN", "*").split(",") if o],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type"],
)


# Opening the service in a browser should say what it is, not 404. An API with
# no root route reads as "not reachable" to anyone who checks it that way.
@app.get("/")
async def index():
    return {
        "service": "advisory-service",
        "role": "Resolves dependency versions against the OSV vulnerability database.",
        "endpoints": {
            "GET  /healthz": "liveness plus Redis cache stats",
            "POST /api/v1/scan-dependencies": "scan a manifest: {dependencies:{name:version}, ecosystem}",
            "POST /api/v1/check-vulnerabilities": "scan one package: {package, version}",
            "GET  /docs": "interactive OpenAPI docs",
        },
    }


@app.get("/healthz")
async def healthz() -> dict:
    return {
        "status": "ok",
        "cache": "connected" if cache.healthy else "degraded",
        "cache_hits": cache.hits,
        "cache_misses": cache.misses,
    }
