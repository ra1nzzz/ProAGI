import process from 'node:process';
import { verificationRetentionDaysForTier } from './check-suites.mjs';

const argv = process.argv.slice(2);
if (argv.length !== 2 || argv[0] !== '--tier' || !['pr', 'nightly', 'release'].includes(argv[1])) {
  throw new Error('Usage: node scripts/verification-metadata.mjs --tier pr|nightly|release');
}
console.log(verificationRetentionDaysForTier(argv[1]));
