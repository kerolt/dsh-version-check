import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

interface RegisteredModule {
  id: string;
  factory(require: (id: string) => unknown): {
    inject: string[];
    apply(ctx: unknown): void;
  };
}

/** React 运行时只需要存在这些接口，冒烟测试不会真正渲染组件。 */
const REACT_STUB = {
  createElement: () => null,
  useState: <T>(value: T) => [value, () => {}],
  useRef: <T>(value: T) => ({ current: value }),
  useEffect: () => {},
  useLayoutEffect: () => {},
  useSyncExternalStore: <T>(_subscribe: () => void, getSnapshot: () => T) => getSnapshot(),
};

function loadClientBundle(): { code: string; registered: RegisteredModule } {
  const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  let registered: RegisteredModule | null = null;
  const fakeWindow = {
    __ModuleLoader__: {
      load(definition: RegisteredModule) {
        registered = definition;
      },
    },
  };
  runInNewContext(code, {
    window: fakeWindow,
    fetch: () => new Promise(() => {}),
    require: (id: string) => {
      if (id === 'react') {
        return REACT_STUB;
      }
      throw new Error(`未预期的模块: ${id}`);
    },
  });
  if (registered === null) {
    throw new Error('客户端 bundle 没有调用 window.__ModuleLoader__.load');
  }

  return { code, registered };
}

test('客户端 bundle 是脚本形式，注册 dsh-version-check 模块并返回 inject/apply', () => {
  const { code, registered } = loadClientBundle();
  assert.doesNotMatch(code, /^\s*(?:import|export)\b/m);
  assert.equal(registered.id, 'dsh-version-check');

  const plugin = registered.factory((id: string) => {
    if (id === 'react') {
      return REACT_STUB;
    }
    throw new Error(`未预期的模块: ${id}`);
  });
  assert.deepEqual(Array.from(plugin.inject), ['slots', 'locale']);
  assert.equal(typeof plugin.apply, 'function');
});

test('客户端 apply 注册词典、状态轮询与两个槽位', () => {
  const { registered } = loadClientBundle();
  const plugin = registered.factory((id: string) => {
    if (id === 'react') {
      return REACT_STUB;
    }
    throw new Error(`未预期的模块: ${id}`);
  });

  const effects: string[] = [];
  const injected: string[] = [];
  const slots: Array<Record<string, unknown>> = [];
  const dictionaries: string[] = [];
  const ctx = {
    effect: (execute: () => void | (() => void), label?: string) => {
      effects.push(label === undefined ? '' : label);
      execute();
    },
    locale: {
      register(namespace: string) {
        dictionaries.push(namespace);
      },
      bind: () => (key: string) => key,
    },
    slots: {
      inject: (name: string, callback: () => void) => {
        injected.push(name);
        callback();
      },
      register: (definition: Record<string, unknown>) => {
        slots.push(definition);
      },
    },
  };

  plugin.apply(ctx);
  assert.deepEqual(dictionaries, ['dsh-version-check']);
  assert.deepEqual(injected, ['sidebar.footer.action', 'settings.section']);
  assert.deepEqual(
    slots.map((definition) => definition.name),
    ['sidebar.footer.action', 'settings.section'],
  );
  assert.ok(effects.includes('dsh-version-check: dictionaries'));
  assert.ok(effects.includes('dsh-version-check: state polling'));
});
