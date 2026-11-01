# dsh-version-check

一个只管理 DSH 自身版本的 DSH 插件：在 Web 侧边栏底部的用户头像名称上方显示当前 DSH 版本，从 npm registry 检查 `@deepseek-ai/dsh` 的新版本，发现新版本后可以一键安装并自动重启 DSH 服务；也可以在设置页把主程序降级到更早的已发布版本。它不检查其他插件，也不修改 profile 里已安装插件。

## 界面

- 侧边栏展开时：底部出现一行 `DSH 版本`，右侧显示当前版本号；有新版本时右侧文字变成 `有新版本` 并带强调色圆点。关闭自动检查后仍然只显示当前版本号。
- 侧边栏收起时：显示一个 36px 图标按钮，有新版本时右上角出现圆点。
- 点击后弹出面板：显示当前版本、最新版本、发布渠道、上次检查时间，提供「检查更新」按钮；有新版本且有自动检查开启时再提供「更新并重启」；安装过程中显示进度与 npm 输出末尾；安装完成并重启后提示刷新页面。打开面板不会触发检查，只有定时任务和「检查更新」按钮会查询 registry。

## 设置页

设置面板左侧导航里有一项 `版本更新`，包含：

- `检查更新` 开关：关闭后停止定时检查，也不提供「更新并重启」；弹层里的「检查更新」仍然可以手动查询最新版本，但结果只用于展示。
- `自动检查间隔`：两次自动检查之间的分钟数，范围 1 到 10080。
- `发布渠道`：`自动` 跟随当前安装版本的前置标识（rc 版本跟踪 `latest`，alpha 版本跟踪 `alpha`），也可以固定为 `latest`、`next`、`alpha` 等 dist-tag。
- `回滚 DSH 版本`：点击 `选择版本` 打开版本框，列出 registry 上比当前安装版本更旧的已发布版本与发布时间；默认展示最近 5 个，可以展开查看全部，展开后的列表在版本框内滚动；选中版本确认后降级，回滚会重启服务并中断正在进行的会话。

这些选择保存在 `~/.dsh/dsh-version-check/preferences.json`，修改后立即生效，不需要重启 DSH。回滚候选列表不需要保存，打开版本框时按需读取 registry，并在内存里缓存 5 分钟。

## 行为

- 检查开启时，插件加载后 5 秒执行一次定时检查，之后按设置的间隔检查；点击侧边栏或打开弹层都只读取状态，不会触发检查。手动检查仅由弹层里的「检查更新」按钮发起。
- 安装使用 `npm install -g @deepseek-ai/dsh@<版本> --prefix <检测到的 npm 全局前缀>`，安装完成后回读磁盘上的 `package.json` 校验版本。更新与回滚共用这条安装流程。
- 回滚目标会先与 registry 的版本列表核对：只有比当前安装版本更旧的已发布版本才会被接受，安装完成后同样回读校验并重启服务。回滚是修复操作，不受「检查更新」开关限制。
- 重启通过 systemd 用户服务进行：从进程 cgroup 中识别当前服务单元（例如 `dsh-web.service`），确认当前进程就是该服务主进程后，调用 `systemctl --user restart --no-block <单元>`。检测不到 systemd 服务时不会终止进程，面板改为提示手动重启。
- 更新与回滚都会终止正在进行中的会话，界面上有明确提示。

## 配置

在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 里用相同 id 覆盖。这里的值是该 profile 的默认值，设置页里保存的用户选择优先级更高：

```yaml
- id: dsh-version-check
  config:
    registry: 'https://registry.npmjs.org'
    checkEnabled: true
    checkIntervalMinutes: 360
    channel: auto
    allowedOrigins: []
    restartTimeoutSeconds: 900
```

- `registry`：npm registry 地址。
- `checkEnabled`、`checkIntervalMinutes`、`channel`：与设置页里的三个选项对应，仅在没有用户设置时作为默认值。
- `allowedOrigins`：通过反向代理或隧道访问 Web 界面时，把浏览器实际使用的源填进来（例如 `https://dsh.example.com`），用于放宽请求来源校验；loopback 直连保持默认空数组。
- `restartTimeoutSeconds`：npm 安装超时（秒）。

## 安全边界

