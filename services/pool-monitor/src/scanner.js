import { randomUUID } from 'node:crypto';
import { pool, alreadyDispatched } from './db.js';
import { parseManifest, ecosystemFor } from './manifest.js';
import { fetchManifest, scanDependencies } from './sources.js';
import { publishTask } from './queue.js';

/**
 * Full scan of one repository: fetch manifest -> resolve advisories ->
 * dispatch one patching task per vulnerable package.
 *
 * One task per package (not per repo) keeps each agent session focused on a
 * single skill and produces one reviewable pull request per upgrade.
 */
export async function scanRepository(repo) {
  const scan = await pool.query(
    `INSERT INTO scans (repository_id, status) VALUES ($1, 'RUNNING') RETURNING id`,
    [repo.id],
  );
  const scanId = scan.rows[0].id;

  try {
    const text = await fetchManifest({
      owner: repo.owner,
      name: repo.name,
      branch: repo.branch,
      manifestPath: repo.manifest_path,
    });

    const { deps, skipped } = parseManifest(repo.manifest_path, text);
    const ecosystem = repo.ecosystem || ecosystemFor(repo.manifest_path);

    if (Object.keys(deps).length === 0) {
      await finishScan(scanId, 'NO_PINS', 0, 0, { skipped });
      return { repository: repo.repo_url, status: 'NO_PINS', skipped, dispatched: [] };
    }

    const report = await scanDependencies(deps, ecosystem);
    const dispatched = [];

    for (const pkgReport of report.reports) {
      if (!pkgReport.vulnerable || !pkgReport.recommended_version) continue;

      if (await alreadyDispatched(repo.id, pkgReport.package, pkgReport.recommended_version)) {
        continue;
      }

      const taskId = randomUUID();
      const payload = {
        task_id: taskId,
        repository_id: repo.id,
        repo_url: repo.repo_url,
        owner: repo.owner,
        name: repo.name,
        branch: repo.branch,
        manifest_path: repo.manifest_path,
        ecosystem,
        target_package: pkgReport.package,
        current_version: pkgReport.current_version,
        recommended_version: pkgReport.recommended_version,
        breaking_upgrade: pkgReport.breaking_upgrade,
        vulnerabilities: pkgReport.vulnerabilities,
        // Resolved by advisory-service from the skills registry; null means no
        // migration guide exists and the harness must reason unaided.
        skill_name: pkgReport.skill_hint,
        dispatched_at: new Date().toISOString(),
      };

      publishTask(payload);
      await pool.query(
        `INSERT INTO dispatched_tasks
           (repository_id, task_id, package, from_version, to_version)
         VALUES ($1, $2, $3, $4, $5)`,
        [repo.id, taskId, pkgReport.package, pkgReport.current_version, pkgReport.recommended_version],
      );
      dispatched.push(payload);
    }

    await finishScan(scanId, 'COMPLETE', report.scanned, report.vulnerable_count, {
      skipped,
      dispatched: dispatched.map((d) => d.task_id),
    });
    await pool.query(`UPDATE repositories SET last_scanned_at = NOW() WHERE id = $1`, [repo.id]);

    return {
      repository: repo.repo_url,
      status: dispatched.length ? 'QUEUED_FOR_PATCHING' : 'SECURE',
      scanned: report.scanned,
      vulnerable_count: report.vulnerable_count,
      skipped,
      dispatched,
    };
  } catch (err) {
    await pool.query(
      `UPDATE scans SET status = 'ERROR', error = $2 WHERE id = $1`,
      [scanId, String(err.message || err)],
    );
    throw err;
  }
}

async function finishScan(scanId, status, scanned, vulnerable, detail) {
  await pool.query(
    `UPDATE scans SET status = $2, packages_scanned = $3, vulnerable_count = $4, detail = $5
      WHERE id = $1`,
    [scanId, status, scanned, vulnerable, JSON.stringify(detail)],
  );
}

export async function scanAllEnabled() {
  const { rows } = await pool.query(`SELECT * FROM repositories WHERE enabled = TRUE`);
  const results = [];
  for (const repo of rows) {
    try {
      results.push(await scanRepository(repo));
    } catch (err) {
      console.error(`[scanner] ${repo.repo_url} failed:`, err.message);
      results.push({ repository: repo.repo_url, status: 'ERROR', error: err.message });
    }
  }
  return results;
}
