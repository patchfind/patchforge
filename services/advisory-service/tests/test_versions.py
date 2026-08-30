"""Unit tests for OSV fix-version resolution."""
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app.versions import resolve_safe_version, fixed_versions_for, extract_severity


def vuln(fixes, package="pyyaml", ecosystem="PyPI", introduced="0"):
    return {
        "id": "TEST-1",
        "affected": [{
            "package": {"name": package, "ecosystem": ecosystem},
            "ranges": [{
                "type": "ECOSYSTEM",
                "events": [{"introduced": introduced}] + [{"fixed": f} for f in fixes],
            }],
        }],
    }


def test_single_advisory_single_fix():
    assert resolve_safe_version("5.3.1", [vuln(["5.4"])], "pyyaml", "PyPI") == ("5.4", False)


def test_multiple_advisories_take_the_highest_fix():
    """Anything below the highest fix still leaves an advisory open."""
    vulns = [vuln(["5.4"]), vuln(["6.0"]), vuln(["6.0.1"])]
    assert resolve_safe_version("5.3.1", vulns, "pyyaml", "PyPI") == ("6.0.1", True)


def test_branch_fixes_pick_the_first_one_above_current():
    """urllib3-style: one advisory fixed on both the 1.26 and 2.x branches.

    A 1.26.5 user upgrades to 1.26.19, not 2.2.2 — and definitely not to a fix
    below where they already are.
    """
    v = vuln(["1.26.19", "2.2.2"], package="urllib3")
    assert resolve_safe_version("1.26.5", [v], "urllib3", "PyPI") == ("1.26.19", False)


def test_fix_below_current_version_is_not_selected():
    """A fix on an older branch does not patch the version we are actually on."""
    v = vuln(["0.3.1", "0.12.41"], package="llama-index")
    assert resolve_safe_version("0.9.48", [v], "llama-index", "PyPI") == ("0.12.41", False)


def test_already_patched_returns_none():
    assert resolve_safe_version("6.0.1", [vuln(["5.4"])], "pyyaml", "PyPI") == (None, False)


def test_advisory_with_no_fix_is_skipped_not_fatal():
    vulns = [vuln([]), vuln(["5.4"])]
    assert resolve_safe_version("5.3.1", vulns, "pyyaml", "PyPI") == ("5.4", False)


def test_no_fixes_anywhere_returns_none():
    assert resolve_safe_version("5.3.1", [vuln([])], "pyyaml", "PyPI") == (None, False)


def test_major_bump_flagged_breaking():
    _, breaking = resolve_safe_version("2.11.2", [vuln(["3.1.6"], package="jinja2")], "jinja2", "PyPI")
    assert breaking is True


def test_other_packages_in_the_advisory_are_ignored():
    v = {
        "id": "TEST-2",
        "affected": [
            {"package": {"name": "other", "ecosystem": "PyPI"},
             "ranges": [{"type": "ECOSYSTEM", "events": [{"fixed": "99.0"}]}]},
            {"package": {"name": "pyyaml", "ecosystem": "PyPI"},
             "ranges": [{"type": "ECOSYSTEM", "events": [{"fixed": "5.4"}]}]},
        ],
    }
    assert fixed_versions_for(v, "pyyaml", "PyPI") == ["5.4"]
    assert resolve_safe_version("5.3.1", [v], "pyyaml", "PyPI") == ("5.4", False)


def test_git_ranges_are_ignored():
    """GIT ranges carry commit hashes, which are not upgrade targets."""
    v = {
        "id": "TEST-3",
        "affected": [{
            "package": {"name": "pyyaml", "ecosystem": "PyPI"},
            "ranges": [
                {"type": "GIT", "events": [{"fixed": "a3f2c9d"}]},
                {"type": "ECOSYSTEM", "events": [{"fixed": "5.4"}]},
            ],
        }],
    }
    assert fixed_versions_for(v, "pyyaml", "PyPI") == ["5.4"]


def test_name_normalisation_matches_underscores_and_case():
    v = vuln(["1.2.3"], package="Llama_Index")
    assert fixed_versions_for(v, "llama-index", "PyPI") == ["1.2.3"]


def test_unparseable_versions_do_not_crash():
    v = vuln(["not-a-version", "5.4"])
    assert resolve_safe_version("5.3.1", [v], "pyyaml", "PyPI") == ("5.4", False)


def test_severity_extraction():
    assert extract_severity({"severity": [{"type": "CVSS_V3", "score": 9.8}]}) == ("CVSS_V3", 9.8)
    assert extract_severity({"severity": [{"type": "CVSS_V3", "score": "CVSS:3.1/AV:N"}]}) == ("CVSS_V3", None)
    assert extract_severity({"database_specific": {"severity": "HIGH"}}) == ("HIGH", None)
    assert extract_severity({}) == (None, None)
