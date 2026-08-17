import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const prisma = path.join(root, 'node_modules', 'prisma', 'build', 'index.js');
const nextBin = path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next');

const packages = ['contracts', 'security', 'database', 'exchange-core', 'exchange-adapters', 'trading-core', 'risk-engine', 'bot-engine', 'webhook', 'commands'];

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', env: process.env, ...opts });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const clientDir = path.join(root, 'apps', 'web', 'prisma', 'generated', 'client');
const oldClientDir = path.join(root, 'packages', 'database', 'generated');

console.log('[vercel-build] clearing generated clients (ensure Linux engine)');
fs.rmSync(clientDir, { recursive: true, force: true });
fs.rmSync(oldClientDir, { recursive: true, force: true });

console.log('[vercel-build] generating prisma client');
run(process.execPath, [prisma, 'generate', '--schema', path.join('packages', 'database', 'prisma', 'schema.prisma')]);

const generatedFiles = fs.readdirSync(clientDir);
console.log('[vercel-build] generated client dir:', generatedFiles.join(', '));
const engineFile = generatedFiles.find((f) => /query_engine-.*\.node$/.test(f));
if (!engineFile) {
  console.error('[vercel-build] FATAL: no Prisma query engine binary in generated client dir');
  process.exit(1);
}
console.log('[vercel-build] engine binary present:', engineFile);

console.log('[vercel-build] compiling workspace packages');
for (const pkg of packages) {
  console.log(`  -> @platform/${pkg}`);
  run(process.execPath, [tsc, '-p', path.join('packages', pkg, 'tsconfig.json')]);
}

console.log('[vercel-build] building next app');
run(process.execPath, [nextBin, 'build'], { cwd: path.join(root, 'apps', 'web') });

const engineSource = path.join(clientDir, engineFile);
const nextServerDir = path.join(root, 'apps', 'web', '.next', 'server');
fs.copyFileSync(engineSource, path.join(nextServerDir, engineFile));
console.log('[vercel-build] engine copied to .next/server for lambda initial layer:', engineFile);

const requiredServerFilesPath = path.join(root, 'apps', 'web', '.next', 'required-server-files.json');
const rsf = JSON.parse(fs.readFileSync(requiredServerFilesPath, 'utf8'));
const engineRel = path.join('.next', 'server', engineFile);
if (!rsf.files.includes(engineRel)) {
  rsf.files.push(engineRel);
  fs.writeFileSync(requiredServerFilesPath, JSON.stringify(rsf, null, 2) + '\n');
  console.log('[vercel-build] engine registered in required-server-files.json files list:', engineRel);
} else {
  console.log('[vercel-build] engine already registered in required-server-files.json');
}

const nftFiles = [];
function walkNft(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walkNft(p);
    else if (e.name.endsWith('.js.nft.json')) nftFiles.push(p);
  }
}
walkNft(path.join(root, 'apps', 'web', '.next', 'server'));
const engineHits = [];
for (const nf of nftFiles) {
  try {
    const j = JSON.parse(fs.readFileSync(nf, 'utf8'));
    for (const f of j.files || []) {
      if (f.includes('query_engine') || f.includes('generated')) engineHits.push(`${nf.split('.next')[1]}: ${f}`);
    }
  } catch { }
}
console.log(`[vercel-build] nft.json files checked: ${nftFiles.length}`);
for (const nf of nftFiles) console.log('[vercel-build] NFTFILE:', nf.split('.next')[1]);
const perFile = new Map();
for (const nf of nftFiles) {
  try {
    const j = JSON.parse(fs.readFileSync(nf, 'utf8'));
    const eng = (j.files || []).filter((f) => f.includes('query_engine'));
    if (eng.length) perFile.set(nf, eng);
  } catch { }
}
console.log(`[vercel-build] nft.json files WITH engine: ${perFile.size}`);
for (const [nf, eng] of perFile) console.log('[vercel-build] HAS-ENGINE:', nf.split('.next')[1], '->', eng[0]);
if (engineHits.length === 0) {
  console.error('[vercel-build] FATAL: no prisma engine/generated-client entries in any nft.json trace');
  process.exit(1);
}
for (const h of engineHits.slice(0, 20)) console.log('[vercel-build] trace:', h);