import path from 'node:path';
import { reportDir, runLiveAuditSuite } from './live-audit-lib.mjs';

async function main() {
  const failOnError = process.argv.includes('--fail-on-error');
  await runLiveAuditSuite({
    suiteKey: 'all-tools',
    failOnError,
    reportPath: path.join(reportDir, 'live-audit-report.json'),
  });
}

main().catch((err) => {
  console.error(`Live audit flow failed: ${err instanceof Error ? err.stack || err.message : String(err)}`);
  process.exit(1);
});
