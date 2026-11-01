#!/usr/bin/env bash
# 对已安装的 dsh-version-check Host 路由做真实的 HTTP 验证。
# 用法：DVC_CURL_OPTS="-b /tmp/cookies.txt" bash scripts/verify-http.sh [base-url]
# 默认 base-url http://127.0.0.1:3080；登录 cookie 通过 DVC_CURL_OPTS 传入。
# 本脚本不会触发真实的更新或重启，只验证状态读取、检查更新与各种拒绝路径。
set -u

BASE="${1:-http://127.0.0.1:3080}"
AUTH_OPTS="${DVC_CURL_OPTS:-}"
BODY_FILE=/tmp/dvc-verify-body.json
STATE_FILE=/tmp/dvc-verify-state.json
FAIL=0

report() {
  local label="$1" expected="$2" actual="$3" body="$4"
  if [ "$expected" = "$actual" ]; then
    echo "PASS  $label  ($actual)"
  else
    echo "FAIL  $label  期望 $expected，实际 $actual"
    echo "      body: $body"
    FAIL=1
  fi
}

request() {
  # shellcheck disable=SC2086
  curl -sS $AUTH_OPTS -o "$BODY_FILE" -w '%{http_code}' -H "Origin: $BASE" "$@" || echo "000"
}

body() {
  cat "$BODY_FILE" 2>/dev/null
}

echo "== base: $BASE =="

code=$(request "$BASE/__dsh-version-check/state")
report "GET state 返回 200" 200 "$code" "$(body)"
cp "$BODY_FILE" "$STATE_FILE"
echo "      state: $(body)"

node - "$STATE_FILE" <<'NODE'
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const problems = [];
const expect = (condition, message) => {
  if (!condition) problems.push(message);
};
expect(state.ok === true, 'ok 必须为 true');
expect(typeof state.bootVersion === 'string' && state.bootVersion.length > 0, 'bootVersion 必须是非空字符串');
expect(typeof state.installedVersion === 'string' && state.installedVersion.length > 0, 'installedVersion 必须是非空字符串');
expect(state.settings !== undefined && state.settings !== null, 'settings 必须存在');
const settings = state.settings ?? {};
expect(typeof settings.checkEnabled === 'boolean', 'settings.checkEnabled 必须是布尔值');
expect(Number.isInteger(settings.checkIntervalMinutes), 'settings.checkIntervalMinutes 必须是整数');
expect(typeof settings.channel === 'string' && settings.channel.length > 0, 'settings.channel 必须是非空字符串');
if (settings.checkEnabled === true) {
  expect(state.latest !== null && typeof state.latest.version === 'string' && typeof state.latest.tag === 'string', '检查开启时 latest 必须包含 version 与 tag');
}
expect(typeof state.updateAvailable === 'boolean', 'updateAvailable 必须是布尔值');
expect(['idle', 'checking', 'installing', 'restarting', 'restart-required', 'error'].includes(state.phase), 'phase 必须是约定枚举之一');
expect(state.restartMode === 'systemd' || state.restartMode === 'manual', 'restartMode 必须是 systemd 或 manual');
expect(state.restartMode === 'systemd' ? typeof state.restartUnit === 'string' : state.restartUnit === null, 'restartUnit 必须与 restartMode 对应');
if (problems.length > 0) {
  console.error('FAIL  state 结构: ' + problems.join('; '));
  process.exit(1);
}
console.log(`PASS  state 结构  (boot=${state.bootVersion}, installed=${state.installedVersion}, latest=${state.latest === null ? 'null' : state.latest.version}, tag=${state.latest === null ? 'null' : state.latest.tag}, updateAvailable=${state.updateAvailable}, phase=${state.phase}, restartMode=${state.restartMode}, unit=${state.restartUnit}, settings=${JSON.stringify(state.settings)})`);
NODE
if [ "$?" != "0" ]; then FAIL=1; fi

# 先恢复默认设置，保证后续检查类断言不受用户暂停影响
RESTORE_NEEDED=1
restore_preferences() {
  if [ "${RESTORE_NEEDED:-0}" = "1" ]; then
    # shellcheck disable=SC2086
    curl -sS $AUTH_OPTS -o /dev/null -H "Origin: $BASE" -X POST \
      -H 'content-type: application/json' \
      -d '{"checkEnabled":true,"checkIntervalMinutes":360,"channel":"auto"}' \
      "$BASE/__dsh-version-check/preferences" || true
  fi
}
trap restore_preferences EXIT

code=$(request -X POST -H 'content-type: application/json' -d '{"checkEnabled":true,"checkIntervalMinutes":360,"channel":"auto"}' "$BASE/__dsh-version-check/preferences")
report "preferences 恢复默认返回 200" 200 "$code" "$(body)"

code=$(request -X POST -H 'content-type: application/json' -d '{}' "$BASE/__dsh-version-check/check")
report "POST check 返回 200" 200 "$code" "$(body)"

code=$(request -X POST -H 'content-type: application/json' -d '{"confirm":false,"version":"0.0.0"}' "$BASE/__dsh-version-check/update")
report "update 缺少 confirm 返回 400" 400 "$code" "$(body)"

code=$(request -X POST -H 'content-type: application/json' -H 'Origin: http://evil.example' -d '{"confirm":true,"version":"0.0.0"}' "$BASE/__dsh-version-check/update")
report "跨源 update 返回 403" 403 "$code" "$(body)"

