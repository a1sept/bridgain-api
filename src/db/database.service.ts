import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { databaseCredentials } from '../config.js';
import * as schema from './schema/index.js';

@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseService.name);
  private readonly pool = new Pool({
    ...databaseCredentials(),
    max: 5,
    connectionTimeoutMillis: 5000,
    query_timeout: 5000,
    statement_timeout: 5000,
  });
  readonly db = drizzle(this.pool, { schema });

  constructor() {
    // Idle pool errors must not crash the process or expose connection details.
    this.pool.on('error', () => this.logger.error('Database connection interrupted'));
  }

  async checkConnection(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
