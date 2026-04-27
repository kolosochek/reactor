import { defineConfig } from 'drizzle-kit';
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: '../../.env' });

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.REACTOR_DATABASE_URL ?? 'postgres://reactor:reactor@localhost:5433/reactor',
  },
  strict: true,
  verbose: true,
});
