# PyYAML Refactoring Guidelines

## Issue
`yaml.load(input)` without an explicit `Loader` allows arbitrary Python object
construction and therefore arbitrary code execution (CVE-2020-14343,
CVE-2020-1747). In PyYAML 6.0+ the loader-less call signature was removed
outright, so upgrading breaks any code still using it.

## Refactoring Rules
1. Replace `yaml.load(stream)` with `yaml.safe_load(stream)`.
2. Replace `yaml.load(stream, Loader=yaml.Loader)` with `yaml.safe_load(stream)`.
3. Replace `yaml.load(stream, Loader=yaml.FullLoader)` with `yaml.safe_load(stream)`
   unless the code genuinely relies on non-safe tags.
4. If custom tags are required, keep `yaml.load` but pass an explicit safe loader:
   `yaml.load(stream, Loader=yaml.SafeLoader)` with registered constructors.
5. Mirror the same rule for `yaml.load_all` -> `yaml.safe_load_all`.
6. On the dump side, prefer `yaml.safe_dump` over `yaml.dump` for untrusted output.

## Before / After
```python
# BEFORE - vulnerable
import yaml
config = yaml.load(open("config.yml"))

# AFTER - safe
import yaml
with open("config.yml") as fh:
    config = yaml.safe_load(fh)
```

## Manifest Change
`requirements.txt`: `PyYAML==5.3.1` -> `PyYAML==6.0.1`

## Verification
Run `pytest` in the sandbox. Any test asserting on custom-tag deserialization
must be reviewed by hand rather than auto-patched; report it instead of forcing
`safe_load`.
