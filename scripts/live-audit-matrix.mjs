import fs from 'node:fs';
import path from 'node:path';
import { LIVE_AUDIT_SUITES, reportDir, runLiveAuditSuite } from './live-audit-lib.mjs';

function parseArgs(argv) {
  const suiteArg = argv.find((item) => item.startsWith('--suite='));
  return {
    failOnError: argv.includes('--fail-on-error'),
    suiteKey: suiteArg ? suiteArg.slice('--suite='.length).trim() : '',
  };
}

async function main() {
  const { failOnError, suiteKey } = parseArgs(process.argv.slice(2));
  const suiteKeys = suiteKey ? [suiteKey] : LIVE_AUDIT_SUITES.map((suite) => suite.key);
  const reports = [];

  for (const key of suiteKeys) {
    reports.push(await runLiveAuditSuite({ suiteKey: key, failOnError }));
  }

  const aggregate = {
    generated_at: new Date().toISOString(),
    suites: reports.map((report) => ({
      key: report.suite.key,
      title: report.suite.title,
      total_tools: report.total_tools,
      succeeded_tools: report.succeeded_tools,
      failed_tools: report.failed_tools,
      failures_by_type: report.failures_by_type,
    })),
  };

  const reportPath = path.join(reportDir, 'live-audit-matrix.json');
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(aggregate, null, 2)}\n`, 'utf-8');

  console.log('[matrix] Live audit matrix finished.');
  console.log(`[matrix] Report: ${reportPath}`);
}

main().catch((err) => {
  console.error(`Live audit matrix failed: ${err instanceof Error ? err.stack || err.message : String(err)}`);
  process.exit(1);
});
