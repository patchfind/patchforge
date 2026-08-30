# Jinja2 Autoescape Refactoring Guidelines

## Issue
`jinja2.Environment()` and `jinja2.Template()` default to `autoescape=False`.
Rendering user-controlled data through them yields stored/reflected XSS. Older
releases (<3.1.3) additionally carry sandbox-escape advisories.

## Refactoring Rules
1. Every `Environment(...)` construction must pass
   `autoescape=select_autoescape(["html", "xml"])`.
2. Import it explicitly: `from jinja2 import Environment, select_autoescape`.
3. For a bare `Template(source)` used on untrusted data, pass `autoescape=True`.
4. Never call `|safe` or `Markup()` on a value that originates from request
   input; if the diff would require it, stop and flag for human review.
5. If templates are user-authored, render inside `SandboxedEnvironment` from
   `jinja2.sandbox`.

## Before / After
```python
# BEFORE - vulnerable
from jinja2 import Environment, FileSystemLoader
env = Environment(loader=FileSystemLoader("templates"))

# AFTER - safe
from jinja2 import Environment, FileSystemLoader, select_autoescape
env = Environment(
    loader=FileSystemLoader("templates"),
    autoescape=select_autoescape(["html", "xml"]),
)
```

## Manifest Change
`requirements.txt`: `Jinja2==2.11.2` -> `Jinja2==3.1.4`

## Verification
Run `pytest`. Golden-file tests comparing rendered HTML will legitimately fail
after enabling autoescape (`&` -> `&amp;`); update the fixtures rather than
disabling autoescape.