写操作路由（check、update、rollback、restart、preferences）只接受同源页面发起的请求：连接来源必须是本机 loopback，`Host` 必须是 loopback 或 `allowedOrigins` 中的主机名，`Origin` 必须与 `Host` 一致；POST 请求还要求 `content-type: application/json`，更新、回滚与重启还要求 `confirm: true`。版本列表路由 versions 只接受 GET，同样校验连接来源与 `Host`。这防止其他网页通过 DNS rebinding 或表单请求触发安装、降级或修改设置。

## 安装

```sh
dsh plugin --profile web add dsh-version-check
```

安装后重启 DSH 或刷新页面。插件从 npm registry 发布安装时，`package.json` 的 `exports` 指向构建好的 `lib/index.js` 与 `lib/client.js`，发布包不包含 TypeScript 源码。

## 文件

源码在 `src/`，`lib/` 是构建产物，发布包只包含 `lib/` 与资源文件：

- `src/index.ts`：Host 入口，注册七个 HTTP 路由、把 `styles/client.css` 注入页面 head、自动检查与设置持久化。
- `src/versions.ts`：版本解析与 semver 优先级比较。
- `src/registry.ts`：读取 npm dist-tags 与已发布版本列表，选择跟踪的渠道并筛选回滚候选。
- `src/deployment.ts`：定位 DSH 安装目录、npm 全局前缀与 systemd 单元。
- `src/gate.ts`：请求来源校验。
- `src/install.ts`：npm 安装子进程与服务重启。
- `src/preferences.ts`：设置校验、合并与 `preferences.json` 读写。
- `src/client.ts`：浏览器半，注册侧边栏脚部徽标与设置页。
- `src/styles/client.css`：侧边栏徽标、版本面板与设置页的样式，由 Host 注入页面 head。
- `tsdown.config.ts`：构建配置，Host 侧逐模块输出并生成类型声明，复制样式表；浏览器侧转译成普通脚本并校验产物。
- `cordis.patch.yml`：组合包 patch 层，插入插件条目并提供默认配置。

## 开发

```sh
npm install
npm run build   # 生成 lib/
npm run check   # tsc 类型检查，覆盖 src/ 与 test/
npm test        # 先构建，再用 node --test 运行测试
npm run verify  # 构建、类型检查与测试
```

`lib/` 是 DSH 实际加载的入口，修改 `src/` 之后必须重新构建，否则 DSH 仍会使用旧产物。构建由 [tsdown](https://tsdown.dev) 依据 `tsdown.config.ts` 完成：Host 侧保留逐模块产物并生成 `.d.ts`，浏览器侧转译成普通脚本，构建钩子会校验 `lib/client.js` 里没有 `import` 或 `export` 语句且保留了 `window.__ModuleLoader__.load` 注册。

## 发布

发布由 GitHub Actions 完成，认证使用 npm trusted publishing（OIDC），仓库里不保存 npm token。

- `.github/workflows/ci.yml`：推送到 `main` 与发起 pull request 时执行构建、类型检查与测试。
- `.github/workflows/publish.yml`：推送 `v*` tag 时执行同样的检查，然后执行 `npm publish` 发布到 `latest`。

发布前在 npmjs.com 打开包的 `Settings` 页面，在 `Trusted publishing` 里添加一个 GitHub Actions 发布者，这是只需要做一次的配置：

- Organization or user：`kerolt`
- Repository：`dsh-version-check`
- Workflow filename：`publish.yml`
- Allowed actions：勾选 `npm publish`

新建的发布者配置必须在 2 天内完成第一次成功发布，否则会失效。发布时自动生成 provenance 证明，这要求 npm CLI 不低于 11.5.1；工作流使用 Node 24，自带的 npm 满足要求。

发布步骤：

```sh
# 修改 package.json 里的 version 并提交到 main
git tag v0.4.0
git push origin v0.4.0
```

发布包只包含 `lib/`、`cordis.patch.yml`、`locale/`、`icon.svg`、`README.md` 与 `package.json`，源码与测试不进入发布包。安装到 profile 的 `node_modules` 后，DSH 从 `exports` 解析到 `lib/index.js` 与 `lib/client.js`，因此发布形态不依赖 Node 的类型剥离能力。
