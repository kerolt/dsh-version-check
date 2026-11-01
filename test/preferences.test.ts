import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  normalizePreferencesPatch,
  preferencesFilePath,
  readPreferencesFile,
  resolvePreferences,
  writePreferencesFile,
  type Preferences,
} from '../lib/preferences.js';

const DEFAULTS: Preferences = Object.freeze({
  checkEnabled: true,
  checkIntervalMinutes: 360,
  channel: 'auto',
});

test('normalizePreferencesPatch 接受合法字段并归一化', () => {
  assert.deepEqual(normalizePreferencesPatch({ checkEnabled: false }), { checkEnabled: false });
  assert.deepEqual(normalizePreferencesPatch({ checkIntervalMinutes: 60 }), { checkIntervalMinutes: 60 });
  assert.deepEqual(normalizePreferencesPatch({ channel: '  alpha ' }), { channel: 'alpha' });
  assert.deepEqual(normalizePreferencesPatch({ checkEnabled: true, channel: 'auto' }), {
    checkEnabled: true,
    channel: 'auto',
  });
});

test('normalizePreferencesPatch 拒绝非法输入', () => {
  assert.throws(() => normalizePreferencesPatch(null), TypeError);
  assert.throws(() => normalizePreferencesPatch([]), TypeError);
  assert.throws(() => normalizePreferencesPatch({}), TypeError);
  assert.throws(() => normalizePreferencesPatch({ unknown: 1 }), TypeError);
  assert.throws(() => normalizePreferencesPatch({ checkEnabled: 'yes' }), TypeError);
  assert.throws(() => normalizePreferencesPatch({ checkIntervalMinutes: 0 }), TypeError);
  assert.throws(() => normalizePreferencesPatch({ checkIntervalMinutes: 10081 }), TypeError);
  assert.throws(() => normalizePreferencesPatch({ checkIntervalMinutes: 1.5 }), TypeError);
  assert.throws(() => normalizePreferencesPatch({ checkIntervalMinutes: '60' }), TypeError);
  assert.throws(() => normalizePreferencesPatch({ channel: '' }), TypeError);
  assert.throws(() => normalizePreferencesPatch({ channel: '1alpha' }), TypeError);
  assert.throws(() => normalizePreferencesPatch({ channel: 'a b' }), TypeError);
});

test('resolvePreferences 让保存的设置覆盖 patch 默认值', () => {
  assert.deepEqual(resolvePreferences(DEFAULTS, {}), DEFAULTS);
  assert.deepEqual(resolvePreferences(DEFAULTS, { checkEnabled: false }), {
    ...DEFAULTS,
    checkEnabled: false,
  });
  assert.deepEqual(
    resolvePreferences(DEFAULTS, { checkIntervalMinutes: 1440, channel: 'alpha' }),
    { checkEnabled: true, checkIntervalMinutes: 1440, channel: 'alpha' },
  );
  assert.throws(() => resolvePreferences(DEFAULTS, { checkIntervalMinutes: -1 }), TypeError);
  assert.throws(() => resolvePreferences(DEFAULTS, null), TypeError);
});

test('preferencesFilePath 跟随 DSH_HOME', () => {
  const path = preferencesFilePath({ DSH_HOME: '/tmp/dsh-home-example' });
  assert.equal(path, '/tmp/dsh-home-example/dsh-version-check/preferences.json');
});

test('设置文件缺失时返回空对象', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dvc-preferences-'));
  const path = join(directory, 'missing.json');

  assert.deepEqual(readPreferencesFile(path), {});
  rmSync(directory, { recursive: true, force: true });
});

test('设置文件写入后可读回，内容带版本号且权限为 0600', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dvc-preferences-'));
  const path = join(directory, 'nested', 'preferences.json');
  writePreferencesFile(path, { checkEnabled: false, checkIntervalMinutes: 120, channel: 'alpha' });

  assert.deepEqual(readPreferencesFile(path), {
    version: 1,
    checkEnabled: false,
    checkIntervalMinutes: 120,
    channel: 'alpha',
  });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.match(readFileSync(path, 'utf8'), /\n$/);
  rmSync(directory, { recursive: true, force: true });
});

test('设置文件内容非法时就地抛出', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dvc-preferences-'));
  const path = join(directory, 'preferences.json');
  writeFileSync(path, '[]');
  assert.throws(() => readPreferencesFile(path), Error);

  writeFileSync(path, '{broken');
  assert.throws(() => readPreferencesFile(path), SyntaxError);
  rmSync(directory, { recursive: true, force: true });
});
