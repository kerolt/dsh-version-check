/**
 * dsh-version-check Host 半。
 * 注册七个 loopback 路由：读取状态、检查更新、执行更新、列出可回滚版本、执行回滚、
 * 重启服务、保存设置；并把 styles/client.css 注入页面 head，供浏览器半使用。
 */

import { readFileSync } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-host-webserver';

import { detectDeployment, findNpmExecutable, readInstalledVersion, type DeploymentInfo } from './deployment.js';
import { gateRequest } from './gate.js';
import { runNpmInstall, scheduleServiceRestart, type InstallResult } from './install.js';
import {
  normalizePreferencesPatch,
  preferencesFilePath,
  readPreferencesFile,
  resolvePreferences,
  writePreferencesFile,
  type Preferences,
} from './preferences.js';
import {
  fetchDistTags,
  fetchPublishedVersions,
  pickTarget,
  selectRollbackCandidates,
  type DistTags,
  type PublishedVersion,
} from './registry.js';
import { compareVersions, isValidVersion } from './versions.js';

const STATE_PATH = '/__dsh-version-check/state';
const CHECK_PATH = '/__dsh-version-check/check';
const UPDATE_PATH = '/__dsh-version-check/update';
const VERSIONS_PATH = '/__dsh-version-check/versions';
const ROLLBACK_PATH = '/__dsh-version-check/rollback';
const RESTART_PATH = '/__dsh-version-check/restart';
const PREFERENCES_PATH = '/__dsh-version-check/preferences';
const STYLESHEET_PATH = new URL('./styles/client.css', import.meta.url);

const INITIAL_CHECK_DELAY_MS = 5000;
const RESTART_DELAY_AFTER_UPDATE_MS = 1200;
const RESTART_DELAY_MANUAL_MS = 300;
const RESTART_WATCHDOG_MS = 60 * 1000;
const INSTALL_OUTPUT_LIMIT = 400;
const INSTALL_ERROR_LIMIT = 300;
const BODY_LIMIT = 16 * 1024;
const VERSIONS_CACHE_MS = 5 * 60 * 1000;

/** patch 层解析后的配置。 */
interface ResolvedConfig {
  registry: string;
  checkEnabled: boolean;
  checkIntervalMinutes: number;
  channel: string;
  allowedOrigins: string[];
  restartTimeoutSeconds: number;
}

/** 路由返回的错误对象。 */
interface StatusError {
  code: string;
  message: string;
}

/** 已知的最新版本。 */
interface LatestInfo {
  version: string;
  tag: string;
}

/** 插件对外暴露的阶段。 */
type Phase = 'idle' | 'checking' | 'installing' | 'restarting' | 'restart-required' | 'error';

/** 运行时状态。 */
interface PluginState {
  bootVersion: string;
  installedVersion: string;
  latest: LatestInfo | null;
  channel: string;
  phase: Phase;
  lastCheckedAt: number | null;
  lastError: StatusError | null;
  installOutput: string | null;
  target: string | null;
}

/** 路由返回的状态快照。 */
interface Snapshot {
  ok: true;
  bootVersion: string;
  installedVersion: string;
  latest: LatestInfo | null;
  channel: string;
  updateAvailable: boolean;
  phase: Phase;
  restartMode: DeploymentInfo['restartMode'];
  restartUnit: string | null;
  lastCheckedAt: number | null;
  lastError: StatusError | null;
  installOutput: string | null;
  target: string | null;
  settings: Preferences;
}

/** HTTP 路由处理器。 */
type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

const DEFAULTS: ResolvedConfig = Object.freeze({
  registry: 'https://registry.npmjs.org',
  checkEnabled: true,
  checkIntervalMinutes: 360,
  channel: 'auto',
  allowedOrigins: [],
  restartTimeoutSeconds: 900,
});

let cachedDeployment: DeploymentInfo | null = null;

/**
 * 首次 apply 时执行部署探测，结果在进程内复用。
 */
function getDeployment(): DeploymentInfo {
  if (cachedDeployment === null) {
    cachedDeployment = detectDeployment();
  }
  return cachedDeployment;
}

/**
 * 生成可读的错误原因，附带 Node fetch 错误中常见的底层错误码。
 */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause: unknown = error.cause;
    if (
      cause !== null &&
      cause !== undefined &&
      typeof cause === 'object' &&
      'code' in cause &&
      typeof cause.code === 'string'
    ) {
      return `${error.message} (${cause.code})`;
    }

    return error.message;
  }

  return String(error);
}

