// Prisma 7 CLI configuration (replaces the datasource url in schema.prisma).
// The CLI no longer auto-loads .env; dotenv covers local dev, and in Docker the
// variables come from the container environment (dotenv no-ops without a file).
import 'dotenv/config'
import { defineConfig } from 'prisma/config'

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  // May be undefined during `prisma generate` (e.g. Docker image build);
  // only migrate/introspect commands require it.
  datasource: {
    url: process.env.DATABASE_URL,
  },
})
