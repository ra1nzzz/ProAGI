import { readFile } from 'node:fs/promises';

const html = await readFile('index.html', 'utf8');
const match = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/);
if (!match) throw new Error('CSP meta is missing');
const policy = match[1];
const required = [
  "default-src 'self'", "script-src 'self'", "connect-src 'none'", "worker-src 'self'",
  "object-src 'none'", "base-uri 'none'", "form-action 'none'",
];
for (const directive of required) {
  if (!policy.includes(directive)) throw new Error(`CSP directive missing: ${directive}`);
}
if (/https?:|wss?:|\*/.test(policy)) throw new Error('CSP permits an external or wildcard source');
console.log('CSP contract verified.');
