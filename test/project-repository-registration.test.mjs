import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorkspaceController } from '../dist/workspace/workspace.controller.js';

test('project repository metadata saves without personal GitHub authentication', async () => {
  const user = { id: 'manager' };
  const workspace = { update: async (actor, id, body) => {
    assert.equal(actor, user); assert.equal(id, 'project');
    return body;
  } };
  const github = new Proxy({}, { get() { throw Error('Personal GitHub authentication must not be consulted'); } });
  const controller = new WorkspaceController({}, workspace, github);
  controller.user = async () => user;
  const body = { repositoryUrls: ['https://github.com/example/repo'], repositoryRelations: [] };
  assert.deepEqual(await controller.update({}, {}, 'project', body), body);
});

test('metadata update still delegates authorization to project settings service', async () => {
  const denied = Error('project.settings denied');
  const controller = new WorkspaceController({}, { update: async () => { throw denied; } }, {});
  controller.user = async () => ({ id: 'member' });
  await assert.rejects(controller.update({}, {}, 'project', { repositoryUrls: ['https://github.com/example/repo'] }), error => error === denied);
});

test('project relation metadata rejects repositories outside the registered list', async () => {
  const controller = new WorkspaceController({}, { update: async () => assert.fail('must reject malformed metadata') }, {});
  controller.user = async () => ({ id: 'manager' });
  await assert.rejects(controller.update({}, {}, 'project', { repositoryUrls: ['https://github.com/example/repo'], repositoryRelations: [{ parentUrl: 'https://github.com/example/repo', childUrl: 'https://github.com/other/private', path: 'child', commit: 'a'.repeat(40), parentCommit: 'b'.repeat(40) }] }));
});
