/**
 * npm registry 的 dist-tags 查询、已发布版本列表与回滚候选筛选。
 */

import { compareVersions, isValidVersion, parseVersion, prereleaseChannel } from './versions.js';

const DIST_TAGS_PATH = '/-/package/@deepseek-ai%2Fdsh/dist-tags';
const PACKUMENT_PATH = '/@deepseek-ai%2Fdsh';
const FETCH_TIMEOUT_MS = 15000;

/** fetch 返回值的结构，只用到状态码与 JSON 解析。 */
export interface FetchResponseLike {
  status: number;
  json(): Promise<unknown>;
}

/** 测试可注入的 fetch 实现。 */
export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<FetchResponseLike>;

/** dist-tag 到版本号的映射。 */
export type DistTags = Record<string, string>;

/** 错误消息里去掉 URL 内嵌的凭据，避免把凭据带进界面状态。 */
function displayUrl(url: string): string {
  const parsed = new URL(url);
  parsed.username = '';
  parsed.password = '';
  return parsed.href;
}

/**
 * 拉取 `@deepseek-ai/dsh` 的 dist-tags。
 * @param registryUrl registry 地址，末尾斜杠可有可无。
 * @param fetchImpl fetch 实现，测试时注入。
 * @returns 只保留版本号合法的条目。
 */
export async function fetchDistTags(registryUrl: unknown, fetchImpl: FetchLike = fetch): Promise<DistTags> {
  if (typeof registryUrl !== 'string' || registryUrl.length === 0) {
    throw new TypeError('registryUrl 必须是非空字符串');
  }

  // 拼出 dist-tags 端点
  const base = registryUrl.replace(/\/+$/, '');
  const url = `${base}${DIST_TAGS_PATH}`;
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (response.status !== 200) {
    throw new Error(`registry 返回 HTTP ${response.status}: ${displayUrl(url)}`);
  }

  // 只保留版本号合法的条目
  const payload = await response.json();
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`registry 的 dist-tags 响应不是对象: ${displayUrl(url)}`);
  }
  const distTags: DistTags = {};
  for (const [tag, version] of Object.entries(payload)) {
    if (typeof version === 'string' && isValidVersion(version)) {
      distTags[tag] = version;
    }
  }

  return distTags;
}

/**
 * 选择要跟踪的 dist-tag。
 * 优先使用显式 channel；auto 时按当前版本的 prerelease 渠道选 tag，
 * 渠道不存在则 latest，仍不存在则取第一个合法 tag。
 * @param distTags dist-tags 表。
 * @param currentVersion 当前安装的版本。
 * @param channelOverride 显式渠道，默认为 auto。
 * @returns 没有合法 tag 时返回 null。
 */
export function pickTarget(
  distTags: DistTags | null | undefined,
  currentVersion: string,
  channelOverride: string = 'auto',
): { tag: string; version: string } | null {
  // 过滤出版本号合法的条目
  const entries = Object.entries(distTags === null || distTags === undefined ? {} : distTags).filter(
    ([, version]) => typeof version === 'string' && isValidVersion(version),
  );
  if (entries.length === 0) {
    return null;
  }
  const lookup = new Map<string, string>(entries);

  // 显式渠道优先
  const override = typeof channelOverride === 'string' ? channelOverride : 'auto';
  if (override !== 'auto' && lookup.has(override)) {
    return { tag: override, version: lookup.get(override)! };
  }

  // auto 渠道按当前版本的前置标识选择，再退回 latest
  const channel = prereleaseChannel(currentVersion);
  if (channel !== null && lookup.has(channel)) {
    return { tag: channel, version: lookup.get(channel)! };
  }
  if (lookup.has('latest')) {
    return { tag: 'latest', version: lookup.get('latest')! };
  }

  const [tag, version] = entries[0];
  return { tag, version };
}

/** registry 里的一个已发布版本。 */
export interface PublishedVersion {
  version: string;
  publishedAt: string | null;
}

/**
 * 拉取 `@deepseek-ai/dsh` 的包元数据，取出全部已发布版本与发布时间。
 * @param registryUrl registry 地址，末尾斜杠可有可无。
 * @param fetchImpl fetch 实现，测试时注入。
 * @returns 只保留版本号合法的条目，顺序与 registry 返回一致。
 */
export async function fetchPublishedVersions(
  registryUrl: unknown,
  fetchImpl: FetchLike = fetch,
): Promise<PublishedVersion[]> {
  if (typeof registryUrl !== 'string' || registryUrl.length === 0) {
    throw new TypeError('registryUrl 必须是非空字符串');
  }

  // 包元数据端点包含全部版本与发布时间
  const base = registryUrl.replace(/\/+$/, '');
  const url = `${base}${PACKUMENT_PATH}`;
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (response.status !== 200) {
    throw new Error(`registry 返回 HTTP ${response.status}: ${displayUrl(url)}`);
  }

  const payload = await response.json();
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`registry 的版本列表响应不是对象: ${displayUrl(url)}`);
  }
  const record = payload as Record<string, unknown>;
  const versions = record.versions;
  if (versions === null || typeof versions !== 'object' || Array.isArray(versions)) {
    throw new Error(`registry 的版本列表响应缺少 versions 字段: ${displayUrl(url)}`);
  }
  const time = record.time;
  const times =
    time !== null && typeof time === 'object' && !Array.isArray(time) ? (time as Record<string, unknown>) : {};

  // 只保留版本号合法的条目，发布时间缺失记为 null
  const published: PublishedVersion[] = [];
  for (const version of Object.keys(versions)) {
    if (!isValidVersion(version)) {
      continue;
    }
    const publishedAt = times[version];
    published.push({
      version,
      publishedAt: typeof publishedAt === 'string' ? publishedAt : null,
    });
  }

  return published;
}

/**
 * 从已发布版本中筛出比当前安装版本更旧的版本，按版本号从新到旧排序。
 * @param versions 已发布版本列表。
 * @param installedVersion 当前安装的版本。
 */
export function selectRollbackCandidates(
  versions: PublishedVersion[] | null | undefined,
  installedVersion: string,
): PublishedVersion[] {
  if (parseVersion(installedVersion) === null) {
    throw new TypeError(`installedVersion 不是合法的版本号: ${String(installedVersion)}`);
  }

  const seen = new Set<string>();
  const candidates: PublishedVersion[] = [];
  for (const entry of Array.isArray(versions) ? versions : []) {
    if (entry === null || typeof entry !== 'object') {
      continue;
    }
    const version = entry.version;
    if (typeof version !== 'string' || !isValidVersion(version) || seen.has(version)) {
      continue;
    }
    if (compareVersions(version, installedVersion) >= 0) {
      continue;
    }
    seen.add(version);
    candidates.push({
      version,
      publishedAt: typeof entry.publishedAt === 'string' ? entry.publishedAt : null,
    });
  }
  candidates.sort((left, right) => compareVersions(right.version, left.version));

  return candidates;
}
