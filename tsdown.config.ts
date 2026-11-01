import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { defineConfig } from 'tsdown';

/** 浏览器半产物必须是普通脚本，并保留模块加载器的注册调用。 */
function checkClientBundle(): void {
  const bundle = readFileSync(join('lib', 'client.js'), 'utf8');
  if (/^\s*(?:import|export)\b/m.test(bundle)) {
    throw new Error('lib/client.js 包含 import/export 语句，浏览器端只能使用脚本形式');
  }
  if (!bundle.includes('window.__ModuleLoader__.load(')) {
    throw new Error('lib/client.js 缺少 window.__ModuleLoader__.load 注册');
  }
  console.log('client bundle 校验通过: 普通脚本形式且保留了模块加载器注册');
}

export default defineConfig([
  {
    name: 'dsh-version-check: host',
    entry: 'src/index.ts',
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    // 保留逐模块产物，测试与 DSH 都按模块路径导入
    unbundle: true,
    fixedExtension: false,
    dts: {
      entry: ['src/*.ts', '!src/client.ts'],
      resolver: 'tsc',
    },
    deps: {
      // 类型声明保留对 DSH 运行时的包名引用，不把对方类型复制进发布包
      dts: {
        neverBundle: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-host-webserver'],
      },
    },
    clean: true,
    sourcemap: false,
    copy: [{ from: 'src/styles/client.css', to: 'lib/styles' }],
  },
  {
    name: 'dsh-version-check: client',
    entry: 'src/client.ts',
    outDir: 'lib',
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    fixedExtension: false,
    dts: false,
    clean: false,
    sourcemap: false,
    deps: {
      neverBundle: ['react'],
    },
    hooks: {
      'build:done': checkClientBundle,
    },
  },
]);
