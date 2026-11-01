/**
 * 定位 DSH 安装目录、npm 全局前缀与 systemd 服务单元。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

const PACKAGE_NAME = '@deepseek-ai/dsh';
const ROOT_SEARCH_DEPTH = 8;
const CGROUP_PATH = '/proc/self/cgroup';
const SYSTEMCTL_TIMEOUT_MS = 5000;
const USER_MANAGER_PREFIX = 'user@';

/** DSH 部署形态。 */
export interface DeploymentInfo {
  packageRoot: string;
  version: string;
  npmPrefix: string | null;
  unitName: string | null;
  restartMode: 'systemd' | 'manual';
}

/**
 * 从 `/proc/self/cgroup` 的内容中取所在服务的单元名。
 * 按 `/` 切分 cgroup 路径，从末尾向前找第一个 `.service` 段；
 * `.scope` 段继续向上查找（服务内嵌套的 scope 仍指向所属服务）。
 * `user@N.service` 是 systemd 用户管理器，重启它等于注销整个用户会话，
 * 因此该单元被排除并返回 null。
 * @param text cgroup 文件内容。
 * @returns 没有可用的 service 单元时返回 null。
 */
export function unitNameFromCgroup(text: unknown): string | null {
  if (typeof text !== 'string') {
    return null;
  }

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    // cgroup 行的最后一段是层级路径，从末尾向前找 service 单元
    const path = trimmed.slice(trimmed.lastIndexOf(':') + 1);
    const segments = path.split('/');
    for (let index = segments.length - 1; index >= 0; index -= 1) {
      const segment = segments[index];
      if (!segment.endsWith('.service')) {
        continue;
      }
      if (segment.startsWith(USER_MANAGER_PREFIX)) {
        return null;
      }

      return segment;
    }
  }

  return null;
}

/**
 * 读取 package.json；文件缺失或 JSON 非法就地抛出。
 * @param packageRoot 包目录。
 */
function readManifest(packageRoot: string): Record<string, unknown> {
  const text = readFileSync(join(packageRoot, 'package.json'), 'utf8');
  const manifest: unknown = JSON.parse(text);
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`package.json 不是对象: ${packageRoot}`);
  }

  return manifest as Record<string, unknown>;
}

/**
 * 从入口文件所在目录向上查找 `@deepseek-ai/dsh` 的安装目录。
 * @param startDir 查找起点目录。
 * @returns 包根目录。
 */
function findPackageRoot(startDir: string): string {
  let current = startDir;
  for (let depth = 0; depth <= ROOT_SEARCH_DEPTH; depth += 1) {
    const manifestPath = join(current, 'package.json');
    if (existsSync(manifestPath)) {
      const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (
        manifest !== null &&
        typeof manifest === 'object' &&
        (manifest as Record<string, unknown>).name === PACKAGE_NAME
      ) {
        return current;
      }
    }

    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  throw new Error(`在 ${startDir} 的上级目录中找不到 ${PACKAGE_NAME} 的安装目录`);
}

/**
 * 从安装目录推断 npm 全局前缀。
 * POSIX 安装位置形如 `<prefix>/lib/node_modules/@deepseek-ai/dsh`，
 * Windows 安装位置形如 `<prefix>/node_modules/@deepseek-ai/dsh`。
 * @param packageRoot 包根目录。
 * @returns 推断失败返回 null。
 */
function deriveNpmPrefix(packageRoot: string): string | null {
  const pattern =
    process.platform === 'win32'
      ? /^(.+)[\\/]node_modules[\\/]@deepseek-ai[\\/]dsh$/
      : /^(.+)\/lib\/node_modules\/@deepseek-ai\/dsh$/;
  const match = pattern.exec(packageRoot);
  if (match === null) {
    return null;
  }

  return match[1];
}

/**
 * 读取当前进程所属的 systemd 服务单元名。
 */
function readUnitName(): string | null {
  if (!existsSync(CGROUP_PATH)) {
    return null;
  }

  return unitNameFromCgroup(readFileSync(CGROUP_PATH, 'utf8'));
}

/**
 * 确认当前进程是该服务的 MainPID。
 * 只有服务的主进程才允许触发自身重启，否则会重启到错误的单元。
 * @param unitName systemd 服务单元名。
 */
function isServiceMainPid(unitName: string): boolean {
  const result = spawnSync('systemctl', ['--user', 'show', unitName, '-p', 'MainPID', '--value'], {
    encoding: 'utf8',
    timeout: SYSTEMCTL_TIMEOUT_MS,
  });
  if (result.error !== undefined || result.status !== 0) {
    return false;
  }

  return String(result.stdout).trim() === String(process.pid);
}

/**
 * 探测 DSH 的部署形态，同步执行。
 */
export function detectDeployment(): DeploymentInfo {
  // 入口文件与包根目录
  const entryPath = process.argv[1];
  if (typeof entryPath !== 'string' || entryPath.length === 0) {
    throw new Error('无法确定 DSH 入口文件: process.argv[1] 为空');
  }
  const realEntry = realpathSync(entryPath);
  const packageRoot = findPackageRoot(dirname(realEntry));

  // 磁盘上的版本
  const manifest = readManifest(packageRoot);
  const version = manifest.version;
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(`package.json 缺少 version 字段: ${packageRoot}`);
  }

  // systemd 单元；只有服务主进程才能自动重启
  const candidateUnit = process.platform === 'linux' ? readUnitName() : null;
  const unitName = candidateUnit !== null && isServiceMainPid(candidateUnit) ? candidateUnit : null;

  return {
    packageRoot,
    version,
    npmPrefix: deriveNpmPrefix(packageRoot),
    unitName,
    restartMode: unitName === null ? 'manual' : 'systemd',
  };
}

/**
 * 读取磁盘上当前的 DSH 版本。每次调用都重新读取 package.json。
 * @param packageRoot 包根目录。
 */
export function readInstalledVersion(packageRoot: string): string {
  const manifest = readManifest(packageRoot);
  const version = manifest.version;
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(`package.json 缺少 version 字段: ${packageRoot}`);
  }

  return version;
}

/**
 * 在 PATH 中查找 npm 可执行文件。
 * @param env 环境变量，默认使用 process.env。
 * @returns 找不到返回 null。
 */
export function findNpmExecutable(env: NodeJS.ProcessEnv = process.env): string | null {
  const rawPath = env === null || env === undefined ? '' : (env.PATH ?? '');
  const candidates = process.platform === 'win32' ? ['npm.cmd'] : ['npm'];

  for (const directory of rawPath.split(delimiter)) {
    if (directory.length === 0) {
      continue;
    }

    for (const name of candidates) {
      const candidate = join(directory, name);
      const stat = statSync(candidate, { throwIfNoEntry: false });
      if (stat === undefined || !stat.isFile()) {
        continue;
      }
      if (process.platform !== 'win32' && (stat.mode & 0o111) === 0) {
        continue;
      }

      return candidate;
    }
  }

  return null;
}
