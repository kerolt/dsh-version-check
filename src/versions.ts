/**
 * 版本号解析与比较，按 semver 的优先级规则处理 prerelease。
 * build metadata（`+` 之后的部分）解析时忽略。
 */

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

const NUMERIC_IDENTIFIER = /^(?:0|[1-9]\d*)$/;
const IDENTIFIER = /^[0-9A-Za-z-]+$/;
const VERSION =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * 解析一个版本字符串。
 * @param text 版本字符串，允许 v 前缀与 build metadata。
 * @returns 非法输入返回 null。
 */
export function parseVersion(text: unknown): ParsedVersion | null {
  if (typeof text !== 'string') {
    return null;
  }

  // 三段数字与可选 prerelease
  const match = VERSION.exec(text);
  if (match === null) {
    return null;
  }
  const core = [match[1], match[2], match[3]];
  if (!core.every((part) => NUMERIC_IDENTIFIER.test(part))) {
    return null;
  }

  // prerelease 标识符逐个校验
  const prerelease = match[4] === undefined ? [] : match[4].split('.');
  for (const identifier of prerelease) {
    if (!IDENTIFIER.test(identifier)) {
      return null;
    }
    // 数字标识符不允许前导零
    if (/^\d+$/.test(identifier) && !NUMERIC_IDENTIFIER.test(identifier)) {
      return null;
    }
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  };
}

/**
 * 取一个可比较的版本对象；非法版本就地抛出。
 * @param text 版本字符串。
 * @param label 参数名称，仅用于错误信息。
 */
function requireVersion(text: unknown, label: string): ParsedVersion {
  const parsed = parseVersion(text);
  if (parsed === null) {
    throw new TypeError(`${label} 不是合法的版本号: ${String(text)}`);
  }

  return parsed;
}

/**
 * 比较两个 prerelease 标识符。
 * 两个数字按数值比较；数字小于非数字；非数字按 ASCII 字典序比较。
 */
function compareIdentifiers(left: string, right: string): -1 | 0 | 1 {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);

  // 两个数字按数值比较
  if (leftNumeric && rightNumeric) {
    const leftValue = Number(left);
    const rightValue = Number(right);
    if (leftValue === rightValue) {
      return 0;
    }

    return leftValue < rightValue ? -1 : 1;
  }

  // 数字小于非数字
  if (leftNumeric !== rightNumeric) {
    return leftNumeric ? -1 : 1;
  }

  // 非数字按 ASCII 字典序比较
  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
}

/**
 * 按 semver 优先级比较两个版本号。
 * 有 prerelease 的版本小于同号正式版；prerelease 标识符逐个比较，
 * 前缀相同时更长的标识符列表更大。
 */
export function compareVersions(a: unknown, b: unknown): -1 | 0 | 1 {
  const left = requireVersion(a, 'a');
  const right = requireVersion(b, 'b');

  // 先比较核心版本号
  for (const field of ['major', 'minor', 'patch'] as const) {
    if (left[field] !== right[field]) {
      return left[field] < right[field] ? -1 : 1;
    }
  }

  // 正式版大于同号 prerelease 版本
  const leftPrerelease = left.prerelease;
  const rightPrerelease = right.prerelease;
  if (leftPrerelease.length === 0 && rightPrerelease.length === 0) {
    return 0;
  }
  if (leftPrerelease.length === 0) {
    return 1;
  }
  if (rightPrerelease.length === 0) {
    return -1;
  }

  // prerelease 标识符逐个比较，前缀相同时更长的列表更大
  const length = Math.min(leftPrerelease.length, rightPrerelease.length);
  for (let index = 0; index < length; index += 1) {
    const result = compareIdentifiers(leftPrerelease[index], rightPrerelease[index]);
    if (result !== 0) {
      return result;
    }
  }
  if (leftPrerelease.length === rightPrerelease.length) {
    return 0;
  }

  return leftPrerelease.length < rightPrerelease.length ? -1 : 1;
}

/**
 * 取版本号 prerelease 渠道，即第一个 prerelease 标识符。
 * @param version 版本字符串。
 * @returns 无 prerelease 或版本非法时返回 null。
 */
export function prereleaseChannel(version: unknown): string | null {
  const parsed = parseVersion(version);
  if (parsed === null || parsed.prerelease.length === 0) {
    return null;
  }

  return parsed.prerelease[0];
}

/**
 * 判断字符串是否是一个合法版本号。
 */
export function isValidVersion(text: unknown): boolean {
  return parseVersion(text) !== null;
}
