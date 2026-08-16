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

console.log('[vercel-build] compiling workspace packages');
for (const pkg of packages) {
  console.log(`  -> @platform/${pkg}`);
  run(process.execPath, [tsc, '-p', path.join('packages', pkg, 'tsconfig.json')]);
}

console.log('[vercel-build] building next app');
run(process.execPath, [nextBin, 'build'], { cwd: path.join(root, 'apps', 'web') });