/**
 * 校验正整数配置。
 */
function positiveInteger(value: unknown, name: string, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} 必须是正整数`);
  }

  return value;
}

/**
 * 校验 registry 配置：必须是 http/https URL，去掉末尾斜杠。
 */
function resolveRegistry(value: unknown): string {
  const text = value === undefined ? DEFAULTS.registry : value;
  if (typeof text !== 'string') {
    throw new TypeError('registry 必须是字符串');
  }
  if (!text.startsWith('http://') && !text.startsWith('https://')) {
    throw new Error(`registry 必须以 http:// 或 https:// 开头: ${text}`);
  }

  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(`registry 不是合法的 URL: ${text}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`registry 只支持 http/https: ${text}`);
  }

  return text.replace(/\/+$/, '');
}

/**
 * 校验 channel 配置。
 */
function resolveChannel(value: unknown): string {
  const text = value === undefined ? DEFAULTS.channel : value;
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new TypeError('channel 必须是非空字符串');
  }

  return text.trim();
}

/**
 * 校验 allowedOrigins 配置：每一项都是不带路径的 http/https 源地址。
 */
function resolveAllowedOrigins(value: unknown): string[] {
  const list = value === undefined ? DEFAULTS.allowedOrigins : value;
  if (!Array.isArray(list)) {
    throw new TypeError('allowedOrigins 必须是字符串数组');
  }

  const origins: string[] = [];
  for (const entry of list) {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new TypeError('allowedOrigins 的每一项必须是非空字符串');
    }

    let parsed: URL;
    try {
      parsed = new URL(entry);
    } catch {
      throw new Error(`allowedOrigins 不是合法的 URL: ${entry}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`allowedOrigins 只支持 http/https: ${entry}`);
    }
    if (parsed.pathname !== '/' || parsed.search.length > 0 || parsed.hash.length > 0) {
      throw new Error(`allowedOrigins 只接受源地址，不含路径: ${entry}`);
    }

    origins.push(entry.replace(/\/+$/, ''));
  }

  return origins;
}

/**
 * 校验布尔配置。
 */
function booleanOption(value: unknown, name: string, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'boolean') {
    throw new TypeError(`${name} 必须是布尔值`);
  }

  return value;
}

/**
 * 校验 patch 层传入的配置。
 */
function resolveConfig(input: unknown): ResolvedConfig {
  const raw = input === undefined || input === null ? {} : input;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('dsh-version-check 的 config 必须是对象');
  }
  const record = raw as Record<string, unknown>;

  return {
    registry: resolveRegistry(record.registry),
    checkEnabled: booleanOption(record.checkEnabled, 'checkEnabled', DEFAULTS.checkEnabled),
    checkIntervalMinutes: positiveInteger(
      record.checkIntervalMinutes,
      'checkIntervalMinutes',
      DEFAULTS.checkIntervalMinutes,
    ),
    channel: resolveChannel(record.channel),
    allowedOrigins: resolveAllowedOrigins(record.allowedOrigins),
    restartTimeoutSeconds: positiveInteger(
      record.restartTimeoutSeconds,
      'restartTimeoutSeconds',
      DEFAULTS.restartTimeoutSeconds,
    ),
  };
}

/**
 * 写 JSON 响应。
 */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * 写错误 JSON 响应。
 */
function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { ok: false, error: { code, message } });
}

/**
 * 判断请求的 Content-Type 是否为 application/json。
 */
function isJsonContentType(req: IncomingMessage): boolean {
  const value = req.headers['content-type'];
  if (typeof value !== 'string') {
    return false;
  }

  return value.split(';')[0].trim().toLowerCase() === 'application/json';
}

/**
 * POST 路由的来源校验：来源通过 gateRequest，且必须携带 Origin 头。
 * @returns 拒绝原因，通过时返回 null。
 */
function postRefusal(req: IncomingMessage, allowedOrigins: string[]): string | null {
  const refusal = gateRequest(req, allowedOrigins);
  if (refusal !== null) {
    return `请求来源校验失败: ${refusal}`;
  }

  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin.length === 0) {
    return 'POST 请求必须携带 Origin 头';
  }

  return null;
}

