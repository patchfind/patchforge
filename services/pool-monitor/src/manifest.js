/**
 * Dependency manifest parsing.
 *
 * Only exact pins (`==`, or npm's bare `x.y.z`) are actionable: a range like
 * `>=1.0` has no single current version to report to OSV, so it is skipped
 * rather than guessed at.
 */

const PY_LINE = /^\s*([A-Za-z0-9._-]+)\s*(\[[^\]]*\])?\s*==\s*([A-Za-z0-9._+!-]+)/;

export function parseRequirementsTxt(text) {
  const deps = {};
  const skipped = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;
    // -r nested.txt, -e ./pkg, --index-url ... are all directives, not pins.
    if (line.startsWith('-')) continue;

    const m = line.match(PY_LINE);
    if (m) {
      deps[m[1]] = m[3];
    } else {
      skipped.push(line);
    }
  }
  return { deps, skipped };
}

export function parsePackageJson(text) {
  const pkg = JSON.parse(text);
  const deps = {};
  const skipped = [];

  for (const block of [pkg.dependencies, pkg.devDependencies]) {
    for (const [name, spec] of Object.entries(block || {})) {
      // Strip a leading ^ or ~ only when the remainder is a bare version;
      // anything else (ranges, git urls, `workspace:*`) is not a pin.
      const exact = /^[\^~]?(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.]+)?)$/.exec(spec);
      if (exact) deps[name] = exact[1];
      else skipped.push(`${name}@${spec}`);
    }
  }
  return { deps, skipped };
}

export function parseManifest(path, text) {
  if (path.endsWith('package.json')) return parsePackageJson(text);
  return parseRequirementsTxt(text);
}

export function ecosystemFor(path) {
  return path.endsWith('package.json') ? 'npm' : 'PyPI';
}

/** `https://github.com/owner/repo(.git)` -> `{owner, name}` */
export function parseRepoUrl(repoUrl) {
  const m = repoUrl
    .trim()
    .replace(/\.git$/, '')
    .match(/(?:github\.com[/:])([^/]+)\/([^/]+)\/?$/);
  if (!m) {
    // Bare `owner/repo` form is accepted too.
    const short = repoUrl.trim().match(/^([\w.-]+)\/([\w.-]+)$/);
    if (short) return { owner: short[1], name: short[2] };
    throw new Error(`Cannot parse repository URL: ${repoUrl}`);
  }
  return { owner: m[1], name: m[2] };
}
