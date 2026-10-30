import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { projectGithubRequest, projectRepositoryGranted } from '../dist/workspace/project-github.js';
import { StagedWorkService } from '../dist/workspace/staged-work.service.js';

const repo = 'https://github.com/example/project';
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
test('project App credentials are scoped by trusted project grant, repository and operation', async () => {
  const names = ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_PROJECT_REPOSITORIES', 'GITHUB_MERGE_TOKEN'];
  const old = Object.fromEntries(names.map(n => [n, process.env[n]]));
  const oldFetch = global.fetch;
  try {
    process.env.GITHUB_APP_ID = '1234';
    process.env.GITHUB_APP_PRIVATE_KEY = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).replaceAll('\n', '\\n');
    process.env.GITHUB_PROJECT_REPOSITORIES = JSON.stringify({ p: [repo] });
    delete process.env.GITHUB_MERGE_TOKEN;
    let calls = [], badInstallation = false, expired = false;
    global.fetch = async (url, options) => {
      calls.push({ url, options });
      assert.equal(options.redirect, 'error'); assert.ok(options.signal);
      if (url.endsWith('/installation') || url.endsWith('/access_tokens')) {
        const jwt = options.headers.Authorization.slice(7), [h,p,s] = jwt.split('.');
        assert.ok(verify('RSA-SHA256', Buffer.from(h+'.'+p), keys.publicKey, Buffer.from(s, 'base64url')));
        const claims = JSON.parse(Buffer.from(p,'base64url'));
        assert.equal(claims.iss,'1234'); assert.ok(claims.exp - claims.iat <= 600);
      }
      if (url.endsWith('/installation')) return Response.json({ id: 9, suspended_at: badInstallation ? 'today' : null });
      if (url.endsWith('/access_tokens')) return Response.json({ token:'scoped-secret', expires_at: new Date(Date.now() + (expired ? -1000 : 60000)).toISOString() });
      assert.equal(options.headers.Authorization, 'Bearer scoped-secret'); return Response.json({ ok: true });
    };
    await assert.rejects(projectGithubRequest('other',repo,'/pulls/1'), e => e.response.code === 'GITHUB_PROJECT_AUTH_REQUIRED');
    await assert.rejects(projectGithubRequest('p','https://github.com/other/private','/pulls/1'));
    assert.equal(calls.length,0);
    assert.equal(projectRepositoryGranted('__proto__',repo),false);
    await assert.rejects(projectGithubRequest('p',repo,'/../other'));
    assert.deepEqual(await projectGithubRequest('p',repo,'/git/ref/heads/task%2F142'),{ok:true});
    assert.deepEqual(JSON.parse(calls[1].options.body),{repositories:['project'],permissions:{contents:'read',pull_requests:'read'}});
    calls=[];
    await projectGithubRequest('p',repo,'/pulls/1/merge','PUT',{sha:'a'.repeat(40)});
    assert.deepEqual(JSON.parse(calls[1].options.body).permissions,{contents:'write',pull_requests:'write'});
    assert.equal(JSON.parse(calls[2].options.body).sha,'a'.repeat(40));
    // Shared task access works without a personal OAuth connection, but still checks DB registration.
    const db = { select: () => ({ from: () => ({ where: async () => [{ repositoryUrls: [repo] }] }) }) };
    const service = new StagedWorkService({db}, {}, undefined);
    assert.deepEqual(await service.taskGithub({projectId:'p',repositoryUrl:repo},undefined,'/repos/example/project/pulls/1'),{ok:true});
    await assert.rejects(service.taskGithub({projectId:'p',repositoryUrl:'https://github.com/other/private'},undefined,'/repos/other/private/pulls/1'), e => e.response.code==='REPOSITORY_DENIED');
    badInstallation=true;
    await assert.rejects(projectGithubRequest('p',repo,'/pulls/1'), e=>e.response.code==='GITHUB_PROJECT_ACCESS_REQUIRED');
    badInstallation=false; expired=true;
    await assert.rejects(projectGithubRequest('p',repo,'/pulls/1'), e=>e.response.code==='GITHUB_UNAVAILABLE');
    global.fetch=async()=>new Response('SECRET ERROR', {status:403});
    await assert.rejects(projectGithubRequest('p',repo,'/pulls/1'), e=>e.response.code==='GITHUB_PROJECT_ACCESS_REQUIRED' && !JSON.stringify(e.response).includes('SECRET'));
  } finally { global.fetch=oldFetch; for(const n of names) old[n]===undefined ? delete process.env[n] : process.env[n]=old[n]; }
});
