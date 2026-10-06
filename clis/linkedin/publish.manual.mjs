import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

function parseArgs(argv) {
  const out = { text: '', file: '', images: '', cdp: '', dryRun: false, format: '', timeout: '' };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--text') out.text = argv[++i] ?? '';
    else if (a === '--file') out.file = argv[++i] ?? '';
    else if (a === '--images') out.images = argv[++i] ?? '';
    else if (a === '--cdp-endpoint') out.cdp = argv[++i] ?? '';
    else if (a === '--format') out.format = argv[++i] ?? '';
    else if (a === '--timeout') out.timeout = argv[++i] ?? '';
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else positional.push(a);
  }
  if (!out.text && !out.file && positional.length) out.text = positional.join(' ');
  return out;
}

function resolveTsx() {
  const candidates = [
    path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    path.join(repoRoot, 'node_modules', '.bin', 'tsx'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

function usage() {
  console.log(`Manual runner for the linkedin publish adapter.

Usage:
  node clis/linkedin/publish.manual.mjs [options]

Options (mirror the opencli linkedin publish args):
  --text <text>            Post body text, or a path to a .txt file
  --file <path.txt>        Read post body from a .txt file
  --images <a.png,b.png>   Comma-separated local image paths (max 4)
  --cdp-endpoint <url>     CDP endpoint of the logged-in Chrome (e.g. http://127.0.0.1:34764)
  --dry-run                Fill everything, skip the final submit
  --format <fmt>           Output format: table|json|yaml|md|csv
  --timeout <sec>          Max seconds for the publish command
  -h, --help               Show this help

Examples:
  node clis/linkedin/publish.manual.mjs --text "hello" --cdp-endpoint http://127.0.0.1:34764 --dry-run
  node clis/linkedin/publish.manual.mjs --text "hello" --images ./a.png --cdp-endpoint http://127.0.0.1:34764
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); return 0; }

  const cliArgs = ['linkedin', 'publish'];
  if (args.file) cliArgs.push('--file', args.file);
  else if (args.text) cliArgs.push(args.text);
  if (args.images) cliArgs.push('--images', args.images);
  if (args.dryRun) cliArgs.push('--dry-run');
  if (args.format) cliArgs.push('--format', args.format);
  if (args.timeout) cliArgs.push('--timeout', String(args.timeout));
  if (args.cdp) cliArgs.unshift('--cdp-endpoint', args.cdp);

  const tsx = resolveTsx();
  const cmd = tsx ? process.execPath : 'npx';
  const spawnArgs = tsx ? [tsx, 'src/main.ts', ...cliArgs] : ['tsx', 'src/main.ts', ...cliArgs];

  console.error(`> running: ${cmd} ${spawnArgs.join(' ')}\n`);
  const child = spawn(cmd, spawnArgs, { cwd: repoRoot, stdio: 'inherit' });
  const code = await new Promise((resolve) => child.on('close', resolve));
  return code ?? 1;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(err);
  process.exit(1);
});