code=$(request -X POST -H 'content-type: application/json' -H 'Origin: http://evil.example' -d '{"confirm":true}' "$BASE/__dsh-version-check/restart")
report "跨源 restart 返回 403" 403 "$code" "$(body)"

code=$(request -X POST -H 'content-type: text/plain' --data-binary 'confirm=true' "$BASE/__dsh-version-check/check")
report "check 错误 content-type 返回 415" 415 "$code" "$(body)"

code=$(request -X GET "$BASE/__dsh-version-check/check")
report "GET check 返回 405" 405 "$code" "$(body)"

code=$(request -X POST -H 'content-type: application/json' -d '{"confirm":true,"version":"99.99.99"}' "$BASE/__dsh-version-check/update")
report "update 不存在的版本返回 409" 409 "$code" "$(body)"

code=$(request -X POST -H 'content-type: application/json' -d '{"confirm":false}' "$BASE/__dsh-version-check/restart")
report "restart 缺少 confirm 返回 400" 400 "$code" "$(body)"

code=$(request -X POST -H 'content-type: application/json' -d '{"bogus":1}' "$BASE/__dsh-version-check/preferences")
report "preferences 未知字段返回 400" 400 "$code" "$(body)"

code=$(request -X POST -H 'content-type: application/json' -d '{"checkIntervalMinutes":0}' "$BASE/__dsh-version-check/preferences")
report "preferences 非法间隔返回 400" 400 "$code" "$(body)"

code=$(request -X POST -H 'content-type: application/json' -H 'Origin: http://evil.example' -d '{"checkEnabled":false}' "$BASE/__dsh-version-check/preferences")
report "跨源 preferences 返回 403" 403 "$code" "$(body)"

code=$(request -X POST -H 'content-type: text/plain' --data-binary '{"checkEnabled":false}' "$BASE/__dsh-version-check/preferences")
report "preferences 错误 content-type 返回 415" 415 "$code" "$(body)"

# 关闭自动检查与恢复：过程中修改真实设置，收尾时由 trap 恢复默认值
RESTORE_NEEDED=1

code=$(request -X POST -H 'content-type: application/json' -d '{"checkEnabled":false}' "$BASE/__dsh-version-check/preferences")
report "preferences 关闭自动检查返回 200" 200 "$code" "$(body)"
cp "$BODY_FILE" /tmp/dvc-verify-paused.json

node - /tmp/dvc-verify-paused.json <<'NODE'
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const problems = [];
if (state.settings?.checkEnabled !== false) problems.push('settings.checkEnabled 应为 false');
if (problems.length > 0) {
  console.error('FAIL  关闭自动检查状态: ' + problems.join('; '));
  process.exit(1);
}
console.log('PASS  关闭自动检查状态  (checkEnabled=false)');
NODE
if [ "$?" != "0" ]; then FAIL=1; fi

# 关闭后仍允许手动检查
code=$(request -X POST -H 'content-type: application/json' -d '{}' "$BASE/__dsh-version-check/check")
report "关闭后手动检查返回 200" 200 "$code" "$(body)"
cp "$BODY_FILE" /tmp/dvc-verify-manual.json

node - /tmp/dvc-verify-manual.json <<'NODE'
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const problems = [];
if (state.settings?.checkEnabled !== false) problems.push('手动检查不应改变 settings.checkEnabled');
if (state.latest === null || typeof state.latest.version !== 'string') problems.push('手动检查后 latest 必须可读');
if (typeof state.lastCheckedAt !== 'number') problems.push('手动检查后 lastCheckedAt 必须是时间戳');
if (problems.length > 0) {
  console.error('FAIL  关闭后手动检查: ' + problems.join('; '));
  process.exit(1);
}
console.log(`PASS  关闭后手动检查  (latest=${state.latest.version}, tag=${state.latest.tag}, lastCheckedAt 已更新)`);
NODE
if [ "$?" != "0" ]; then FAIL=1; fi

# 关闭后更新功能必须拒绝，且不触发安装
LATEST_VERSION=$(node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/dvc-verify-manual.json','utf8')).latest.version)")
code=$(request -X POST -H 'content-type: application/json' -d "{\"confirm\":true,\"version\":\"$LATEST_VERSION\"}" "$BASE/__dsh-version-check/update")
report "关闭后 update 返回 409" 409 "$code" "$(body)"
case "$(body)" in
  *E_UPDATE_DISABLED*) echo "PASS  update 拒绝原因为 E_UPDATE_DISABLED" ;;
  *) echo "FAIL  update 拒绝原因不是 E_UPDATE_DISABLED: $(body)"; FAIL=1 ;;
esac

code=$(request -X POST -H 'content-type: application/json' -d '{"checkEnabled":true}' "$BASE/__dsh-version-check/preferences")
report "preferences 恢复检查返回 200" 200 "$code" "$(body)"
RESTORE_NEEDED=0

# shellcheck disable=SC2086
curl -sS $AUTH_OPTS -o /dev/null -H "Origin: $BASE" -X POST -H 'content-type: application/json' \
  -d '{"checkEnabled":true,"checkIntervalMinutes":360,"channel":"auto"}' "$BASE/__dsh-version-check/preferences"

if [ "$FAIL" = "0" ]; then
  echo "RESULT: 全部通过"
else
  echo "RESULT: 存在失败项"
fi
exit "$FAIL"
