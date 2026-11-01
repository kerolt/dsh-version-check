/**
 * 请求来源校验：只接受本机 loopback 页面发起的请求。
 */

const LOOPBACK_IPV4 = /^127(?:\.\d{1,3}){3}$/;

/** 来源校验只读取请求的 socket 与 headers，测试可以构造同形状的对象。 */
export interface GateRequestLike {
  socket?: {
    remoteAddress?: string | null;
    encrypted?: boolean;
  } | null;
  headers: {
    host?: string | string[] | undefined;
    origin?: string | string[] | undefined;
  };
}

/** 拒绝原因；通过时返回 null。 */
export type GateRefusal = 'bad-remote' | 'bad-host' | 'cross-origin' | null;

/**
 * 取可比较的主机名：转小写并去掉 IPv6 方括号。
 */
function bareHostname(value: string): string {
  return value.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
}

/**
 * 判断主机名是否指向 loopback 接口。
 */
function isLoopbackHostname(hostname: string): boolean {
  const text = bareHostname(hostname);
  if (text === 'localhost' || text === '::1') {
    return true;
  }

  return LOOPBACK_IPV4.test(text);
}

/**
 * 解析 `Host` 头为 `{hostname, port}`。
 * @param value `Host` 头原始值。
 */
function splitHost(value: unknown): { hostname: string; port: string } | null {
  if (typeof value !== 'string') {
    return null;
  }

  const text = value.trim();
  const bracketed = text.match(/^\[([^\]]+)\](?::(\d{1,5}))?$/);
  if (bracketed !== null) {
    return { hostname: bracketed[1], port: bracketed[2] ?? '' };
  }

  const plain = text.match(/^([A-Za-z0-9._-]+)(?::(\d{1,5}))?$/);
  if (plain === null) {
    return null;
  }

  return { hostname: plain[1], port: plain[2] ?? '' };
}

/**
 * 解析 Origin 为可比较的形式。
 * @param value Origin 头原始值。
 * @returns 非 http/https 源返回 null。
 */
function parseOrigin(
  value: string,
): { key: string; hostname: string; scheme: string; port: string } | null {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }

  const hostname = bareHostname(parsed.hostname);
  const port = parsed.port;
  const key = `${parsed.protocol}//${hostname}${port.length > 0 ? `:${port}` : ''}`;
  return { key, hostname, scheme: parsed.protocol, port };
}

/**
 * 校验请求来源。
 * @param req 请求对象。
 * @param allowedOrigins 反向代理或隧道场景下额外允许的源。
 */
export function gateRequest(req: GateRequestLike, allowedOrigins: string[] = []): GateRefusal {
  // 额外允许的源与主机名
  const allowedKeys = new Set<string>();
  const allowedHostnames = new Set<string>();
  for (const entry of Array.isArray(allowedOrigins) ? allowedOrigins : []) {
    const origin = parseOrigin(entry);
    if (origin === null) {
      continue;
    }
    allowedKeys.add(origin.key);
    allowedHostnames.add(origin.hostname);
  }

  // 连接必须来自 loopback
  const remote = String(req.socket?.remoteAddress ?? '').replace(/^::ffff:/i, '');
  if (!isLoopbackHostname(remote)) {
    return 'bad-remote';
  }

  // Host 必须是 loopback 或显式允许的主机名
  const host = splitHost(req.headers.host);
  if (host === null) {
    return 'bad-host';
  }
  const hostname = bareHostname(host.hostname);
  if (!isLoopbackHostname(hostname) && !allowedHostnames.has(hostname)) {
    return 'bad-host';
  }

  // 没有 Origin 的 GET 请求到此放行
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin.length === 0) {
    return null;
  }
  if (origin === 'dsh-app://app') {
    return null;
  }

  // Origin 必须与 Host 同源；显式允许的源可以放宽与 Host 的对应关系
  const parsed = parseOrigin(origin);
  if (parsed === null) {
    return 'cross-origin';
  }
  if (allowedKeys.has(parsed.key)) {
    return null;
  }
  if (parsed.hostname !== hostname) {
    return 'cross-origin';
  }
  const originPort = parsed.port.length > 0 ? parsed.port : parsed.scheme === 'https:' ? '443' : '80';
  const connectionPort = req.socket?.encrypted === true ? '443' : '80';
  if (originPort !== (host.port.length > 0 ? host.port : connectionPort)) {
    return 'cross-origin';
  }

  return null;
}
