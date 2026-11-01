/**
 * 用户设置：更新检查开关、自动检查间隔与发布渠道的校验、合并与持久化。
 * 设置保存在 $DSH_HOME/dsh-version-check/preferences.json；
 * profile patch 里的同名字段作为默认值，用户设置覆盖它们。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const PREFERENCES_VERSION = 1;
const INTERVAL_MINUTES_MIN = 1;
const INTERVAL_MINUTES_MAX = 10080;
const CHANNEL_PATTERN = /^[A-Za-z][A-Za-z0-9._-]*$/;
const PREFERENCES_DIRECTORY = 'dsh-version-check';
const PREFERENCES_FILENAME = 'preferences.json';

/** 生效的设置。 */
export interface Preferences {
  checkEnabled: boolean;
  checkIntervalMinutes: number;
  channel: string;
}

/** 只包含用户提交字段的设置补丁。 */
export type PreferencesPatch = Partial<Preferences>;

/** 设置字段名。 */
type SettingField = keyof Preferences;

const SETTING_FIELDS: SettingField[] = ['checkEnabled', 'checkIntervalMinutes', 'channel'];

/**
 * 设置文件的绝对路径。
 * @param env 环境变量，默认使用 process.env。
 */
export function preferencesFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const home = typeof env.DSH_HOME === 'string' && env.DSH_HOME.length > 0 ? env.DSH_HOME : join(homedir(), '.dsh');

  return join(home, PREFERENCES_DIRECTORY, PREFERENCES_FILENAME);
}

/**
 * 校验单个字段并返回归一化后的值。
 * @param field 字段名。
 * @param value 字段值。
 */
function normalizeField(field: 'checkEnabled', value: unknown): boolean;
function normalizeField(field: 'checkIntervalMinutes', value: unknown): number;
function normalizeField(field: 'channel', value: unknown): string;
function normalizeField(field: SettingField, value: unknown): boolean | number | string;
function normalizeField(field: SettingField, value: unknown): boolean | number | string {
  if (field === 'checkEnabled') {
    if (typeof value !== 'boolean') {
      throw new TypeError('checkEnabled 必须是布尔值');
    }

    return value;
  }

  if (field === 'checkIntervalMinutes') {
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < INTERVAL_MINUTES_MIN ||
      value > INTERVAL_MINUTES_MAX
    ) {
      throw new TypeError(`checkIntervalMinutes 必须是 ${INTERVAL_MINUTES_MIN} 到 ${INTERVAL_MINUTES_MAX} 之间的整数`);
    }

    return value;
  }

  if (field === 'channel') {
    if (typeof value !== 'string') {
      throw new TypeError('channel 必须是字符串');
    }

    const text = value.trim();
    if (text !== 'auto' && !CHANNEL_PATTERN.test(text)) {
      throw new TypeError('channel 必须是 auto 或一个 npm dist-tag 名称');
    }

    return text;
  }

  throw new TypeError(`未知的设置字段: ${field}`);
}

/**
 * 校验并归一化设置补丁，只保留提供的字段。
 * @param raw 请求体。
 */
export function normalizePreferencesPatch(raw: unknown): PreferencesPatch {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('设置必须是 JSON 对象');
  }

  const patch: PreferencesPatch = {};
  for (const [field, value] of Object.entries(raw)) {
    if (!isSettingField(field)) {
      throw new TypeError(`未知的设置字段: ${field}`);
    }

    switch (field) {
      case 'checkEnabled':
        patch.checkEnabled = normalizeField('checkEnabled', value);
        break;
      case 'checkIntervalMinutes':
        patch.checkIntervalMinutes = normalizeField('checkIntervalMinutes', value);
        break;
      case 'channel':
        patch.channel = normalizeField('channel', value);
        break;
    }
  }
  if (Object.keys(patch).length === 0) {
    throw new TypeError('设置补丁不能为空');
  }

  return patch;
}

/**
 * 合并默认设置与用户设置，返回实际生效的设置。
 * @param defaults patch 层默认值。
 * @param stored 已保存的用户设置。
 */
export function resolvePreferences(defaults: Preferences, stored: unknown): Preferences {
  // 先校验默认值
  const resolved: Preferences = {
    checkEnabled: normalizeField('checkEnabled', defaults.checkEnabled),
    checkIntervalMinutes: normalizeField('checkIntervalMinutes', defaults.checkIntervalMinutes),
    channel: normalizeField('channel', defaults.channel),
  };
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) {
    throw new TypeError('已保存的设置必须是对象');
  }
  const storedFields = stored as Record<string, unknown>;

  // 用户设置逐字段覆盖默认值
  for (const field of SETTING_FIELDS) {
    if (!Object.hasOwn(stored, field)) {
      continue;
    }

    switch (field) {
      case 'checkEnabled':
        resolved.checkEnabled = normalizeField('checkEnabled', storedFields[field]);
        break;
      case 'checkIntervalMinutes':
        resolved.checkIntervalMinutes = normalizeField('checkIntervalMinutes', storedFields[field]);
        break;
      case 'channel':
        resolved.channel = normalizeField('channel', storedFields[field]);
        break;
    }
  }

  return resolved;
}

/**
 * 读取设置文件；文件不存在时返回空对象。
 * 文件内容无法解析时抛错，由调用方按显式错误处理。
 * @param path 设置文件路径。
 */
export function readPreferencesFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) {
    return {};
  }

  const text = readFileSync(path, 'utf8');
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`设置文件不是对象: ${path}`);
  }

  return parsed as Record<string, unknown>;
}

/**
 * 原子写入设置文件：先写临时文件再改名，权限为 0600。
 * @param path 设置文件路径。
 * @param preferences 生效设置。
 */
export function writePreferencesFile(path: string, preferences: Preferences): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });

  const temporary = `${path}.${process.pid}.tmp`;
  const payload = JSON.stringify({ version: PREFERENCES_VERSION, ...preferences }, null, 2) + '\n';
  try {
    writeFileSync(temporary, payload, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }

  chmodSync(path, 0o600);
}

/** 判断字符串是否是设置字段名。 */
function isSettingField(field: string): field is SettingField {
  return (SETTING_FIELDS as string[]).includes(field);
}
