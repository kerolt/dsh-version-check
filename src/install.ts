/**
 * npm 全局安装与 systemd 服务重启的子进程封装。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';

const OUTPUT_LIMIT = 4000;
const RESTART_ERROR_LIMIT = 400;

/** npm 安装结束时的结果。 */
export interface InstallResult {
  code: number | null;
  signal: string | null;
  outputTail: string;
  timedOut: boolean;
  error?: Error;
}

/** npm 安装的参数与结束回调。 */
export interface InstallOptions {
  npmExecutable: string;
  npmPrefix: string;
  version: string;
  timeoutMs: number;
  onExit: (result: InstallResult) => void;
}

/**
 * 用 npm 全局安装指定版本的 `@deepseek-ai/dsh`。
 * 输出收集末尾 4000 字符，超时后终止子进程。
 */
export function runNpmInstall({
  npmExecutable,
  npmPrefix,
  version,
  timeoutMs,
  onExit,
}: InstallOptions): ChildProcess {
  const child = spawn(
    npmExecutable,
    [
      'install',
      '-g',
      `@deepseek-ai/dsh@${version}`,
      '--prefix',
      npmPrefix,
      '--no-audit',
      '--no-fund',
      '--loglevel=error',
    ],
    { cwd: homedir(), stdio: ['ignore', 'pipe', 'pipe'] },
  );

  // 收集输出末尾，用于失败时的可读摘要
  let outputTail = '';
  const append = (chunk: string) => {
    outputTail = (outputTail + chunk).slice(-OUTPUT_LIMIT);
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', append);
  child.stderr.on('data', append);

  // 结束回调只执行一次，并清理超时定时器
  let timedOut = false;
  let settled = false;
  let timer: NodeJS.Timeout | null = null;
  const finish = (result: Omit<InstallResult, 'outputTail'>) => {
    if (settled) {
      return;
    }
    settled = true;
    if (timer !== null) {
      clearTimeout(timer);
    }
    onExit({ ...result, outputTail });
  };

  timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, timeoutMs);

  child.on('error', (error) => finish({ code: null, signal: null, timedOut: false, error }));
  child.on('close', (code, signal) => finish({ code, signal, timedOut }));
  return child;
}

/**
 * 请求 systemd 重启 DSH 服务，使用 --no-block 立即返回。
 * 监听 systemctl 的非零退出码，重启请求未被 systemd 接受时通过 onError 上报。
 * @param unitName systemd 服务单元名。
 * @param onError 失败时的回调；未提供时写入 stderr。
 */
export function scheduleServiceRestart(
  unitName: string,
  onError: ((error: Error) => void) | null = null,
): ChildProcess {
  const child = spawn('systemctl', ['--user', 'restart', '--no-block', unitName], {
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  // 收集 stderr 末尾，失败时并入错误信息
  let stderrTail = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-RESTART_ERROR_LIMIT);
  });

  // 错误只上报一次
  let reported = false;
  const report = (error: Error) => {
    if (reported) {
      return;
    }
    reported = true;
    if (typeof onError === 'function') {
      onError(error);
    } else {
      console.error(`无法重启 DSH 服务: ${error.message}`);
    }
  };

  child.on('error', (error) => report(error));
  child.on('exit', (code, signal) => {
    if (code === 0) {
      return;
    }

    const detail = stderrTail.trim();
    const suffix = detail.length > 0 ? `: ${detail}` : '';
    const reason = signal === null ? `退出码 ${code}` : `信号 ${signal}`;
    report(new Error(`systemctl 重启请求失败（${reason}）${suffix}`));
  });
  child.unref();
  return child;
}