/**
 * 读取并解析 JSON 请求体。
 * @param limit 最大字节数。
 * @returns 解析失败或超限时返回 null。
 */
function readJsonBody(req: IncomingMessage, limit: number): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;
    let settled = false;

    const settle = (value: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        overflow = true;
        chunks.length = 0;
        return;
      }

      chunks.push(chunk);
    });

    req.on('end', () => {
      if (overflow) {
        settle(null);
        return;
      }

      try {
        settle(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        settle(null);
      }
    });

    req.on('error', () => settle(null));
    req.on('close', () => settle(null));
  });
}

/**
 * 拼装安装失败的可读摘要。
 */
function installFailureMessage(result: InstallResult, timeoutSeconds: number): string {
  const tail = result.outputTail.trim();
  if (tail.length > 0) {
    return tail.slice(-INSTALL_ERROR_LIMIT);
  }
  if (result.timedOut === true) {
    return `npm 安装超时（${timeoutSeconds} 秒）`;
  }
  if (result.error !== undefined) {
    return `npm 安装进程启动失败: ${describeError(result.error)}`;
  }

  const code = result.code === null ? '未知' : String(result.code);
  return `npm 安装失败（退出码 ${code}）`;
}

/**
 * Host 入口。
 * @param ctx cordis 上下文。
 * @param config patch 层配置。
 */
