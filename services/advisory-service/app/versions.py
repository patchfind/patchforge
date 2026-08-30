"""Version arithmetic over OSV `affected` ranges."""
from __future__ import annotations

import logging

from packaging.version import InvalidVersion, Version

log = logging.getLogger(__name__)


def parse(raw: str) -> Version | None:
    try:
        return Version(raw)
    except InvalidVersion:
        return None


def fixed_versions_for(vuln: dict, package: str, ecosystem: str) -> list[str]:
    """Pull every `fixed` event OSV reports for this package out of an advisory."""
    out: list[str] = []
    target = package.lower().replace("_", "-")
    for affected in vuln.get("affected", []):
        pkg = affected.get("package", {})
        name = str(pkg.get("name", "")).lower().replace("_", "-")
        if name != target or pkg.get("ecosystem") != ecosystem:
            continue
        for rng in affected.get("ranges", []):
            # SEMVER and ECOSYSTEM ranges carry comparable versions; GIT ranges
            # carry commit hashes, which are useless as an upgrade target.
            if rng.get("type") == "GIT":
                continue
            for event in rng.get("events", []):
                if "fixed" in event:
                    out.append(event["fixed"])
    return out


def resolve_safe_version(
    current: str,
    vulns: list[dict],
    package: str,
    ecosystem: str,
) -> tuple[str | None, bool]:
    """Lowest version that is >= every advisory's fix.

    Returns (recommended_version, crosses_major). A package with three CVEs
    fixed in 5.4, 6.0 and 6.0.1 resolves to 6.0.1 — the max of the fixes, since
    anything lower still leaves one advisory open.
    """
    candidates: list[Version] = []
    unresolved = False
    current_v = parse(current)

    for vuln in vulns:
        fixes = [parse(f) for f in fixed_versions_for(vuln, package, ecosystem)]
        fixes = sorted(f for f in fixes if f is not None)
        if not fixes:
            # Advisory with no published fix for this package — cannot clear it.
            unresolved = True
            continue
        # An advisory is often fixed on several maintained branches at once
        # (e.g. urllib3 GHSA-34jh lists both 1.26.19 and 2.2.2). Take the
        # cheapest fix that actually lands ABOVE the pinned version — a lower
        # branch's fix does not patch the version we are on.
        if current_v is not None:
            forward = [f for f in fixes if f > current_v]
            candidates.append(forward[0] if forward else fixes[-1])
        else:
            candidates.append(fixes[0])

    if not candidates:
        return None, False

    recommended = max(candidates)

    if current_v is not None and recommended <= current_v:
        # Already patched; the manifest pin is not actually affected.
        return None, False

    crosses_major = bool(
        current_v is not None and recommended.major > current_v.major
    )
    if unresolved:
        log.info(
            "%s: some advisories have no published fix; %s is a partial upgrade",
            package,
            recommended,
        )
    return str(recommended), crosses_major


def extract_severity(vuln: dict) -> tuple[str | None, float | None]:
    """Best-effort CVSS extraction; OSV severity shapes vary by source."""
    for sev in vuln.get("severity", []) or []:
        score = sev.get("score")
        if not score:
            continue
        if isinstance(score, (int, float)):
            return sev.get("type"), float(score)
        # CVSS vector strings are not numeric; hand them back as the label.
        return sev.get("type"), None

    db = vuln.get("database_specific", {}) or {}
    sev = db.get("severity")
    if isinstance(sev, str):
        return sev, None
    return None, None
