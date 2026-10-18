import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { randomBytes } from 'node:crypto';
import { GithubConnectionService, seal, unseal } from '../dist/workspace/github-connection.service.js';
import { GithubConnectionController } from '../dist/workspace/github-connection.controller.js';
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
function configure() {
  Object.assign(process.env, { GITHUB_APP_CLIENT_ID: 'test-client', GITHUB_APP_CLIENT_SECRET: 'secret', GITHUB_APP_SLUG: 'bridgain-test', GITHUB_APP_CALLBACK_URL: 'http://localhost:15174/api/workspace/github/callback', GITHUB_TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32) });
}
function database() {
  const rows = new Map();
  let state;
  const db = {
    select: () => ({ from: () => ({ where: async () => [...rows.values()] }) }),
    insert: () => ({ values: value => {
      if ('state' in value) { state = value; return Promise.resolve(); }
      return { onConflictDoUpdate: async () => { rows.set(value.userId, value); } };
    } }),
    delete: () => ({ where: () => ({ returning: async () => { const pending = state; state = undefined; return pending ? [pending] : []; }, then: resolve => resolve() }) }),
  };
  return { db, rows, pending: () => state };
}
test('encrypted credentials round trip and reject tampering or wrong keys', () => {
  const key = randomBytes(32); const encrypted = seal('private-token', key);
  assert.equal(unseal(encrypted, key), 'private-token');
  assert.ok(!encrypted.includes('private-token'));
  assert.notEqual(encrypted, seal('private-token', key));
  assert.throws(() => unseal(encrypted, randomBytes(32)));
  const bytes = Buffer.from(encrypted, 'base64'); bytes[12] ^= 1;
  assert.throws(() => unseal(bytes.toString('base64'), key));
});
test('authorization uses PKCE; callback is one-use and tokens stay encrypted', async () => {
  configure(); const db = database(); const service = new GithubConnectionService(db);
  const { url } = await service.start('user'); const params = new URL(url).searchParams;
  assert.equal(params.get('code_challenge_method'), 'S256');
  assert.notEqual(db.pending().state, params.get('state'));
  assert.ok(db.pending().expiresAt > new Date());
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://github.com/login/oauth/access_token');
    assert.ok(JSON.parse(init.body).code_verifier);
    return Response.json({ access_token: 'private-token', expires_in: 3600 });
  };
  await service.callback('user', params.get('state'), 'code');
  assert.notEqual(db.rows.get('user').token, 'private-token');
  assert.equal((await service.status('user')).connected, true);
  await assert.rejects(service.callback('user', params.get('state'), 'code'), e => e.getStatus() === 400);
});
test('missing configuration and malformed callbacks fail before network access', async () => {
  configure(); const service = new GithubConnectionService(database());
  await assert.rejects(service.callback('user', 'invalid', 'code'), e => e.getStatus() === 400);
  delete process.env.GITHUB_TOKEN_ENCRYPTION_KEY;
  await assert.rejects(service.start('user'), e => e.getStatus() === 503);
});
test('both public and private repositories use authorized installation lists and pagination', async () => {
  configure(); const db = database();
  db.rows.set('user', { token: seal('token', Buffer.from('ab'.repeat(32), 'hex')), expiresAt: new Date(Date.now() + 3600000) });
  const service = new GithubConnectionService(db);
  const paths = [];
  globalThis.fetch = async (url, init) => {
    paths.push(url); assert.equal(init.headers.Authorization, 'Bearer token');
    if (url.includes('/user/installations?')) return Response.json({ installations: [{ id: 5 }] });
    const count = url.endsWith('page=1') ? 100 : 1;
    return Response.json({ repositories: Array.from({ length: count }, (_, id) => ({ id, full_name: `team/repo${id}`, html_url: `https://github.com/team/repo${id}`, private: id % 2 === 0, default_branch: 'main', owner: { login: 'team', avatar_url: 'https://avatars.githubusercontent.com/u/1', type: 'Organization' } })) });
  };
  const repos = await service.repositories('user');
  assert.deepEqual(repos[0].owner, { login: 'team', avatarUrl: 'https://avatars.githubusercontent.com/u/1', type: 'Organization' });
  assert.equal(repos.length, 101); assert.ok(repos.some(r => r.private)); assert.ok(repos.some(r => !r.private));
  assert.ok(paths.some(p => p.endsWith('page=2')));
  assert.ok(repos.every(r => !('token' in r)));
  await service.verify('user', ['https://github.com/team/repo0']);
  await assert.rejects(service.verify('user', ['https://github.com/other/private']), e => e.getStatus() === 403);
});
test('GitHub revocation and network failures yield sanitized errors', async () => {
  configure(); const db = database();
  db.rows.set('user', { token: seal('token', Buffer.from('ab'.repeat(32), 'hex')), expiresAt: new Date(Date.now() + 3600000) });
  const service = new GithubConnectionService(db);
  globalThis.fetch = async () => new Response('secret-token', { status: 401 });
  await assert.rejects(service.repositories('user'), e => e.getStatus() === 403 && !e.message.includes('secret-token'));
  globalThis.fetch = async () => { throw Error('secret-token'); };
  await assert.rejects(service.repositories('user'), e => e.getStatus() === 502 && !e.message.includes('secret-token'));
});
test('integration endpoints reject client and personal developer accounts', async () => {
  const req = { get: () => 'developer' }; const res = {};
  const controller = new GithubConnectionController({ user: async () => ({ id: 'user', accountType: 'client' }) }, { status: () => { throw Error('unexpected'); } });
  await assert.rejects(controller.status(req, res), e => e.getStatus() === 403);
});

