import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HealthController } from '../dist/health.controller.js';
import { databaseCredentials } from '../dist/config.js';

test('health checks the database before reporting ready', async () => {
  let checked = false;
  const controller = new HealthController({ checkConnection: async () => { checked = true; } });
  assert.deepEqual(await controller.check(), { status: 'ok', database: 'connected' });
  assert.equal(checked, true);
});

test('database errors return 503 without connection or credential details', async () => {
  const controller = new HealthController({
    checkConnection: async () => { throw new Error('postgres://admin:TOP_SECRET@db/private'); },
  });
  await assert.rejects(controller.check(), (error) => {
    assert.equal(error.getStatus(), 503);
    assert.deepEqual(error.getResponse(), { status: 'error', database: 'unavailable' });
    assert.equal(JSON.stringify(error).includes('TOP_SECRET'), false);
    return true;
  });
});

test('database configuration preserves special characters and rejects invalid ports', () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, {
      DATABASE_HOST: 'db', DATABASE_PORT: '5432', DATABASE_USER: 'bridgain',
      DATABASE_PASSWORD: 'p@ss:#/?', DATABASE_NAME: 'bridgain_dev',
    });
    assert.equal(databaseCredentials().password, 'p@ss:#/?');
    process.env.DATABASE_PORT = '5432invalid';
    assert.throws(databaseCredentials, /DATABASE_PORT must be an integer port/);
    delete process.env.DATABASE_PASSWORD;
    assert.throws(databaseCredentials);
  } finally {
    process.env = saved;
  }
});
