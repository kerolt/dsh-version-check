import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchDistTags,
  fetchPublishedVersions,
  pickTarget,
  selectRollbackCandidates,
  type FetchLike,
} from '../lib/registry.js';

const REAL_DIST_TAGS: Record<string, string> = {
  latest: '0.2.1-rc.5',
  alpha: '0.2.2-alpha.2',
  next: '0.2.1-rc.5',
};

const DIST_TAGS_URL = 'https://registry.npmjs.org/-/package/@deepseek-ai%2Fdsh/dist-tags';

test('fetchDistTags 请求 dist-tags 端点并返回条目', async () => {
  const requests: Array<{ url: string; options: { headers: Record<string, string>; signal: AbortSignal } }> = [];
  const fetchImpl: FetchLike = async (url, options) => {
    requests.push({ url, options });
    return { status: 200, json: async () => REAL_DIST_TAGS };
  };

  const distTags = await fetchDistTags('https://registry.npmjs.org', fetchImpl);
  assert.deepEqual(distTags, REAL_DIST_TAGS);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, DIST_TAGS_URL);
  assert.equal(requests[0].options.headers.accept, 'application/json');
  assert.ok(requests[0].options.signal instanceof AbortSignal);
});

test('fetchDistTags 去掉 registry 末尾斜杠', async () => {
  const requests: string[] = [];
  const fetchImpl = async (url: string) => {
    requests.push(url);
    return { status: 200, json: async () => REAL_DIST_TAGS };
  };

  await fetchDistTags('https://registry.npmjs.org/', fetchImpl);
  assert.equal(requests[0], DIST_TAGS_URL);
});

test('fetchDistTags 丢弃值不是合法 semver 的条目', async () => {
  const fetchImpl = async () => ({
    status: 200,
    json: async () => ({
      latest: '0.2.1-rc.5',
      beta: 'not-a-version',
      count: 3,
      empty: '',
      missing: null,
      next: '0.2.1-rc.6',
    }),
  });

  const distTags = await fetchDistTags('https://registry.npmjs.org', fetchImpl);
  assert.deepEqual(distTags, { latest: '0.2.1-rc.5', next: '0.2.1-rc.6' });
});

test('fetchDistTags 接受空对象', async () => {
  const fetchImpl = async () => ({ status: 200, json: async () => ({}) });
  assert.deepEqual(await fetchDistTags('https://registry.npmjs.org', fetchImpl), {});
});

test('fetchDistTags 对非 200 响应抛出错误', async () => {
  const fetchImpl = async () => ({ status: 500, json: async () => ({}) });
  await assert.rejects(fetchDistTags('https://registry.npmjs.org', fetchImpl), /HTTP 500/);
});

test('fetchDistTags 对非对象响应抛出错误', async () => {
  const arrayFetch = async () => ({ status: 200, json: async () => [] });
  await assert.rejects(fetchDistTags('https://registry.npmjs.org', arrayFetch), /不是对象/);

  const nullFetch = async () => ({ status: 200, json: async () => null });
  await assert.rejects(fetchDistTags('https://registry.npmjs.org', nullFetch), /不是对象/);
});

test('fetchDistTags 向上传递 fetch 抛出的错误', async () => {
  const fetchImpl = async () => {
    throw new Error('boom');
  };
  await assert.rejects(fetchDistTags('https://registry.npmjs.org', fetchImpl), /boom/);
});

test('fetchDistTags 拒绝非法 registry 地址', async () => {
  await assert.rejects(fetchDistTags('', async () => ({ status: 200, json: async () => ({}) })), TypeError);
  await assert.rejects(fetchDistTags(null, async () => ({ status: 200, json: async () => ({}) })), TypeError);
});

test('pickTarget 处理真实 dist-tags 数据', () => {
  assert.deepEqual(pickTarget(REAL_DIST_TAGS, '0.2.1-rc.3'), { tag: 'latest', version: '0.2.1-rc.5' });
  assert.deepEqual(pickTarget(REAL_DIST_TAGS, '0.2.2-alpha.1'), { tag: 'alpha', version: '0.2.2-alpha.2' });
  assert.deepEqual(pickTarget(REAL_DIST_TAGS, '0.2.1-rc.3', 'alpha'), {
    tag: 'alpha',
    version: '0.2.2-alpha.2',
  });
});

test('pickTarget 跟踪非 auto 渠道', () => {
  assert.deepEqual(pickTarget(REAL_DIST_TAGS, '0.2.1-rc.3', 'next'), { tag: 'next', version: '0.2.1-rc.5' });
});

test('pickTarget 在显式渠道缺失时退回常规选择', () => {
  assert.deepEqual(pickTarget(REAL_DIST_TAGS, '0.2.1-rc.3', 'beta'), { tag: 'latest', version: '0.2.1-rc.5' });
});

test('pickTarget 在没有 latest 时取第一个合法 tag', () => {
  assert.deepEqual(pickTarget({ next: '0.2.1-rc.6' }, '0.2.1-rc.3'), { tag: 'next', version: '0.2.1-rc.6' });
  assert.deepEqual(pickTarget({ beta: 'bad', next: '0.2.1-rc.6' }, '0.2.1-rc.3'), {
    tag: 'next',
    version: '0.2.1-rc.6',
  });
});

test('pickTarget 对空 dist-tags 返回 null', () => {
  assert.equal(pickTarget({}, '0.2.1-rc.3'), null);
  assert.equal(pickTarget(null, '0.2.1-rc.3'), null);
});

const PACKUMENT_URL = 'https://registry.npmjs.org/@deepseek-ai%2Fdsh';

