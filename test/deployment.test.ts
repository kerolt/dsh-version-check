import test from 'node:test';
import assert from 'node:assert/strict';

import { unitNameFromCgroup } from '../lib/deployment.js';

test('unitNameFromCgroup 从真实 cgroup 内容取服务单元名', () => {
  assert.equal(
    unitNameFromCgroup('0::/user.slice/user-1000.slice/user@1000.service/app.slice/dsh-web.service'),
    'dsh-web.service',
  );
});

test('unitNameFromCgroup 排除 user@ 用户管理器单元', () => {
  assert.equal(
    unitNameFromCgroup(
      '0::/user.slice/user-1000.slice/user@1000.service/app.slice/dsh-subprocess-711132-fbc2e1298aba.scope',
    ),
    null,
  );
  assert.equal(unitNameFromCgroup('0::/user.slice/user-1000.slice/user@1000.service'), null);
});

test('unitNameFromCgroup 对空内容返回 null', () => {
  assert.equal(unitNameFromCgroup(''), null);
});

test('unitNameFromCgroup 从服务内嵌套 scope 向上取所属服务', () => {
  assert.equal(
    unitNameFromCgroup(
      '0::/user.slice/user-1000.slice/user@1000.service/app.slice/dsh-web.service/dsh-subprocess-711132-fbc2e1298aba.scope',
    ),
    'dsh-web.service',
  );
});