test('project creation and edits cannot persist a forged repository selection', async () => {
  const { WorkspaceController } = await import('../dist/workspace/workspace.controller.js');
  let writes = 0;
  const controller = new WorkspaceController({}, {
    create: async () => { writes++; }, update: async () => { writes++; },
  }, { verify: async (userId, urls) => {
    assert.equal(userId, 'actor');
    if (urls.length) throw Error('access denied');
  } });
  controller.user = async () => ({ id: 'actor', accountType: 'team' });
  await assert.rejects(controller.create({}, {}, { repositoryUrls: ['https://github.com/other/private'] }), /access denied/);
  await assert.rejects(controller.update({}, {}, 'project', { repositoryUrls: ['https://github.com/other/private'] }), /access denied/);
  assert.equal(writes, 0);
  await controller.create({}, {}, { repositoryUrls: [] });
  await controller.update({}, {}, 'project', { name: 'Rename only' });
  assert.equal(writes, 2);
});

test('external HTTP callback requires development mode and the configured frontend origin', async () => {
  const { validGithubCallback } = await import('../dist/workspace/github-connection.service.js');
  const previous = { node: process.env.NODE_ENV, origin: process.env.DEVELOPER_APP_ORIGIN };
  try {
    process.env.NODE_ENV = 'development';
    process.env.DEVELOPER_APP_ORIGIN = 'http://nexusnas.iptime.org:15174';
    assert.equal(validGithubCallback('http://nexusnas.iptime.org:15174/api/workspace/github/callback'), true);
    for (const url of ['http://nexusnas.iptime.org:15175/api/workspace/github/callback', 'http://other.test:15174/api/workspace/github/callback', 'http://nexusnas.iptime.org:15174/wrong', 'http://user:pass@nexusnas.iptime.org:15174/api/workspace/github/callback', 'not-a-url']) assert.equal(validGithubCallback(url), false);
    process.env.NODE_ENV = 'production';
    assert.equal(validGithubCallback('http://nexusnas.iptime.org:15174/api/workspace/github/callback'), false);
    assert.equal(validGithubCallback('https://nexusnas.iptime.org/api/workspace/github/callback'), true);
  } finally {
    for (const [key, value] of [['NODE_ENV', previous.node], ['DEVELOPER_APP_ORIGIN', previous.origin]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('successful callback notifies the original page and closes the popup with nonce-protected script', async () => {
  const headers = {}; let html; let completed = false;
  const controller = new GithubConnectionController({ user: async () => ({ id: 'actor', accountType: 'team' }) }, {
    installationUrlIfNeeded: async () => null,
    callback: async (id, state, code) => { assert.equal(id, 'actor'); assert.equal(state, 'state'); assert.equal(code, 'code'); completed = true; },
  });
  const res = { setHeader: (key, value) => { headers[key] = value; }, type: () => res, send: value => { assert.equal(completed, true); html = value; } };
  await controller.callback({ get: () => 'developer' }, res, 'state', 'code');
  const nonce = /<script nonce="([^"]+)"/.exec(html)[1];
  assert.ok(headers['Content-Security-Policy'].includes(`script-src 'nonce-${nonce}'`));
  assert.ok(html.includes("new BroadcastChannel('bridgain-github')"));
  assert.ok(html.includes('window.close()'));
  assert.equal(headers['Referrer-Policy'], 'no-referrer');
});

test('one-click connect skips OAuth when authorized and opens installation only when needed', async () => {
  configure();
  const service = new GithubConnectionService(database());
  service.status = async () => ({ connected: true, installUrl: 'https://github.com/apps/bridgain-test/installations/new' });
  service.repositories = async () => [];
  assert.equal((await service.connect('user')).url, 'https://github.com/apps/bridgain-test/installations/new');
  assert.equal(await service.installationUrlIfNeeded('user'), 'https://github.com/apps/bridgain-test/installations/new');
  service.repositories = async () => [{ id: 1 }];
  assert.equal((await service.connect('user')).url, 'http://localhost:15174/api/workspace/github/callback/complete');
  assert.equal(await service.installationUrlIfNeeded('user'), null);
});

test('one-click connect starts OAuth for new and revoked authorizations', async () => {
  const { HttpException } = await import('@nestjs/common');
  configure();
  const service = new GithubConnectionService(database());
  service.status = async () => ({ connected: false });
  assert.equal(new URL((await service.connect('user')).url).pathname, '/login/oauth/authorize');
  service.status = async () => ({ connected: true });
  service.repositories = async () => { throw new HttpException('revoked', 403); };
  assert.equal(new URL((await service.connect('user')).url).pathname, '/login/oauth/authorize');
  service.repositories = async () => { throw new HttpException('outage', 502); };
  await assert.rejects(service.connect('user'), e => e.getStatus() === 502);
});

test('OAuth callback continues directly to installation instead of closing on an empty list', async () => {
  let exchanged = false; let redirected;
  const controller = new GithubConnectionController({ user: async () => ({ id: 'actor', accountType: 'team' }) }, {
    callback: async () => { exchanged = true; },
    installationUrlIfNeeded: async () => { assert.equal(exchanged, true); return 'https://github.com/apps/bridgain-test/installations/new'; },
  });
  await controller.callback({ get: () => 'developer' }, { redirect: url => { redirected = url; } }, 'state', 'code');
  assert.equal(redirected, 'https://github.com/apps/bridgain-test/installations/new');
});