const REAL_PACKUMENT = {
  name: '@deepseek-ai/dsh',
  versions: {
    '0.2.1-rc.3': { version: '0.2.1-rc.3' },
    '0.2.1-rc.5': { version: '0.2.1-rc.5' },
    '0.2.2-alpha.2': { version: '0.2.2-alpha.2' },
  },
  time: {
    created: '2026-10-01T00:00:00.000Z',
    modified: '2026-10-29T14:15:23.355Z',
    '0.2.1-rc.3': '2026-10-23T07:54:30.267Z',
    '0.2.1-rc.5': '2026-10-29T14:15:23.355Z',
  },
};

test('fetchPublishedVersions 请求包元数据并返回版本与发布时间', async () => {
  const requests: Array<{ url: string; accept: string }> = [];
  const fetchImpl: FetchLike = async (url, options) => {
    requests.push({ url, accept: options.headers.accept });
    return { status: 200, json: async () => REAL_PACKUMENT };
  };

  const versions = await fetchPublishedVersions('https://registry.npmjs.org', fetchImpl);
  assert.deepEqual(versions, [
    { version: '0.2.1-rc.3', publishedAt: '2026-10-23T07:54:30.267Z' },
    { version: '0.2.1-rc.5', publishedAt: '2026-10-29T14:15:23.355Z' },
    { version: '0.2.2-alpha.2', publishedAt: null },
  ]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, PACKUMENT_URL);
  assert.equal(requests[0].accept, 'application/json');
});

test('fetchPublishedVersions 去掉 registry 末尾斜杠并丢弃非法版本号', async () => {
  const requests: string[] = [];
  const fetchImpl = async (url: string) => {
    requests.push(url);
    return {
      status: 200,
      json: async () => ({
        versions: { '0.2.1-rc.3': {}, latest: {}, '0.2.1-rc.5': {} },
        time: {},
      }),
    };
  };

  const versions = await fetchPublishedVersions('https://registry.npmjs.org/', fetchImpl);
  assert.equal(requests[0], PACKUMENT_URL);
  assert.deepEqual(versions, [
    { version: '0.2.1-rc.3', publishedAt: null },
    { version: '0.2.1-rc.5', publishedAt: null },
  ]);
});

test('fetchPublishedVersions 在缺少 time 时把发布时间记为 null', async () => {
  const fetchImpl = async () => ({
    status: 200,
    json: async () => ({ versions: { '0.2.1-rc.3': {} } }),
  });
  assert.deepEqual(await fetchPublishedVersions('https://registry.npmjs.org', fetchImpl), [
    { version: '0.2.1-rc.3', publishedAt: null },
  ]);
});

test('fetchPublishedVersions 对非 200 响应抛出错误', async () => {
  const fetchImpl = async () => ({ status: 500, json: async () => ({}) });
  await assert.rejects(fetchPublishedVersions('https://registry.npmjs.org', fetchImpl), /HTTP 500/);
});

test('fetchPublishedVersions 对缺少 versions 的响应抛出错误', async () => {
  const fetchImpl = async () => ({ status: 200, json: async () => ({ name: '@deepseek-ai/dsh' }) });
  await assert.rejects(fetchPublishedVersions('https://registry.npmjs.org', fetchImpl), /缺少 versions/);
});

test('fetchPublishedVersions 拒绝非对象响应与非法 registry 地址', async () => {
  for (const payload of [null, [], 'text']) {
    const fetchImpl = async () => ({ status: 200, json: async () => payload });
    await assert.rejects(fetchPublishedVersions('https://registry.npmjs.org', fetchImpl), /不是对象/);
  }
  await assert.rejects(fetchPublishedVersions('', async () => ({ status: 200, json: async () => ({}) })), TypeError);
  await assert.rejects(fetchPublishedVersions(null, async () => ({ status: 200, json: async () => ({}) })), TypeError);
});

test('selectRollbackCandidates 只保留更旧版本，按新到旧排序并去重', () => {
  const versions = [
    { version: '0.2.1-rc.2', publishedAt: '2026-10-17T08:36:31.655Z' },
    { version: '0.2.1-rc.5', publishedAt: '2026-10-29T14:15:23.355Z' },
    { version: '0.2.1-rc.3', publishedAt: '2026-10-23T07:54:30.267Z' },
    { version: '0.2.2-alpha.2', publishedAt: '2026-10-27T19:10:28.529Z' },
    { version: '0.2.0-rc.2', publishedAt: '2026-10-10T00:00:00.000Z' },
    { version: '0.2.1-rc.3', publishedAt: '2026-10-23T07:54:30.267Z' },
    { version: 'not-a-version', publishedAt: null },
  ];

  assert.deepEqual(
    selectRollbackCandidates(versions, '0.2.1-rc.5').map((entry) => entry.version),
    ['0.2.1-rc.3', '0.2.1-rc.2', '0.2.0-rc.2'],
  );
  assert.deepEqual(
    selectRollbackCandidates(versions, '0.2.1-rc.3').map((entry) => entry.version),
    ['0.2.1-rc.2', '0.2.0-rc.2'],
  );
});

test('selectRollbackCandidates 处理空输入并对非法当前版本抛错', () => {
  assert.deepEqual(selectRollbackCandidates([], '0.2.1-rc.3'), []);
  assert.deepEqual(selectRollbackCandidates(null, '0.2.1-rc.3'), []);
  assert.deepEqual(selectRollbackCandidates(undefined, '0.2.1-rc.3'), []);
  assert.throws(() => selectRollbackCandidates([], 'latest'), TypeError);
  assert.throws(() => selectRollbackCandidates([], ''), TypeError);
});
