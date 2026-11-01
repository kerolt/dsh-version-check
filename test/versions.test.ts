import test from 'node:test';
import assert from 'node:assert/strict';

import { compareVersions, isValidVersion, parseVersion, prereleaseChannel } from '../lib/versions.js';

test('parseVersion 解析正式版、v 前缀与 build metadata', () => {
  assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: [] });
  assert.deepEqual(parseVersion('v1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: [] });
  assert.deepEqual(parseVersion('0.0.1'), { major: 0, minor: 0, patch: 1, prerelease: [] });
  assert.deepEqual(parseVersion('1.2.3+build.5'), { major: 1, minor: 2, patch: 3, prerelease: [] });
});

test('parseVersion 解析 prerelease 标识符', () => {
  assert.deepEqual(parseVersion('1.2.3-rc.4'), { major: 1, minor: 2, patch: 3, prerelease: ['rc', '4'] });
  assert.deepEqual(parseVersion('1.2.3-rc'), { major: 1, minor: 2, patch: 3, prerelease: ['rc'] });
  assert.deepEqual(parseVersion('0.2.2-alpha.2'), { major: 0, minor: 2, patch: 2, prerelease: ['alpha', '2'] });
  assert.deepEqual(parseVersion('1.2.3-rc.4+exp.sha.5114f85'), {
    major: 1,
    minor: 2,
    patch: 3,
    prerelease: ['rc', '4'],
  });
});

test('parseVersion 对非法输入返回 null', () => {
  for (const value of [
    '',
    '1.2',
    '1.2.3.4',
    'abc',
    '1.2.x',
    '1.2.3-',
    '1.2.3+',
    '01.2.3',
    '1.2.3-rc.01',
    'v',
    null,
    undefined,
    123,
    {},
  ]) {
    assert.equal(parseVersion(value), null, `应拒绝 ${String(value)}`);
  }
});

test('compareVersions 比较核心版本号', () => {
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('2.0.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.9.9', '2.0.0'), -1);
  assert.equal(compareVersions('1.3.0', '1.2.9'), 1);
  assert.equal(compareVersions('1.2.4', '1.2.3'), 1);
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('1.2.3+build.1', '1.2.3+build.2'), 0);
});

test('compareVersions 按 semver 优先级比较 prerelease', () => {
  assert.equal(compareVersions('1.2.3-rc.4', '1.2.3'), -1);
  assert.equal(compareVersions('1.2.3', '1.2.3-rc.4'), 1);
  assert.equal(compareVersions('1.2.3-rc.2', '1.2.3-rc.10'), -1);
  assert.equal(compareVersions('1.2.3-1', '1.2.3-alpha'), -1);
  assert.equal(compareVersions('1.2.3-alpha', '1.2.3-beta'), -1);
  assert.equal(compareVersions('1.2.3-beta', '1.2.3-rc'), -1);
  assert.equal(compareVersions('1.2.3-rc', '1.2.3-rc.1'), -1);
  assert.equal(compareVersions('1.2.3-rc.1.1', '1.2.3-rc.1'), 1);
  assert.equal(compareVersions('1.2.3-rc.1', '1.2.3-rc.1'), 0);
  assert.equal(compareVersions('0.2.1-rc.3', '0.2.1-rc.5'), -1);
  assert.equal(compareVersions('0.2.2-alpha.1', '0.2.1-rc.5'), 1);
});

test('compareVersions 结果对称', () => {
  const pairs: Array<[string, string]> = [
    ['1.2.3', '1.2.3-rc.1'],
    ['1.2.3-rc.2', '1.2.3-rc.10'],
    ['1.2.3-alpha', '1.2.3-1'],
    ['2.0.0', '1.99.99'],
  ];

  for (const [left, right] of pairs) {
    assert.equal(compareVersions(left, right), -compareVersions(right, left));
  }
});

test('compareVersions 对非法版本抛出 TypeError', () => {
  assert.throws(() => compareVersions('nope', '1.2.3'), TypeError);
  assert.throws(() => compareVersions('1.2.3', 'latest'), TypeError);
});

test('prereleaseChannel 取第一个 prerelease 标识符', () => {
  assert.equal(prereleaseChannel('0.2.1-rc.3'), 'rc');
  assert.equal(prereleaseChannel('0.2.2-alpha.2'), 'alpha');
  assert.equal(prereleaseChannel('1.2.3-rc'), 'rc');
  assert.equal(prereleaseChannel('1.2.3'), null);
  assert.equal(prereleaseChannel('not-a-version'), null);
});

test('isValidVersion 判定版本号合法性', () => {
  assert.equal(isValidVersion('1.2.3'), true);
  assert.equal(isValidVersion('v0.0.1'), true);
  assert.equal(isValidVersion('0.2.1-rc.5'), true);
  assert.equal(isValidVersion('1.2.3+build'), true);
  assert.equal(isValidVersion(''), false);
  assert.equal(isValidVersion('1.2'), false);
  assert.equal(isValidVersion('latest'), false);
  assert.equal(isValidVersion(null), false);
  assert.equal(isValidVersion('1.2.3-rc.01'), false);
});
