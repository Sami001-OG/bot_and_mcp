import { existsSync } from 'node:fs';
for (const candidate of ['.env', '../../.env']) {
  if (existsSync(candidate)) {
    try {
      process.loadEnvFile(candidate);
      break;
    } catch {
      break;
    }
  }
}
