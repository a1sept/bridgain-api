import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseGitmodules, normalizeSubmoduleUrl, repositoryRelations } from '../dist/workspace/submodules.js';
import { GithubConnectionService, seal } from '../dist/workspace/github-connection.service.js';
const parentUrl = 'https://github.com/team/root';
const childUrl = 'https://github.com/team/api';
const edge = { parentUrl, childUrl, path: 'apps/api', commit: 'b'.repeat(40), parentCommit: 'a'.repeat(40) };

test('Git submodule config parses real paths, quoted values, comments and multiple modules', () => {
  const config = parseGitmodules('[submodule "apps/api"]\n path = apps/api\n url = git@github.com:team/api.git\n[submodule "web"]\n path = "apps/web ui"\n url = "../web.git" # comment\n');
  assert.equal(config.get('apps/api'), 'git@github.com:team/api.git');
  assert.equal(config.get('apps/web ui'), '../web.git');
  assert.throws(() => parseGitmodules('[submodule "a"]\npath=x\nurl=../a\n[submodule "b"]\npath=x\nurl=../b'));
});
test('SSH and relative submodule URLs normalize without permitting external hosts or credential URLs', () => {
  for (const url of ['git@github.com:team/api.git', 'ssh://git@github.com/team/api.git', '../api.git', childUrl]) assert.equal(normalizeSubmoduleUrl(url, parentUrl), childUrl);
  for (const url of ['https://evil.test/a/b', 'file:///tmp/repo', 'https://token@github.com/team/api', 'git@github.com.evil.test:team/api']) assert.equal(normalizeSubmoduleUrl(url, parentUrl), null);
});
test('relations require selected endpoints, safe paths, unique paths and exact commit SHAs', () => {
  assert.deepEqual(repositoryRelations([edge], [parentUrl, childUrl]), [edge]);
  for (const relations of [[{...edge, path: '../escape'}], [{...edge, commit: 'main'}], [{...edge, childUrl: parentUrl}], [edge, edge], [{...edge, path: 'apps\\api'}]]) assert.throws(() => repositoryRelations(relations, [parentUrl, childUrl]));
  assert.throws(() => repositoryRelations([edge], [parentUrl]));
});
function service() {
  Object.assign(process.env, { GITHUB_APP_CLIENT_ID: 'id', GITHUB_APP_CLIENT_SECRET: 'secret', GITHUB_APP_SLUG: 'app', GITHUB_APP_CALLBACK_URL: 'http://localhost:15174/api/workspace/github/callback', GITHUB_TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32) });
  const row = { token: seal('test-token', Buffer.from('ab'.repeat(32), 'hex')) };
  const instance = new GithubConnectionService({ db: { select: () => ({ from: () => ({ where: async () => [row] }) }) } });
  instance.repositories = async () => [{ url: parentUrl, fullName: 'team/root', defaultBranch: 'main' }, { url: childUrl, fullName: 'team/api' }];
  return instance;
}
test('discovery joins actual Git links to gitmodules at an immutable parent commit and flags inaccessible children', async () => {
  const instance = service(); const requests = [];
  instance.api = async path => {
    requests.push(path);
    if (path.includes('/commits/')) return { sha: edge.parentCommit, commit: { tree: { sha: 'c'.repeat(40) } } };
    if (path.includes('/git/trees/')) return { truncated: false, tree: [{ mode: '160000', type: 'commit', path: 'apps/api', sha: edge.commit }, { mode: '160000', type: 'commit', path: 'private', sha: 'd'.repeat(40) }, { mode: '100644', type: 'blob', path: 'ordinary', sha: 'e'.repeat(40) }] };
    assert.ok(path.endsWith(`?ref=${edge.parentCommit}`));
    return { encoding: 'base64', size: 200, content: Buffer.from('[submodule "api"]\npath=apps/api\nurl=../api.git\n[submodule "private"]\npath=private\nurl=git@github.com:team/secret.git').toString('base64') };
  };
  const result = await instance.submodules('actor', parentUrl);
  assert.equal(result.submodules.length, 2);
  assert.equal(result.submodules[0].available, true);
  assert.equal(result.submodules[0].childUrl, childUrl);
  assert.equal(result.submodules[1].available, false);
  assert.equal(result.submodules[0].commit, edge.commit);
  await instance.verifyRelations('actor', [edge]);
  await assert.rejects(instance.verifyRelations('actor', [{...edge, commit: 'f'.repeat(40)}]), e => e.getStatus() === 400);
  await assert.rejects(instance.submodules('actor', 'https://github.com/other/root'), e => e.getStatus() === 403);
});
test('no-submodule repositories avoid contents requests and truncated trees fail instead of returning incomplete relationships', async () => {
  const instance = service();
  instance.api = async path => path.includes('/commits/') ? { sha: edge.parentCommit, commit: { tree: { sha: 'c'.repeat(40) } } } : { truncated: false, tree: [] };
  assert.deepEqual((await instance.submodules('actor', parentUrl)).submodules, []);
  instance.api = async path => path.includes('/commits/') ? { sha: edge.parentCommit, commit: { tree: { sha: 'c'.repeat(40) } } } : { truncated: true, tree: [] };
  await assert.rejects(instance.submodules('actor', parentUrl), e => e.getStatus() === 422);
});

test('project save writes repository URLs and relationships together and prunes detached endpoints', async () => {
  const { WorkspaceService } = await import('../dist/workspace/workspace.service.js');
  let patch;
  let transactions = 0;
  const tx = { select: () => ({from: () => ({where: () => ({for: async () => [{repositoryUrls:[parentUrl,childUrl],repositoryRelations:[edge]}]})})}), update: () => ({ set: value => { patch = value; return { where: () => ({ returning: async () => [{id: 'project', ...value}] }) }; } }) };
  const workspace = new WorkspaceService({ db: { transaction: async fn => { transactions++; return fn(tx); } } });
  workspace.manager = async () => ({ repositoryUrls: [parentUrl, childUrl], repositoryRelations: [edge] });
  const actor = { id: 'actor', accountType: 'team' };
  await workspace.update(actor, 'project', { repositoryUrls: [parentUrl, childUrl], repositoryRelations: [edge] });
  assert.deepEqual(patch.repositoryRelations, [edge]);
  assert.deepEqual(patch.repositoryUrls, [parentUrl, childUrl]);
  await workspace.update(actor, 'project', { repositoryUrls: [parentUrl] });
  assert.deepEqual(patch.repositoryRelations, []);
  assert.equal(transactions, 2);
  await assert.rejects(workspace.update(actor, 'project', { repositoryUrls: [parentUrl], repositoryRelations: [edge] }), e => e.getStatus() === 400);
});