export function apply(ctx: Context, config: unknown): void {
  // patch 层默认值、部署探测与浏览器半样式表
  const patchDefaults = resolveConfig(config);
  const deployment = getDeployment();
  const preferencesPath = preferencesFilePath();
  const restartTimers = new Set<NodeJS.Timeout>();
  const stylesheet = readFileSync(STYLESHEET_PATH, 'utf8');

  // 读取已保存的设置；文件损坏时保留错误并在界面上提示
  const defaultPreferences: Preferences = {
    checkEnabled: patchDefaults.checkEnabled,
    checkIntervalMinutes: patchDefaults.checkIntervalMinutes,
    channel: patchDefaults.channel,
  };
  let preferences: Preferences;
  let preferencesError: StatusError | null = null;
  try {
    preferences = resolvePreferences(defaultPreferences, readPreferencesFile(preferencesPath));
  } catch (error) {
    preferencesError = {
      code: 'E_PREFERENCES',
      message: `读取已保存的设置失败，暂时使用 patch 默认值: ${describeError(error)}`,
    };
    preferences = resolvePreferences(defaultPreferences, {});
  }

  // 运行时状态
  const state: PluginState = {
    bootVersion: deployment.version,
    installedVersion: deployment.version,
    latest: null,
    channel: preferences.channel === 'auto' ? 'latest' : preferences.channel,
    phase: 'idle',
    lastCheckedAt: null,
    lastError: preferencesError,
    installOutput: null,
    target: null,
  };
  let inflightCheck: Promise<Snapshot> | null = null;
  let activeInstall: ChildProcess | null = null;
  let autoCheckTimer: NodeJS.Timeout | null = null;
  let autoCheckInterval: NodeJS.Timeout | null = null;
  let publishedCache: { fetchedAt: number; versions: PublishedVersion[] } | null = null;

  const isBusy = (): boolean => state.phase === 'installing' || state.phase === 'restarting';

  /**
   * 对外暴露的 phase：磁盘版本与启动版本不同时覆盖为 restart-required。
   */
  const effectivePhase = (): Phase => {
    if (isBusy()) {
      return state.phase;
    }
    if (state.bootVersion !== state.installedVersion) {
      return 'restart-required';
    }

    return state.phase;
  };

  /** @returns 路由返回的状态快照。 */
  const snapshot = (): Snapshot => {
    const latest = state.latest;

    return {
      ok: true,
      bootVersion: state.bootVersion,
      installedVersion: state.installedVersion,
      latest: latest === null ? null : { version: latest.version, tag: latest.tag },
      channel: state.channel,
      updateAvailable: latest !== null && compareVersions(state.installedVersion, latest.version) < 0,
      phase: effectivePhase(),
      restartMode: deployment.restartMode,
      restartUnit: deployment.unitName,
      lastCheckedAt: state.lastCheckedAt,
      lastError: state.lastError,
      installOutput: state.installOutput,
      target: state.target,
      settings: {
        checkEnabled: preferences.checkEnabled,
        checkIntervalMinutes: preferences.checkIntervalMinutes,
        channel: preferences.channel,
      },
    };
  };

  /** 重新读取磁盘上的 DSH 版本。 */
  const refreshInstalledVersion = (): void => {
    state.installedVersion = readInstalledVersion(deployment.packageRoot);
  };

  /**
   * 查询 registry 并更新 latest；手动检查与定时检查共用。
   * registry 失败转换为 E_REGISTRY 状态，其他错误就地抛出。
   */
  const performCheck = async (): Promise<Snapshot> => {
    if (isBusy()) {
      return snapshot();
    }
    state.phase = 'checking';

    // 查询 dist-tags；失败时记录 E_REGISTRY
    let distTags: DistTags;
    try {
      distTags = await fetchDistTags(patchDefaults.registry);
    } catch (error) {
      state.lastCheckedAt = Date.now();
      if (state.phase !== 'checking') {
        return snapshot();
      }
      state.phase = 'idle';
      state.lastError = { code: 'E_REGISTRY', message: describeError(error) };
      return snapshot();
    }
    state.lastCheckedAt = Date.now();
    if (state.phase !== 'checking') {
      return snapshot();
    }

    // 按当前渠道选择目标版本
    const picked = pickTarget(distTags, state.installedVersion, preferences.channel);
    if (picked === null) {
      state.latest = null;
      state.phase = 'idle';
      state.lastError = { code: 'E_REGISTRY', message: 'registry 没有返回可用的 dist-tag' };
      return snapshot();
    }
    state.latest = { version: picked.version, tag: picked.tag };
    state.channel = picked.tag;
    state.phase = 'idle';
    // 设置文件读取失败的错误不会被一次成功的检查覆盖，保存设置时才清除
    state.lastError = preferencesError;

    return snapshot();
  };

  /**
   * 查询 registry；已有查询在飞行中时复用同一个 Promise。
   */
  const checkForUpdate = (): Promise<Snapshot> => {
    if (inflightCheck !== null) {
      return inflightCheck;
    }
    inflightCheck = performCheck().finally(() => {
      inflightCheck = null;
    });

    return inflightCheck;
  };

  /**
   * 读取 registry 的已发布版本列表，结果在进程内缓存 VERSIONS_CACHE_MS。
   */
  const loadPublishedVersions = async (): Promise<PublishedVersion[]> => {
    if (publishedCache !== null && Date.now() - publishedCache.fetchedAt < VERSIONS_CACHE_MS) {
      return publishedCache.versions;
    }
    const versions = await fetchPublishedVersions(patchDefaults.registry);
    publishedCache = { fetchedAt: Date.now(), versions };

    return versions;
  };

  /** 停止自动检查定时器。 */
  const clearAutoCheck = (): void => {
    if (autoCheckTimer !== null) {
      clearTimeout(autoCheckTimer);
      autoCheckTimer = null;
    }
    if (autoCheckInterval !== null) {
      clearInterval(autoCheckInterval);
      autoCheckInterval = null;
    }
  };

  /**
   * 按当前设置重新安排自动检查：启用时先给一次延迟检查，再按间隔轮询。
   * @param immediate 是否立即触发一次检查。
   */
  const armAutoCheck = (immediate: boolean): void => {
    clearAutoCheck();
    if (!preferences.checkEnabled) {
      return;
    }

    if (immediate) {
      void checkForUpdate();
    } else {
      autoCheckTimer = setTimeout(() => {
        autoCheckTimer = null;
        void checkForUpdate();
      }, INITIAL_CHECK_DELAY_MS);
    }
    autoCheckInterval = setInterval(() => {
      void checkForUpdate();
    }, preferences.checkIntervalMinutes * 60 * 1000);
  };

  /**
   * 延时执行 systemd 重启，定时器纳入统一清理。
   * 重启成功后本进程会被 systemd 终止；如果进程仍然存活到看门狗超时，
   * 说明重启没有生效，把状态改为可读的错误。
   */
  const scheduleRestartAfter = (delayMs: number): void => {
    const timer = setTimeout(() => {
      restartTimers.delete(timer);
      const fail = (error: Error): void => {
        state.phase = 'error';
        state.lastError = { code: 'E_RESTART', message: `服务重启失败: ${describeError(error)}` };
      };
      scheduleServiceRestart(deployment.unitName as string, fail);

      // 看门狗：进程仍在运行说明重启没有生效
      const watchdog = setTimeout(() => {
        restartTimers.delete(watchdog);
        if (state.phase === 'restarting') {
          state.phase = 'error';
          state.lastError = { code: 'E_RESTART', message: '自动重启未生效，请手动重启 dsh 服务' };
        }
      }, RESTART_WATCHDOG_MS);
      restartTimers.add(watchdog);
    }, delayMs);
    restartTimers.add(timer);
  };

  /**
   * npm 安装结束后的状态流转：校验版本，再决定重启方式。
   * @param target 目标版本。
   */
  const finishInstall = (target: string, result: InstallResult): void => {
    state.installOutput = result.outputTail.length > 0 ? result.outputTail.slice(-INSTALL_OUTPUT_LIMIT) : null;

    // 安装进程失败
    if (result.error !== undefined || result.timedOut === true || result.code !== 0) {
      state.phase = 'error';
      state.lastError = { code: 'E_NPM', message: installFailureMessage(result, patchDefaults.restartTimeoutSeconds) };
      state.target = null;
      return;
    }

    // 回读磁盘版本，确认安装结果
    let installedVersion: string;
    try {
      installedVersion = readInstalledVersion(deployment.packageRoot);
    } catch (error) {
      state.phase = 'error';
      state.lastError = { code: 'E_VERIFY', message: `安装后无法读取 DSH 版本: ${describeError(error)}` };
      state.target = null;
      return;
    }
    if (installedVersion !== target) {
      state.phase = 'error';
      state.lastError = {
        code: 'E_VERIFY',
        message: `安装后版本校验失败: 磁盘版本为 ${installedVersion}，期望 ${target}`,
      };
      state.target = null;
      return;
    }
    state.installedVersion = installedVersion;
    state.target = null;

    // 能自动重启时进入 restarting，否则等待用户手动重启
    if (deployment.restartMode === 'systemd' && deployment.unitName !== null) {
      state.phase = 'restarting';
      scheduleRestartAfter(RESTART_DELAY_AFTER_UPDATE_MS);
      return;
    }
    state.phase = 'restart-required';
  };

  /**
   * 启动 npm 全局安装。
   */
  const startInstall = (version: string): void => {
    const npmExecutable = findNpmExecutable();
    if (npmExecutable === null) {
      state.phase = 'error';
      state.lastError = { code: 'E_NPM', message: '在 PATH 中找不到 npm 可执行文件' };
      state.target = null;
      return;
    }
    if (deployment.npmPrefix === null) {
      state.phase = 'error';
      state.lastError = { code: 'E_NPM', message: '无法从 DSH 安装目录推断 npm 全局前缀' };
      state.target = null;
      return;
    }

    activeInstall = runNpmInstall({
      npmExecutable,
      npmPrefix: deployment.npmPrefix,
      version,
      timeoutMs: patchDefaults.restartTimeoutSeconds * 1000,
      onExit: (result) => {
        activeInstall = null;
        finishInstall(version, result);
      },
    });
  };

  /**
   * 磁盘上的版本号必须是可解析的 semver，否则 state 计算无法进行。
   * @returns 合法时返回 true；不合法时已写 500 响应并返回 false。
   */
  const ensureInstalledVersionParsable = (res: ServerResponse): boolean => {
    if (isValidVersion(state.installedVersion)) {
      return true;
    }
    sendError(res, 500, 'E_STATE', `磁盘上的 DSH 版本号无法解析: ${state.installedVersion}`);

    return false;
  };

  /** GET /__dsh-version-check/state */
  const handleStateRoute: RouteHandler = (req, res) => {
    // 只接受 GET
    if (req.method !== 'GET') {
      sendError(res, 405, 'E_METHOD', '该路由只接受 GET');
      return;
    }

    // 来源校验
    const refusal = gateRequest(req, patchDefaults.allowedOrigins);
    if (refusal !== null) {
      sendError(res, 403, 'E_FORBIDDEN', `请求来源校验失败: ${refusal}`);
      return;
    }

    // 读取磁盘版本
    try {
      refreshInstalledVersion();
    } catch (error) {
      sendError(res, 500, 'E_STATE', `无法读取 DSH 安装版本: ${describeError(error)}`);
      return;
    }
    if (!ensureInstalledVersionParsable(res)) {
      return;
    }

    sendJson(res, 200, snapshot());
  };

  /** POST /__dsh-version-check/check */
  const handleCheckRoute: RouteHandler = async (req, res) => {
    // 只接受 POST
    if (req.method !== 'POST') {
      sendError(res, 405, 'E_METHOD', '该路由只接受 POST');
      return;
    }

    // 来源与 Content-Type 校验
    const refusal = postRefusal(req, patchDefaults.allowedOrigins);
    if (refusal !== null) {
      sendError(res, 403, 'E_FORBIDDEN', refusal);
      return;
    }
    if (!isJsonContentType(req)) {
      sendError(res, 415, 'E_CONTENT_TYPE', 'Content-Type 必须是 application/json');
      return;
    }
    req.resume();

    // 读取磁盘版本
    try {
      refreshInstalledVersion();
    } catch (error) {
      sendError(res, 500, 'E_STATE', `无法读取 DSH 安装版本: ${describeError(error)}`);
      return;
    }
    if (!ensureInstalledVersionParsable(res)) {
      return;
    }

    // 手动检查不受自动检查开关限制
    if (!isBusy()) {
      await checkForUpdate();
    }

    sendJson(res, 200, snapshot());
  };

  /** POST /__dsh-version-check/update */
  const handleUpdateRoute: RouteHandler = async (req, res) => {
    // 只接受 POST
    if (req.method !== 'POST') {
      sendError(res, 405, 'E_METHOD', '该路由只接受 POST');
      return;
    }

    // 来源与 Content-Type 校验
    const refusal = postRefusal(req, patchDefaults.allowedOrigins);
    if (refusal !== null) {
      sendError(res, 403, 'E_FORBIDDEN', refusal);
      return;
    }
    if (!isJsonContentType(req)) {
      sendError(res, 415, 'E_CONTENT_TYPE', 'Content-Type 必须是 application/json');
      return;
    }

    // 请求体必须显式确认
    const body = await readJsonBody(req, BODY_LIMIT);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      sendError(res, 400, 'E_CONFIRM', '请求体必须是合法的 JSON 对象');
      return;
    }
    const requestBody = body as Record<string, unknown>;
    if (requestBody.confirm !== true) {
      sendError(res, 400, 'E_CONFIRM', '更新操作需要显式确认: {"confirm": true}');
      return;
    }

    // 忙碌状态与自动检查开关
    if (isBusy()) {
      sendError(res, 409, 'E_BUSY', '正在安装或重启，请稍后再试');
      return;
    }
    if (!preferences.checkEnabled) {
      sendError(res, 409, 'E_UPDATE_DISABLED', '自动检查已关闭，更新功能不可用；请先在设置页开启检查更新');
      return;
    }

    // 读取磁盘版本
    try {
      refreshInstalledVersion();
    } catch (error) {
      sendError(res, 500, 'E_STATE', `无法读取 DSH 安装版本: ${describeError(error)}`);
      return;
    }
    if (!isValidVersion(state.installedVersion)) {
      sendError(res, 500, 'E_STATE', `磁盘上的 DSH 版本号无法解析: ${state.installedVersion}`);
      return;
    }

    // 目标版本必须是当前可更新的最新版本
    const version = requestBody.version;
    const latest = state.latest;
    const available =
      latest !== null &&
      typeof version === 'string' &&
      isValidVersion(version) &&
      version === latest.version &&
      compareVersions(state.installedVersion, version) < 0;
    if (!available) {
      sendError(res, 409, 'E_NOT_AVAILABLE', '目标版本不是当前可更新的最新版本');
      return;
    }

    // 先回 202，再启动安装
    state.phase = 'installing';
    state.target = version;
    state.lastError = null;
    state.installOutput = null;
    sendJson(res, 202, snapshot());
    startInstall(version);
  };

  /** GET /__dsh-version-check/versions */
  const handleVersionsRoute: RouteHandler = async (req, res) => {
    // 只接受 GET
    if (req.method !== 'GET') {
      sendError(res, 405, 'E_METHOD', '该路由只接受 GET');
      return;
    }

    // 来源校验
    const refusal = gateRequest(req, patchDefaults.allowedOrigins);
    if (refusal !== null) {
      sendError(res, 403, 'E_FORBIDDEN', `请求来源校验失败: ${refusal}`);
      return;
    }

    // 安装期间不读磁盘版本，避免读到正在替换的 package.json
    if (!isBusy()) {
      try {
        refreshInstalledVersion();
      } catch (error) {
        sendError(res, 500, 'E_STATE', `无法读取 DSH 安装版本: ${describeError(error)}`);
        return;
      }
    }
    if (!ensureInstalledVersionParsable(res)) {
      return;
    }

    // 查询已发布版本；失败按 registry 错误上报
    let published: PublishedVersion[];
    try {
      published = await loadPublishedVersions();
    } catch (error) {
      sendError(res, 502, 'E_REGISTRY', describeError(error));
      return;
    }

    sendJson(res, 200, {
      ok: true,
      installedVersion: state.installedVersion,
      versions: selectRollbackCandidates(published, state.installedVersion),
    });
  };

  /** POST /__dsh-version-check/rollback */
  const handleRollbackRoute: RouteHandler = async (req, res) => {
    // 只接受 POST
    if (req.method !== 'POST') {
      sendError(res, 405, 'E_METHOD', '该路由只接受 POST');
      return;
    }

    // 来源与 Content-Type 校验
    const refusal = postRefusal(req, patchDefaults.allowedOrigins);
    if (refusal !== null) {
      sendError(res, 403, 'E_FORBIDDEN', refusal);
      return;
    }
    if (!isJsonContentType(req)) {
      sendError(res, 415, 'E_CONTENT_TYPE', 'Content-Type 必须是 application/json');
      return;
    }

    // 请求体必须显式确认
    const body = await readJsonBody(req, BODY_LIMIT);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      sendError(res, 400, 'E_CONFIRM', '请求体必须是合法的 JSON 对象');
      return;
    }
    const requestBody = body as Record<string, unknown>;
    if (requestBody.confirm !== true) {
      sendError(res, 400, 'E_CONFIRM', '回滚操作需要显式确认: {"confirm": true}');
      return;
    }

    // 忙碌状态；回滚是修复操作，不受自动检查开关限制
    if (isBusy()) {
      sendError(res, 409, 'E_BUSY', '正在安装或重启，请稍后再试');
      return;
    }

    // 读取磁盘版本
    try {
      refreshInstalledVersion();
    } catch (error) {
      sendError(res, 500, 'E_STATE', `无法读取 DSH 安装版本: ${describeError(error)}`);
      return;
    }
    if (!isValidVersion(state.installedVersion)) {
      sendError(res, 500, 'E_STATE', `磁盘上的 DSH 版本号无法解析: ${state.installedVersion}`);
      return;
    }

    // 目标版本必须是 registry 上比当前版本更旧的已发布版本
    const version = requestBody.version;
    if (typeof version !== 'string' || !isValidVersion(version)) {
      sendError(res, 409, 'E_NOT_AVAILABLE', '目标版本不是比当前版本更旧的已发布版本');
      return;
    }
    let published: PublishedVersion[];
    try {
      published = await loadPublishedVersions();
    } catch (error) {
      sendError(res, 502, 'E_REGISTRY', describeError(error));
      return;
    }
    const candidate = selectRollbackCandidates(published, state.installedVersion).some(
      (entry) => entry.version === version,
    );
    if (!candidate) {
      sendError(res, 409, 'E_NOT_AVAILABLE', '目标版本不是比当前版本更旧的已发布版本');
      return;
    }

    // 先回 202，再启动安装
    state.phase = 'installing';
    state.target = version;
    state.lastError = null;
    state.installOutput = null;
    sendJson(res, 202, snapshot());
    startInstall(version);
  };

  /** POST /__dsh-version-check/restart */
  const handleRestartRoute: RouteHandler = async (req, res) => {
    // 只接受 POST
    if (req.method !== 'POST') {
      sendError(res, 405, 'E_METHOD', '该路由只接受 POST');
      return;
    }

    // 来源与 Content-Type 校验
    const refusal = postRefusal(req, patchDefaults.allowedOrigins);
    if (refusal !== null) {
      sendError(res, 403, 'E_FORBIDDEN', refusal);
      return;
    }
    if (!isJsonContentType(req)) {
      sendError(res, 415, 'E_CONTENT_TYPE', 'Content-Type 必须是 application/json');
      return;
    }

    // 请求体必须显式确认
    const body = await readJsonBody(req, BODY_LIMIT);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      sendError(res, 400, 'E_CONFIRM', '请求体必须是合法的 JSON 对象');
      return;
    }
    const requestBody = body as Record<string, unknown>;
    if (requestBody.confirm !== true) {
      sendError(res, 400, 'E_CONFIRM', '重启操作需要显式确认: {"confirm": true}');
      return;
    }

    // 安装中不允许重复重启
    if (state.phase === 'installing') {
      sendError(res, 409, 'E_BUSY', '正在安装新版本，安装结束后会自动重启');
      return;
    }

    // 只有能自动重启的部署才允许
    if (deployment.restartMode !== 'systemd' || deployment.unitName === null) {
      sendError(res, 409, 'E_RESTART_MANUAL', '当前部署无法自动重启 DSH，请手动重启 dsh 服务');
      return;
    }

    state.phase = 'restarting';
    state.lastError = null;
    sendJson(res, 202, snapshot());
    scheduleRestartAfter(RESTART_DELAY_MANUAL_MS);
  };

  /** POST /__dsh-version-check/preferences */
  const handlePreferencesRoute: RouteHandler = async (req, res) => {
    // 只接受 POST
    if (req.method !== 'POST') {
      sendError(res, 405, 'E_METHOD', '该路由只接受 POST');
      return;
    }

    // 来源与 Content-Type 校验
    const refusal = postRefusal(req, patchDefaults.allowedOrigins);
    if (refusal !== null) {
      sendError(res, 403, 'E_FORBIDDEN', refusal);
      return;
    }
    if (!isJsonContentType(req)) {
      sendError(res, 415, 'E_CONTENT_TYPE', 'Content-Type 必须是 application/json');
      return;
    }

    // 请求体必须是合法的设置补丁
    const body = await readJsonBody(req, BODY_LIMIT);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      sendError(res, 400, 'E_PREFERENCES', '请求体必须是合法的 JSON 对象');
      return;
    }
    if (isBusy()) {
      sendError(res, 409, 'E_BUSY', '正在安装或重启，请稍后再试');
      return;
    }

    let patch;
    try {
      patch = normalizePreferencesPatch(body);
    } catch (error) {
      sendError(res, 400, 'E_PREFERENCES', describeError(error));
      return;
    }

    // 写盘后再更新内存设置
    const next: Preferences = { ...preferences, ...patch };
    try {
      writePreferencesFile(preferencesPath, next);
    } catch (error) {
      sendError(res, 500, 'E_PREFERENCES', `无法保存设置: ${describeError(error)}`);
      return;
    }
    preferences = next;
    preferencesError = null;
    state.lastError = null;

    // 关闭自动检查时保留上一次的查询结果，手动检查仍然可用
    if (preferences.checkEnabled) {
      armAutoCheck(false);
    } else {
      clearAutoCheck();
      if (state.phase === 'checking') {
        state.phase = 'idle';
      }
    }

    sendJson(res, 200, snapshot());
  };

  // 定时检查的生命周期
  ctx.effect(() => {
    armAutoCheck(false);
    return clearAutoCheck;
  }, 'dsh-version-check: 定时检查 registry');

  // 待执行的重启定时器
  ctx.effect(
    () => () => {
      for (const timer of restartTimers) {
        clearTimeout(timer);
      }
      restartTimers.clear();
    },
    'dsh-version-check: 清理待执行的重启定时器',
  );

  // 安装子进程
  ctx.effect(
    () => () => {
      if (activeInstall !== null) {
        activeInstall.kill('SIGKILL');
      }
    },
    'dsh-version-check: 清理安装子进程',
  );

  // HTTP 路由与页面样式表
  ctx.inject(['webServer'], (webCtx) => {
    // 把样式表注入页面 head，浏览器半的组件依赖这些类名
    webCtx.on('webserver/index-inject', (table) => {
      table.push({ kind: 'style', text: stylesheet });
    });

    // 七个 loopback 路由
    const routes: Array<[string, RouteHandler]> = [
      [STATE_PATH, handleStateRoute],
      [CHECK_PATH, handleCheckRoute],
      [UPDATE_PATH, handleUpdateRoute],
      [VERSIONS_PATH, handleVersionsRoute],
      [ROLLBACK_PATH, handleRollbackRoute],
      [RESTART_PATH, handleRestartRoute],
      [PREFERENCES_PATH, handlePreferencesRoute],
    ];
    for (const [path, handler] of routes) {
      webCtx.effect(
        () => webCtx.webServer.register({ kind: 'exact', path, handler }),
        `dsh-version-check: ${path}`,
      );
    }
  });
}
