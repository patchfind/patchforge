"""Request/response contracts for the advisory service."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

Ecosystem = Literal["PyPI", "npm", "Go", "Maven", "crates.io"]


class ScanRequest(BaseModel):
    """A manifest's worth of pinned dependencies."""

    dependencies: dict[str, str] = Field(
        ...,
        description="Package name -> pinned version, e.g. {'PyYAML': '5.3.1'}",
        examples=[{"PyYAML": "5.3.1", "Jinja2": "2.11.2"}],
    )
    ecosystem: Ecosystem = "PyPI"


class PackageQuery(BaseModel):
    """Single-package lookup (compatibility endpoint)."""

    package: str
    version: str
    ecosystem: Ecosystem = "PyPI"


class Vulnerability(BaseModel):
    id: str
    aliases: list[str] = []
    summary: str = "Security vulnerability detected"
    severity: str | None = None
    cvss_score: float | None = None
    fixed_versions: list[str] = []


class PackageReport(BaseModel):
    package: str
    ecosystem: Ecosystem
    current_version: str
    vulnerable: bool
    vulnerabilities: list[Vulnerability] = []
    # Lowest version that clears every advisory below -> the upgrade we recommend.
    recommended_version: str | None = None
    # Set when the recommended upgrade crosses a major boundary.
    breaking_upgrade: bool = False
    skill_hint: str | None = None


class ScanResponse(BaseModel):
    ecosystem: Ecosystem
    scanned: int
    vulnerable_count: int
    reports: list[PackageReport]
    cache_hits: int = 0
