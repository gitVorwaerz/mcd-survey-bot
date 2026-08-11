// Lokaler Test: Solver gegen die echte Umfrage (Fake-Code → erwartet Validierungsfehler)
// Benötigt CHROMIUM_PATH (Playwright-Headless-Shell) + LOCAL_HOST_MAP wegen Heimnetz-DNS-Block.
import { solveSurvey } from '../lib/solver.js';

const code = process.argv[2] || '0vm2-293m-hov';

const t0 = Date.now();
const result = await solveSurvey(code);
console.log('\n===== RESULT =====');
console.log('ok:', result.ok);
console.log('code:', result.code);
console.log('message:', result.message);
console.log('duration:', ((Date.now() - t0) / 1000).toFixed(1) + 's');
console.log('screenshot:', result.screenshotPath);
console.log('===== LOG =====');
console.log(result.logs.join('\n'));
