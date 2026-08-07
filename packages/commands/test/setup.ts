process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'a'.repeat(64);
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380';
