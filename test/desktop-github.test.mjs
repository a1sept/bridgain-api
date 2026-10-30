import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { GithubConnectionService, unseal } from '../dist/workspace/github-connection.service.js';

// No disk database or server: execute the actual PostgreSQL queries in memory.
test('desktop OAuth SQL lifecycle, account confirmation, expiry and cancellation races', { skip: !process.env.WORKFLOW_PGLITE_MODULE }, async t => {
  const { PGlite } = await import(process.env.WORKFLOW_PGLITE_MODULE);
  const pg = new PGlite();
  const originalFetch = globalThis.fetch;
  const envKeys = ['GITHUB_APP_CLIENT_ID','GITHUB_APP_CLIENT_SECRET','GITHUB_APP_SLUG','GITHUB_APP_CALLBACK_URL','GITHUB_TOKEN_ENCRYPTION_KEY'];
  const oldEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { GITHUB_APP_CLIENT_ID: 'client', GITHUB_APP_CLIENT_SECRET: 'secret', GITHUB_APP_SLUG: 'bridgain-test', GITHUB_APP_CALLBACK_URL: 'https://bridgain.example/api/workspace/github/callback', GITHUB_TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32) });
  const key = Buffer.from('ab'.repeat(32), 'hex');
  const uid = randomUUID(), other = randomUUID();
  const digest = value => createHash('sha256').update(value).digest('hex');
  try {
    await pg.exec('create table github_states(state text primary key,user_id uuid not null,verifier text not null,expires_at timestamptz not null); create table github_connections(user_id uuid primary key,token text not null,expires_at timestamptz not null)');
    const adapt = client => drizzle({ query: async (config, params) => {
      const result = await client.query(typeof config === 'string' ? config : config.text, params);
      return config.rowMode === 'array' ? { ...result, rows: result.rows.map(Object.values) } : result;
    } });
    const database = { db: adapt(pg) };
    // PGlite serializes native in-memory transactions; use its transaction client
    // so parallel claims cannot interleave BEGIN/COMMIT on a shared connection.
    database.db.transaction = fn => pg.transaction(tx => fn(adapt(tx)));
    const service = new GithubConnectionService(database);
    const connections = async () => (await pg.query('select * from github_connections')).rows;
    const row = async state => (await pg.query('select * from github_states where state=$1',[digest(state)])).rows[0];
    const pending = () => service.desktopConnect(uid);
    const complete = (flow, confirm = false, instance = service) => instance.desktopComplete(uid, flow.state, flow.claimSecret, confirm);
    const validFetch = async (url, init) => {
      if (url === 'https://github.com/login/oauth/access_token') {
        assert.equal(JSON.parse(init.body).redirect_uri, 'https://bridgain.example/api/workspace/github/callback');
        assert.ok(JSON.parse(init.body).code_verifier);
        return Response.json({access_token:'github-private-token',expires_in:3600});
      }
      assert.equal(init.headers.Authorization, 'Bearer github-private-token');
      if (url === 'https://api.github.com/user') return Response.json({id:123,login:'test-user'});
      if (url.includes('/user/installations?')) return Response.json({installations:[]});
      throw Error('unexpected request');
    };
    globalThis.fetch = validFetch;
    await t.test('ready is not connected; wrong actor/secret cannot claim; restart and explicit confirmation work', async () => {
      const flow = await pending();
      assert.deepEqual(await complete(flow), {connected:false});
      assert.equal(new URL(flow.url).searchParams.get('code_challenge_method'), 'S256');
      assert.ok(!flow.url.includes(flow.claimSecret));
      await assert.rejects(service.desktopComplete(other,flow.state,flow.claimSecret), e=>e.getStatus()===400);
      await assert.rejects(service.desktopComplete(uid,flow.state,'f'.repeat(64)), e=>e.getStatus()===400);
      await service.desktopCallback(flow.state,'code');
      assert.equal((await connections()).length,0);
      assert.ok(!(await row(flow.state)).verifier.includes('github-private-token'));
      const restarted = new GithubConnectionService(database);
      assert.deepEqual(await complete(flow,false,restarted),{connected:false,ready:true,account:{id:123,login:'test-user'}});
      assert.equal((await connections()).length,0);
      assert.deepEqual(await complete(flow,true,restarted),{connected:true,installUrl:'https://github.com/apps/bridgain-test/installations/new'});
      assert.equal(unseal((await connections())[0].token,key),'github-private-token');
      assert.equal(await row(flow.state),undefined);
      await assert.rejects(complete(flow,true),e=>e.getStatus()===400);
    });
    await t.test('duplicate callbacks exchange only once; duplicate confirmations consume only once', async () => {
      const flow=await pending(); let exchanges=0;
      globalThis.fetch=async (...args)=>{ if(args[0].includes('/login/oauth/access_token')) exchanges++; return validFetch(...args); };
      const results=await Promise.allSettled([service.desktopCallback(flow.state,'code'),service.desktopCallback(flow.state,'code')]);
      assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
      assert.equal(exchanges,1);
      const claims=await Promise.allSettled([complete(flow,true),complete(flow,true)]);
      assert.equal(claims.filter(r=>r.status==='fulfilled').length,1);
      globalThis.fetch=validFetch;
    });
    await t.test('cancellation during exchange prevents callback from recreating state or rebinding credentials', async () => {
      const before=(await connections())[0].token, flow=await pending();
      let release, started;
      const entered=new Promise(resolve=>{started=resolve;});
      const gate=new Promise(resolve=>{release=resolve;});
      globalThis.fetch=async (...args)=>{ if(args[0].includes('/login/oauth/access_token')) {started(); await gate;} return validFetch(...args); };
      const callback=service.desktopCallback(flow.state,'code');
      await entered;
      assert.deepEqual(await complete(flow),{connected:false});
      await service.desktopCancel(uid,flow.state,flow.claimSecret);
      release();
      await assert.rejects(callback,e=>e.getStatus()===400);
      assert.equal(await row(flow.state),undefined);
      assert.equal((await connections())[0].token,before);
      globalThis.fetch=validFetch;
    });
    await t.test('expiry blocks callback and confirmation, and access_denied is a terminal consumed failure', async () => {
      const expired=await pending();
      await pg.query("update github_states set expires_at=now()-interval '1 second' where state=$1",[digest(expired.state)]);
      await assert.rejects(service.desktopCallback(expired.state,'code'),e=>e.getStatus()===400);
      await assert.rejects(complete(expired,true),e=>e.getStatus()===400);
      const denied=await pending();
      assert.deepEqual(await service.desktopCallback(denied.state,undefined,'access_denied'),{authorized:false});
      await assert.rejects(complete(denied),e=>e.getResponse().code==='GITHUB_AUTH_FAILED');
      assert.equal(await row(denied.state),undefined);
    });
    await t.test('provider token or profile failure cannot produce a ready state', async () => {
      for(const failure of ['token','profile']) {
        const flow=await pending();
        globalThis.fetch=async (...args)=>{
          if(failure==='token' || args[0]==='https://api.github.com/user') throw Error('private upstream error');
          return validFetch(...args);
        };
        assert.deepEqual(await service.desktopCallback(flow.state,'code'),{authorized:false});
        await assert.rejects(complete(flow,true),e=>e.getResponse().code==='GITHUB_AUTH_FAILED');
      }
      globalThis.fetch=validFetch;
    });
    await t.test('repository outage after commit reports the connection as committed', async()=>{
      const flow=await pending(); await service.desktopCallback(flow.state,'code');
      globalThis.fetch=async()=>{throw Error('outage');};
      assert.deepEqual(await complete(flow,true),{connected:true,installUrl:null,repositoryCheckFailed:true});
      assert.equal(await row(flow.state),undefined);
    });
  } finally {
    globalThis.fetch=originalFetch;
    for(const [k,v] of Object.entries(oldEnv)) { if(v===undefined) delete process.env[k]; else process.env[k]=v; }
    await pg.close();
  }
});
