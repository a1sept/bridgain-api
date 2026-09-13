import { defineConfig } from 'drizzle-kit';
import { databaseCredentials } from './src/config';

// Generation is offline. Database credentials are required only for DB commands.
const isGenerate = process.argv.includes('generate');
export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  ...(isGenerate ? {} : { dbCredentials: databaseCredentials() }),
});
