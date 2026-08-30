import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRequirementsTxt, parsePackageJson, parseRepoUrl } from './manifest.js';

test('parses exact pins and ignores directives/comments', () => {
  const { deps, skipped } = parseRequirementsTxt(`
# security-critical
PyYAML==5.3.1
Jinja2==2.11.2  # templating
requests>=2.25.1
-r base.txt
--index-url https://example.invalid/simple
uvicorn[standard]==0.34.0

`);
  assert.deepEqual(deps, {
    PyYAML: '5.3.1',
    Jinja2: '2.11.2',
    uvicorn: '0.34.0',
  });
  assert.deepEqual(skipped, ['requests>=2.25.1']);
});

test('package.json pins strip caret/tilde but reject ranges', () => {
  const { deps, skipped } = parsePackageJson(JSON.stringify({
    dependencies: { express: '^4.21.2', ws: '8.18.0', a: '>=1.0.0', b: 'workspace:*' },
    devDependencies: { typescript: '~5.7.2' },
  }));
  assert.deepEqual(deps, { express: '4.21.2', ws: '8.18.0', typescript: '5.7.2' });
  assert.deepEqual(skipped.sort(), ['a@>=1.0.0', 'b@workspace:*']);
});

test('repo url parsing accepts https, ssh, .git and short form', () => {
  for (const input of [
    'https://github.com/patchforge/demo',
    'https://github.com/patchforge/demo.git',
    'git@github.com:patchforge/demo.git',
    'patchforge/demo',
  ]) {
    assert.deepEqual(parseRepoUrl(input), { owner: 'patchforge', name: 'demo' }, input);
  }
  assert.throws(() => parseRepoUrl('not a repo'));
});
