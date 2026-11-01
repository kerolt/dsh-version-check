// dsh-version-check 浏览器半：侧边栏底部的 DSH 版本徽标与版本面板。
// 由 DSH Web 的 client module loader 在页面加载后调用 factory，注册 sidebar.footer.action 槽位。
// 该文件被当作普通 <script> 执行，不能出现 import/export 语句。

/** 模块加载器注入到全局的注册接口。 */
interface ModuleLoaderFacade {
  load(definition: {
    id: string;
    factory(require: (id: string) => unknown): { inject: string[]; apply: (ctx: ClientContext) => void };
  }): void;
}

/** 浏览器侧 React 运行时只用到这里的少量接口。 */
interface ReactRuntime {
  createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown;
  useState<T>(initial: T): [T, (next: T | ((previous: T) => T)) => void];
  useRef<T>(initial: T): { current: T };
  useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  useLayoutEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  useSyncExternalStore<T>(subscribe: (listener: () => void) => () => void, getSnapshot: () => T): T;
}

/** Host 返回的状态快照。 */
interface Snapshot {
  ok: boolean;
  bootVersion: string;
  installedVersion: string;
  latest: { version: string; tag: string } | null;
  channel: string;
  updateAvailable: boolean;
  phase: string;
  restartMode: 'systemd' | 'manual';
  restartUnit: string | null;
  lastCheckedAt: number | null;
  lastError: { code: string; message: string } | null;
  installOutput: string | null;
  target: string | null;
  settings?: { checkEnabled: boolean; checkIntervalMinutes: number; channel: string };
}

/** 进行中的动作名称。 */
type BusyAction = 'check' | 'update' | 'rollback' | 'restart' | 'preferences';

/** 设置补丁。 */
interface PreferencesPatch {
  checkEnabled?: boolean;
  checkIntervalMinutes?: number;
  channel?: string;
}

/** 共享状态视图。 */
interface VersionView {
  snapshot: Snapshot | null;
  offline: boolean;
  actionError: string | null;
  busy: BusyAction | null;
  lastAction: BusyAction | null;
  pendingTarget: string | null;
}

/** registry 里的一个已发布版本。 */
interface RollbackVersion {
  version: string;
  publishedAt: string | null;
}

/** GET /versions 的响应。 */
interface VersionsResponse {
  ok: true;
  installedVersion: string;
  versions: RollbackVersion[];
}

/** 翻译函数。 */
type Translate = (key: string, params?: Record<string, string | number>) => string;

/** 共享状态源。 */
interface VersionStore {
  subscribe(listener: () => void): () => void;
  getView(): VersionView;
  start(): void;
  stop(): void;
  checkNow(): Promise<void>;
  startUpdate(version: string): Promise<void>;
  rollbackTo(version: string): Promise<void>;
  restartService(): Promise<void>;
  savePreferences(patch: PreferencesPatch): Promise<void>;
}

/** 弹层锚点。 */
interface PanelAnchor {
  left: number;
  bottom: number;
}

/** 版本框的固定定位锚点。 */
interface PopoverAnchor {
  top: number;
  left: number;
}

/** 浏览器侧插件上下文只用到这里声明的服务。 */
interface ClientContext {
  effect(execute: () => void | (() => void), label?: string): void;
  locale: {
    register(namespace: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }): void;
    bind(namespace: string): Translate;
  };
  slots: {
    inject(name: string, callback: () => void): void;
    register(definition: Record<string, unknown>, component: unknown): void;
  };
}

(window as unknown as Window & { __ModuleLoader__: ModuleLoaderFacade }).__ModuleLoader__.load({
  id: 'dsh-version-check',
  factory(require) {
    const React = require('react') as ReactRuntime;
    const h = React.createElement;

    // Host 路由前缀、轮询周期与槽位依赖
    const NS = 'dsh-version-check';
    const STATE_PATH = '/__dsh-version-check/state';
    const CHECK_PATH = '/__dsh-version-check/check';
    const UPDATE_PATH = '/__dsh-version-check/update';
    const VERSIONS_PATH = '/__dsh-version-check/versions';
    const ROLLBACK_PATH = '/__dsh-version-check/rollback';
    const RESTART_PATH = '/__dsh-version-check/restart';
    const PREFERENCES_PATH = '/__dsh-version-check/preferences';
    const IDLE_POLL_MS = 30000;
    const ACTIVE_POLL_MS = 1000;
    const ACTIVE_PHASES = new Set(['installing', 'restarting']);
    const inject = ['slots', 'locale'];

    // 中文与英文词典，键集合保持一致
    const zh = {
      'badge.label': 'DSH 版本',
      'badge.checking': '检查中',
      'badge.updateAvailable': '有新版本',
      'badge.installing': '更新中',
      'badge.restartRequired': '待重启',
      'badge.error': '检查失败',
      'panel.title': 'DSH 版本',
      'panel.current': '当前版本',
      'panel.latest': '最新版本',
      'panel.channel': '发布渠道',
      'panel.lastChecked': '上次检查',
      'panel.never': '尚未检查',
      'panel.justNow': '刚刚',
      'panel.minutesAgo': '{count} 分钟前',
      'panel.hoursAgo': '{count} 小时前',
      'panel.daysAgo': '{count} 天前',
      'panel.status.upToDate': '已是最新版本',
      'panel.status.notChecked': '尚未检查',
      'panel.status.updateAvailable': '有新版本可用',
      'panel.status.checking': '正在检查更新',
      'panel.status.installing': '正在安装 {version}',
      'panel.status.restarting': '正在重启服务',
      'panel.status.restartRequired': '已安装 {version}，需要重启 DSH 生效',
      'panel.status.updated': '已更新到 {version}',
      'panel.status.error': '检查失败',
      'panel.action.check': '检查更新',
      'panel.action.update': '更新并重启',
      'panel.action.restart': '重启服务',
      'panel.action.reload': '刷新页面',
      'panel.note.restart': '更新会重启 DSH 服务，正在进行的会话会中断',
      'panel.note.manualRestart': '当前部署无法自动重启，请手动重启 dsh 服务以应用新版本',
      'panel.note.autoOff': '自动检查已关闭，仍可手动检查最新版本；重新开启后才能更新',
      'panel.note.registry': '来源 npm registry',
      'settings.nav': '版本更新',
      'settings.description': '控制 DSH 自身更新检查的开关、自动检查间隔与发布渠道，也可以把主程序回滚到更早的已发布版本',
      'settings.check.title': '检查更新',
      'settings.check.desc': '关闭后不再定时检查，也不启用更新功能；仍可在弹层里手动检查最新版本',
      'settings.interval.title': '自动检查间隔',
      'settings.interval.desc': '两次自动检查之间的时间，范围 1 到 10080 分钟',
      'settings.interval.unit': '分钟',
      'settings.interval.invalid': '请输入 1 到 10080 之间的整数分钟',
      'settings.channel.title': '发布渠道',
      'settings.channel.desc': '自动跟随当前安装版本的前置标识，也可以固定为某个 npm dist-tag',
      'settings.channel.auto': '自动',
      'settings.save.saving': '正在保存',
      'settings.save.saved': '已保存',
      'settings.loading': '正在读取设置',
      'settings.unavailable': '当前运行的 Host 版本不提供设置接口，请更新插件后重试',
      'settings.rollback.title': '回滚 DSH 版本',
      'settings.rollback.desc': '回滚会重启服务并中断正在进行的会话',
      'settings.rollback.loading': '正在读取已发布版本',
      'settings.rollback.error': '读取已发布版本失败：{message}',
      'settings.rollback.retry': '重新读取',
      'settings.rollback.pick': '选择版本',
      'settings.rollback.pickTitle': '选择要回滚的版本',
      'settings.rollback.empty': '没有比当前版本更旧的已发布版本',
      'settings.rollback.expand': '显示全部 {count} 个版本',
      'settings.rollback.collapse': '收起',
      'settings.rollback.action': '回滚',
      'settings.rollback.confirm': '回滚到 {version} 会重启 DSH 服务，正在进行的会话会中断。',
      'settings.rollback.confirmAction': '确认回滚',
      'settings.rollback.cancel': '取消',
      'settings.rollback.installing': '正在安装 {version}',
      'settings.rollback.restarting': '正在重启服务',
      'settings.rollback.restartRequired': '已安装 {version}，需要手动重启 dsh 服务才能生效',
    };

    const en = {
      'badge.label': 'DSH version',
      'badge.checking': 'Checking',
      'badge.updateAvailable': 'Update available',
      'badge.installing': 'Updating',
      'badge.restartRequired': 'Restart required',
      'badge.error': 'Check failed',
      'panel.title': 'DSH version',
      'panel.current': 'Current version',
      'panel.latest': 'Latest version',
      'panel.channel': 'Channel',
      'panel.lastChecked': 'Last checked',
      'panel.never': 'Never checked',
      'panel.justNow': 'Just now',
      'panel.minutesAgo': '{count} min ago',
      'panel.hoursAgo': '{count} hr ago',
      'panel.daysAgo': '{count} days ago',
      'panel.status.upToDate': 'Up to date',
      'panel.status.notChecked': 'Not checked yet',
      'panel.status.updateAvailable': 'Update available',
      'panel.status.checking': 'Checking for updates',
      'panel.status.installing': 'Installing {version}',
      'panel.status.restarting': 'Restarting service',
      'panel.status.restartRequired': 'Installed {version}, restart DSH to apply',
      'panel.status.updated': 'Updated to {version}',
      'panel.status.error': 'Check failed',
      'panel.action.check': 'Check for updates',
      'panel.action.update': 'Update and restart',
      'panel.action.restart': 'Restart service',
      'panel.action.reload': 'Reload page',
      'panel.note.restart': 'Updating restarts the DSH service and interrupts running sessions',
      'panel.note.manualRestart': 'This deployment cannot restart automatically; restart dsh manually to apply the new version',
      'panel.note.autoOff': 'Automatic checking is off; you can still check manually, but updating requires re-enabling it',
      'panel.note.registry': 'Source: npm registry',
      'settings.nav': 'Version updates',
      'settings.description': 'Control DSH update checking, its automatic interval, and the release channel; you can also roll the main program back to an earlier published version',
      'settings.check.title': 'Check for updates',
      'settings.check.desc': 'When off, no scheduled checks and no updates; you can still check manually from the popover',
      'settings.interval.title': 'Auto-check interval',
      'settings.interval.desc': 'Time between automatic checks, from 1 to 10080 minutes',
      'settings.interval.unit': 'min',
      'settings.interval.invalid': 'Enter an integer number of minutes between 1 and 10080',
      'settings.channel.title': 'Release channel',
      'settings.channel.desc': 'Auto follows the installed version prerelease channel, or pin a npm dist-tag',
      'settings.channel.auto': 'Auto',
      'settings.save.saving': 'Saving',
      'settings.save.saved': 'Saved',
      'settings.loading': 'Loading settings',
      'settings.unavailable': 'The running Host does not expose the settings API; update the plugin and retry',
      'settings.rollback.title': 'Roll back DSH version',
      'settings.rollback.desc': 'Rolling back restarts the service and interrupts running sessions',
      'settings.rollback.loading': 'Loading published versions',
      'settings.rollback.error': 'Failed to load published versions: {message}',
      'settings.rollback.retry': 'Reload',
      'settings.rollback.pick': 'Choose a version',
      'settings.rollback.pickTitle': 'Choose a version to roll back to',
      'settings.rollback.empty': 'No published version older than the installed one',
      'settings.rollback.expand': 'Show all {count} versions',
      'settings.rollback.collapse': 'Show fewer',
      'settings.rollback.action': 'Roll back',
      'settings.rollback.confirm': 'Rolling back to {version} restarts the DSH service and interrupts running sessions.',
      'settings.rollback.confirmAction': 'Confirm rollback',
      'settings.rollback.cancel': 'Cancel',
      'settings.rollback.installing': 'Installing {version}',
      'settings.rollback.restarting': 'Restarting service',
      'settings.rollback.restartRequired': 'Installed {version}; restart dsh manually to apply',
    };

    function describeError(failure: unknown): string {
      return failure instanceof Error ? failure.message : String(failure);
    }

    // 共享状态源：apply 期间只创建一次，组件通过 useSyncExternalStore 订阅。
    function createVersionStore(): VersionStore {
      // 视图、订阅者与轮询句柄
      const listeners = new Set<() => void>();
      let view: VersionView = Object.freeze({
        snapshot: null, // 最近一次 GET /state 的 JSON
        offline: false, // 最近一次请求是否失败过
        actionError: null, // 动作失败时的可读文案
        busy: null, // 进行中的动作：check / update / rollback / restart / preferences
        lastAction: null, // 最近一次发起或结束的动作，用于把错误归到对应界面
        pendingTarget: null, // 用户点击更新时记录的目标版本
      });
      let timer: ReturnType<typeof setTimeout> | null = null;
      let running = false;

      // 发布新视图并通知订阅者
      const publish = (patch: Partial<VersionView>): void => {
        view = Object.freeze({ ...view, ...patch });
        for (const listener of [...listeners]) {
          listener();
        }
      };

      // 订阅接口，交给 useSyncExternalStore
      const subscribe = (listener: () => void): (() => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      };
      const getView = (): VersionView => view;

      // 读取 state；网络失败、非 2xx、响应不是 JSON 都记为离线并保留上一次数据。
      const readState = async (): Promise<void> => {
        try {
          const response = await fetch(STATE_PATH, {
            method: 'GET',
            headers: { accept: 'application/json' },
            cache: 'no-store',
          });
          if (!response.ok) {
            throw new Error(`GET ${STATE_PATH} 返回 HTTP ${response.status}`);
          }
          const snapshot = (await response.json()) as Snapshot;
          publish({ snapshot, offline: false });
        } catch {
          publish({ offline: true });
        }
      };

      // 轮询间隔按当前状态选择
      const pollDelay = (): number => {
        if (view.busy !== null) {
          return ACTIVE_POLL_MS;
        }
        if (view.offline) {
          return IDLE_POLL_MS;
        }
        const snapshot = view.snapshot;
        const phase = snapshot === null ? null : snapshot.phase;
        if (phase !== null && ACTIVE_PHASES.has(phase)) {
          return ACTIVE_POLL_MS;
        }
        // 暂停检查时 Host 不会再产生检查结果，按空闲间隔轮询
        if (snapshot !== null && snapshot.settings !== undefined && snapshot.settings.checkEnabled === false) {
          return IDLE_POLL_MS;
        }
        // 宿主刚重启时 latest 尚未查询，短间隔轮询到第一次检查结果；
        // registry 查询失败时 lastError 非空，回到常规间隔，避免持续高频请求
        if (snapshot === null) {
          return 3000;
        }
        if (snapshot.latest === null && snapshot.lastError === null) {
          return 3000;
        }
        return IDLE_POLL_MS;
      };

      // 轮询调度：一次请求结束后按间隔安排下一次
      const schedule = (): void => {
        if (!running) {
          return;
        }
        if (timer !== null) {
          clearTimeout(timer);
        }
        timer = setTimeout(() => {
          timer = null;
          void readState().then(schedule);
        }, pollDelay());
      };

      // 启停轮询
      const start = (): void => {
        if (running) {
          return;
        }
        running = true;
        void readState().then(schedule);
      };

      const stop = (): void => {
        running = false;
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
      };

      // 发送 POST；网络失败标记离线后继续抛给动作层，Host 返回的错误体解析出 message。
      const sendAction = async (path: string, body: unknown): Promise<Snapshot> => {
        let response: Response;
        try {
          response = await fetch(path, {
            method: 'POST',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify(body === null ? {} : body),
          });
        } catch (failure) {
          publish({ offline: true });
          throw failure;
        }
        const text = await response.text();
        const payload: unknown = text === '' ? null : JSON.parse(text);
        if (!response.ok) {
          const errorPayload = payload as { error?: { message?: string } } | null;
          const message =
            errorPayload !== null && errorPayload.error !== undefined && errorPayload.error !== null
              ? (errorPayload.error.message as string)
              : `POST ${path} 返回 HTTP ${response.status}`;
          throw new Error(message);
        }
        return payload as Snapshot;
      };

      // 执行动作并统一收尾：成功时刷新快照，失败时记录文案
      // 执行动作并统一收尾：成功时刷新快照，失败时记录文案
      const runAction = async (action: BusyAction, task: () => Promise<Snapshot>): Promise<void> => {
        if (view.busy !== null) {
          return;
        }
        publish({ busy: action, lastAction: action, actionError: null });
        try {
          const snapshot = await task();
          publish({ snapshot, offline: false, busy: null, actionError: null });
        } catch (failure) {
          publish({ busy: null, actionError: describeError(failure) });
        }
        schedule();
      };

      // 安装与重启阶段不接受强制检查，避免覆盖 Host 的状态机。
      const checkNow = (): Promise<void> => {
        const phase = view.snapshot === null ? null : view.snapshot.phase;
        if (phase !== null && ACTIVE_PHASES.has(phase)) {
          return Promise.resolve();
        }
        return runAction('check', () => sendAction(CHECK_PATH, null));
      };

      // 具体动作
      const startUpdate = (version: string): Promise<void> => {
        publish({ pendingTarget: version });
        return runAction('update', () => sendAction(UPDATE_PATH, { confirm: true, version }));
      };

      // 回滚与更新共用同一个 Host 安装状态机，只是目标版本更旧
      const rollbackTo = (version: string): Promise<void> =>
        runAction('rollback', () => sendAction(ROLLBACK_PATH, { confirm: true, version }));

      const restartService = (): Promise<void> =>
        runAction('restart', () => sendAction(RESTART_PATH, { confirm: true }));

      const savePreferences = (patch: PreferencesPatch): Promise<void> =>
        runAction('preferences', () => sendAction(PREFERENCES_PATH, patch));

      return {
        subscribe,
        getView,
        start,
        stop,
        checkNow,
        startUpdate,
        rollbackTo,
        restartService,
        savePreferences,
      };
    }

    // 内联 SVG 图标：圆形箭头。线条颜色继承文字颜色。
    function VersionIcon({ size }: { size: number }): unknown {
      return h(
        'svg',
        {
          className: 'dvc-icon',
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          'aria-hidden': true,
          focusable: false,
        },
        h('path', {
          d: 'M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z',
          fill: 'currentColor',
        }),
      );
    }

    // 上次检查时间的相对文案
    function formatLastChecked(t: Translate, lastCheckedAt: number | null): string {
      if (lastCheckedAt === null || lastCheckedAt === undefined) {
        return t('panel.never');
      }
      const elapsed = Date.now() - lastCheckedAt;
      const minutes = Math.floor(Math.max(0, elapsed) / 60000);
      if (minutes < 1) {
        return t('panel.justNow');
      }
      if (minutes < 60) {
        return t('panel.minutesAgo', { count: minutes });
      }
      const hours = Math.floor(minutes / 60);
      if (hours < 24) {
        return t('panel.hoursAgo', { count: hours });
      }
      return t('panel.daysAgo', { count: Math.floor(hours / 24) });
    }

    // 徽标组件：宽侧栏显示文字与状态，窄侧栏只显示图标与提示点。
    function VersionBadge({ wide, t, store }: { wide: boolean; t: Translate; store: VersionStore }): unknown {
      // 订阅共享状态并维护弹层开关
      const view = React.useSyncExternalStore(store.subscribe, store.getView);
      const [open, setOpen] = React.useState(false);
      const [anchor, setAnchor] = React.useState<PanelAnchor | null>(null);
      const rootRef = React.useRef<HTMLDivElement | null>(null);

      // 从快照推导展示状态
      const snapshot = view.snapshot;
      const phase = snapshot === null ? null : snapshot.phase;
      const installedVersion = snapshot === null ? null : snapshot.installedVersion;
      const latestVersion = snapshot === null || snapshot.latest === null ? null : snapshot.latest.version;
      const updateAvailable = snapshot !== null && snapshot.updateAvailable === true;
      const restartMode = snapshot === null ? null : snapshot.restartMode;
      const target =
        snapshot !== null && snapshot.target !== null
          ? snapshot.target
          : view.pendingTarget !== null
            ? view.pendingTarget
            : latestVersion;
      const installing = phase === 'installing';
      const restarting = phase === 'restarting';
      const restartRequired = phase === 'restart-required';
      const checking = view.busy === 'check' || phase === 'checking';
      // 重启完成后 Host 的 bootVersion 会变成目标版本，此时给出刷新页面入口
      const updatedTo =
        view.pendingTarget !== null &&
        snapshot !== null &&
        snapshot.bootVersion === view.pendingTarget &&
        snapshot.updateAvailable === false
          ? view.pendingTarget
          : null;
      const hostError = snapshot === null || snapshot.lastError === null ? null : snapshot.lastError.message;
      const checkEnabled = snapshot === null || snapshot.settings === undefined ? true : snapshot.settings.checkEnabled !== false;
      const paused = snapshot !== null && !checkEnabled;
      // 弹层只显示本弹层发起的动作错误；设置页保存与回滚的错误归各自界面
      const actionError =
        view.actionError !== null &&
        (view.lastAction === 'check' || view.lastAction === 'update' || view.lastAction === 'restart')
          ? view.actionError
          : null;
      const errorText =
        actionError !== null
          ? actionError
          : hostError !== null
            ? hostError
            : snapshot === null && view.offline
              ? t('panel.status.error')
              : null;

      // 面板贴住徽标上方，窗口尺寸或侧栏形态变化时重新计算
      React.useLayoutEffect(() => {
        if (!open) {
          return;
        }
        const place = (): void => {
          const root = rootRef.current;
          if (root === null) {
            return;
          }
          const rect = root.getBoundingClientRect();
          setAnchor({ left: rect.left, bottom: window.innerHeight - rect.top + 8 });
        };
        place();
        window.addEventListener('resize', place);
        return () => {
          window.removeEventListener('resize', place);
        };
      }, [open, wide]);

      // 点击面板外部或按下 Escape 关闭；打开面板只读状态，不触发检查
      React.useEffect(() => {
        if (!open) {
          return;
        }
        const onPointerDown = (event: PointerEvent): void => {
          const root = rootRef.current;
          if (root !== null && root.contains(event.target as Node | null)) {
            return;
          }
          setOpen(false);
        };
        const onKeyDown = (event: KeyboardEvent): void => {
          if (event.key === 'Escape') {
            setOpen(false);
          }
        };
        document.addEventListener('pointerdown', onPointerDown);
        document.addEventListener('keydown', onKeyDown);
        return () => {
          document.removeEventListener('pointerdown', onPointerDown);
          document.removeEventListener('keydown', onKeyDown);
        };
      }, [open]);

      // 徽标文案
      let badgeText: string;
      let badgeTone: string | null = null;
      let badgeDot = false;
      if (snapshot === null) {
        if (view.offline) {
          badgeText = t('badge.error');
          badgeTone = 'error';
        } else {
          badgeText = t('badge.checking');
        }
      } else if (checking) {
        badgeText = t('badge.checking');
      } else if (installing || restarting || view.busy === 'update') {
        badgeText = t('badge.installing');
      } else if (restartRequired) {
        badgeText = t('badge.restartRequired');
        badgeTone = 'update';
      } else if (paused) {
        // 关闭自动检查后侧边栏只显示当前版本，保持安静
        badgeText = installedVersion !== null ? installedVersion : t('badge.checking');
      } else if (updateAvailable) {
        badgeText = t('badge.updateAvailable');
        badgeTone = 'update';
        badgeDot = true;
      } else {
        badgeText = installedVersion !== null ? installedVersion : t('badge.checking');
      }

      // 面板状态胶囊
      let pillText: string;
      let pillTone: string | null = null;
      if (snapshot === null) {
        pillText = view.offline ? t('panel.status.error') : t('panel.status.checking');
        if (view.offline) {
          pillTone = 'error';
        }
      } else if (updatedTo !== null) {
        pillText = t('panel.status.updated', { version: updatedTo });
        pillTone = 'update';
      } else if (checking) {
        pillText = t('panel.status.checking');
      } else if (installing) {
        pillText = t('panel.status.installing', { version: target === null ? '' : target });
      } else if (restarting) {
        pillText = t('panel.status.restarting');
      } else if (restartRequired) {
        pillText = t('panel.status.restartRequired', { version: installedVersion === null ? '' : installedVersion });
        pillTone = 'update';
      } else if (errorText !== null) {
        pillText = t('panel.status.error');
        pillTone = 'error';
      } else if (updateAvailable) {
        pillText = t('panel.status.updateAvailable');
        pillTone = 'update';
      } else if (latestVersion === null) {
        pillText = t('panel.status.notChecked');
      } else {
        pillText = t('panel.status.upToDate');
      }

      // 版本信息行
      const bodyChildren: unknown[] = [];

      bodyChildren.push(
        h(
          'div',
          { className: 'dvc-version-row', key: 'version' },
          h(
            'span',
            { className: 'dvc-version-block' },
            h('span', { className: 'dvc-version-label' }, t('panel.current')),
            h('span', { className: 'dvc-version' }, installedVersion !== null ? installedVersion : '--'),
          ),
          h('span', { className: 'dvc-pill', 'data-tone': pillTone === null ? undefined : pillTone }, pillText),
        ),
      );

      bodyChildren.push(h('div', { className: 'dvc-divider', key: 'divider-top' }));

      bodyChildren.push(
        h(
          'div',
          { className: 'dvc-row', key: 'latest' },
          h('span', { className: 'dvc-row-label' }, t('panel.latest')),
          h('span', { className: 'dvc-row-value' }, latestVersion !== null ? latestVersion : '--'),
        ),
      );
      bodyChildren.push(
        h(
          'div',
          { className: 'dvc-row', key: 'channel' },
          h('span', { className: 'dvc-row-label' }, t('panel.channel')),
          h(
            'span',
            { className: 'dvc-row-value' },
            snapshot !== null && snapshot.channel !== null ? snapshot.channel : '--',
          ),
        ),
      );
      bodyChildren.push(
        h(
          'div',
          { className: 'dvc-row', key: 'checked' },
          h('span', { className: 'dvc-row-label' }, t('panel.lastChecked')),
          h(
            'span',
            { className: 'dvc-row-value' },
            formatLastChecked(t, snapshot === null ? null : snapshot.lastCheckedAt),
          ),
        ),
      );

      bodyChildren.push(h('div', { className: 'dvc-divider', key: 'divider-bottom' }));

      // 错误与安装进度
      if (errorText !== null) {
        bodyChildren.push(h('p', { className: 'dvc-error', key: 'error', role: 'alert' }, errorText));
      }

      if (installing || restarting) {
        const progressText = installing
          ? t('panel.status.installing', { version: target === null ? '' : target })
          : t('panel.status.restarting');
        bodyChildren.push(h('p', { className: 'dvc-progress', key: 'progress' }, progressText));
        const installOutput = snapshot === null || snapshot.installOutput === null ? null : snapshot.installOutput;
        if (installOutput !== null) {
          bodyChildren.push(h('p', { className: 'dvc-output', key: 'output' }, installOutput));
        }
      }

      // 动作按钮：刷新、检查、重启与更新
      const actionButtons: unknown[] = [];
      if (updatedTo !== null) {
        actionButtons.push(
          h(
            'button',
            {
              key: 'reload',
              type: 'button',
              className: 'dvc-button',
              'data-primary': true,
              onClick: () => {
                window.location.reload();
              },
            },
            t('panel.action.reload'),
          ),
        );
      } else {
        const actionsDisabled = view.busy !== null || installing || restarting;
        actionButtons.push(
          h(
            'button',
            {
              key: 'check',
              type: 'button',
              className: 'dvc-button',
              disabled: actionsDisabled,
              onClick: () => {
                void store.checkNow();
              },
            },
            t('panel.action.check'),
          ),
        );
        if (restartRequired && restartMode === 'systemd') {
          actionButtons.push(
            h(
              'button',
              {
                key: 'restart',
                type: 'button',
                className: 'dvc-button',
                'data-primary': true,
                disabled: actionsDisabled,
                onClick: () => {
                  void store.restartService();
                },
              },
              t('panel.action.restart'),
            ),
          );
        } else if (updateAvailable && checkEnabled && latestVersion !== null && !installing && !restarting) {
          actionButtons.push(
            h(
              'button',
              {
                key: 'update',
                type: 'button',
                className: 'dvc-button',
                'data-primary': true,
                disabled: actionsDisabled,
                onClick: () => {
                  void store.startUpdate(latestVersion);
                },
              },
              t('panel.action.update'),
            ),
          );
        }
      }

      // 底部说明
      if (actionButtons.length > 0) {
        bodyChildren.push(h('div', { className: 'dvc-actions', key: 'actions' }, actionButtons));
      }
      if (paused && !restartRequired) {
        bodyChildren.push(h('p', { className: 'dvc-note', key: 'note-auto-off' }, t('panel.note.autoOff')));
        bodyChildren.push(h('p', { className: 'dvc-note', key: 'note-registry' }, t('panel.note.registry')));
      } else {
        bodyChildren.push(
          h(
            'p',
            { className: 'dvc-note', key: 'note-restart' },
            restartRequired && restartMode === 'manual' ? t('panel.note.manualRestart') : t('panel.note.restart'),
          ),
        );
        bodyChildren.push(h('p', { className: 'dvc-note', key: 'note-registry' }, t('panel.note.registry')));
      }

      // 弹层
      const panel =
        open && anchor !== null
          ? h(
              'section',
              {
                key: 'panel',
                className: 'dvc-panel',
                style: anchor,
                role: 'dialog',
                'aria-label': t('panel.title'),
              },
              h('header', { className: 'dvc-header' }, h('span', { className: 'dvc-title' }, t('panel.title'))),
              h('div', { className: 'dvc-body' }, bodyChildren),
            )
          : null;

      const ariaLabel = `${t('badge.label')} ${badgeText}`;
      const iconSize = wide ? 16 : 18;

      return h(
        'div',
        { className: wide ? 'dvc-layer' : 'dvc-layer dvc-rail', ref: rootRef },
        panel,
        h(
          'button',
          {
            type: 'button',
            className: 'dvc-badge',
            'aria-label': ariaLabel,
            'aria-haspopup': 'dialog',
            'aria-expanded': open,
            'data-active': open ? true : undefined,
            onClick: () => {
              setOpen((value) => !value);
            },
          },
          h(VersionIcon, { size: iconSize }),
          wide
            ? [
                h('span', { className: 'dvc-label', key: 'label' }, t('badge.label')),
                h(
                  'span',
                  {
                    className: 'dvc-value',
                    key: 'value',
                    'data-tone': badgeTone === null ? undefined : badgeTone,
                  },
                  badgeDot ? h('span', { className: 'dvc-dot', key: 'dot', 'aria-hidden': true }) : null,
                  badgeText,
                ),
              ]
            : null,
          wide ? null : badgeDot ? h('span', { className: 'dvc-rail-dot', key: 'dot', 'aria-hidden': true }) : null,
        ),
      );
    }

    // 设置页的固定选项与间隔范围，与 Host 侧的校验保持一致
    const INTERVAL_MIN = 1;
    const INTERVAL_MAX = 10080;
    const CHANNEL_OPTIONS = ['auto', 'latest', 'next', 'alpha'];

    // 回滚列表默认展示的版本数量，超出的版本通过展开显示
    const DEFAULT_VISIBLE_ROLLBACK_VERSIONS = 5;

    // 回滚版本框的尺寸，定位与内容滚动都按这个尺寸计算
    const ROLLBACK_POPOVER_WIDTH = 320;
    const ROLLBACK_POPOVER_HEIGHT = 360;

    // 设置页：更新检查开关、自动检查间隔与发布渠道。
    function VersionCheckSettings({ t, store }: { t: Translate; store: VersionStore }): unknown {
      // 订阅共享状态并维护输入草稿
      const view = React.useSyncExternalStore(store.subscribe, store.getView);
      const snapshot = view.snapshot;
      const settings = snapshot === null || snapshot.settings === undefined ? null : snapshot.settings;
      const [intervalDraft, setIntervalDraft] = React.useState('');
      const [intervalError, setIntervalError] = React.useState(false);
      const [saved, setSaved] = React.useState(false);
      const savedTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

      // 保存后 Host 回写设置，同步输入框
      const intervalValue = settings === null ? null : settings.checkIntervalMinutes;
      React.useEffect(() => {
        if (intervalValue === null) {
          return;
        }
        setIntervalDraft(String(intervalValue));
        setIntervalError(false);
      }, [intervalValue]);

      // 卸载时清理保存提示的定时器
      React.useEffect(
        () => () => {
          if (savedTimer.current !== null) {
            clearTimeout(savedTimer.current);
            savedTimer.current = null;
          }
        },
        [],
      );

      const busy = view.busy === 'preferences';
      const controlsDisabled = settings === null || view.busy !== null;

      // 保存成功后的短暂提示
      const markSaved = (): void => {
        setSaved(true);
        if (savedTimer.current !== null) {
          clearTimeout(savedTimer.current);
        }
        savedTimer.current = setTimeout(() => {
          savedTimer.current = null;
          setSaved(false);
        }, 2000);
      };

      const save = async (patch: PreferencesPatch, silent = false): Promise<void> => {
        setSaved(false);
        await store.savePreferences(patch);
        const next = store.getView();
        if (!silent && next.actionError === null && next.busy === null) {
          markSaved();
        }
      };

      // 三个设置项的事件处理；开关状态本身可见，保存后不提示已保存
      const toggleCheck = (): void => {
        if (settings === null || controlsDisabled) {
          return;
        }
        void save({ checkEnabled: !settings.checkEnabled }, true);
      };

      const commitInterval = (): void => {
        if (settings === null || controlsDisabled) {
          return;
        }
        const text = intervalDraft.trim();
        const value = Number(text);
        if (!/^\d+$/.test(text) || value < INTERVAL_MIN || value > INTERVAL_MAX) {
          setIntervalError(true);
          return;
        }
        setIntervalError(false);
        if (value === settings.checkIntervalMinutes) {
          return;
        }
        void save({ checkIntervalMinutes: value });
      };

      const pickChannel = (event: { currentTarget: { value: string } }): void => {
        if (settings === null || controlsDisabled) {
          return;
        }
        void save({ channel: event.currentTarget.value });
      };

      // 保存反馈文案
      let feedback = '';
      let feedbackTone: string | undefined;
      if (view.actionError !== null && view.lastAction === 'preferences') {
        feedback = view.actionError;
        feedbackTone = 'error';
      } else if (busy) {
        feedback = t('settings.save.saving');
      } else if (saved) {
        feedback = t('settings.save.saved');
      }

      // 设置行
      const rows: unknown[] = [];
      if (settings === null) {
        rows.push(
          h(
            'div',
            { className: 'dvc-settings-row', key: 'loading' },
            h(
              'span',
              { className: 'dvc-settings-rowDesc' },
              snapshot === null ? t('settings.loading') : t('settings.unavailable'),
            ),
          ),
        );
      } else {
        rows.push(
          h(
            'div',
            { className: 'dvc-settings-row', key: 'check' },
            h(
              'div',
              { className: 'dvc-settings-rowText' },
              h('span', { className: 'dvc-settings-rowTitle' }, t('settings.check.title')),
              h('span', { className: 'dvc-settings-rowDesc' }, t('settings.check.desc')),
            ),
            h(
              'button',
              {
                type: 'button',
                role: 'switch',
                className: 'dvc-switch',
                'aria-checked': settings.checkEnabled ? 'true' : 'false',
                'aria-label': t('settings.check.title'),
                disabled: controlsDisabled,
                onClick: toggleCheck,
              },
              h('span', { className: 'dvc-switchThumb' }),
            ),
          ),
        );
        rows.push(
          h(
            'div',
            { className: 'dvc-settings-row', key: 'interval' },
            h(
              'div',
              { className: 'dvc-settings-rowText' },
              h('span', { className: 'dvc-settings-rowTitle' }, t('settings.interval.title')),
              h('span', { className: 'dvc-settings-rowDesc' }, t('settings.interval.desc')),
            ),
            h(
              'div',
              { className: 'dvc-settings-control' },
              h('input', {
                className: 'dvc-settings-input',
                type: 'number',
                inputMode: 'numeric',
                min: INTERVAL_MIN,
                max: INTERVAL_MAX,
                step: 1,
                value: intervalDraft,
                'aria-label': t('settings.interval.title'),
                'aria-invalid': intervalError ? 'true' : undefined,
                disabled: controlsDisabled,
                onChange: (event: { currentTarget: { value: string } }) => {
                  setIntervalError(false);
                  setIntervalDraft(event.currentTarget.value);
                },
                onBlur: commitInterval,
                onKeyDown: (event: { key: string; preventDefault(): void }) => {
                  if (event.key !== 'Enter') {
                    return;
                  }
                  event.preventDefault();
                  commitInterval();
                },
              }),
              h('span', { className: 'dvc-settings-unit' }, t('settings.interval.unit')),
            ),
          ),
        );
        if (intervalError) {
          rows.push(
            h(
              'p',
              { className: 'dvc-settings-feedback', key: 'interval-error', role: 'alert', 'data-tone': 'error' },
              t('settings.interval.invalid'),
            ),
          );
        }
        const channels = CHANNEL_OPTIONS.includes(settings.channel)
          ? CHANNEL_OPTIONS
          : [...CHANNEL_OPTIONS, settings.channel];
        rows.push(
          h(
            'div',
            { className: 'dvc-settings-row', key: 'channel' },
            h(
              'div',
              { className: 'dvc-settings-rowText' },
              h('span', { className: 'dvc-settings-rowTitle' }, t('settings.channel.title')),
              h('span', { className: 'dvc-settings-rowDesc' }, t('settings.channel.desc')),
            ),
            h(
              'select',
              {
                className: 'dvc-settings-select',
                value: settings.channel,
                'aria-label': t('settings.channel.title'),
                disabled: controlsDisabled,
                onChange: pickChannel,
              },
              channels.map((channel) =>
                h(
                  'option',
                  { value: channel, key: channel },
                  channel === 'auto' ? t('settings.channel.auto') : channel,
                ),
              ),
            ),
          ),
        );
      }

      return h(
        'div',
        { className: 'dvc-settings' },
        h('p', { className: 'dvc-settings-blurb' }, t('settings.description')),
        rows,
        feedback === ''
          ? null
          : h(
              'p',
              {
                className: 'dvc-settings-feedback',
                key: 'feedback',
                role: 'status',
                'data-tone': feedbackTone === undefined ? undefined : feedbackTone,
              },
              feedback,
            ),
        h(RollbackSection, { t, store, key: 'rollback' }),
      );
    }

    /** 把 ISO 时间格式化为本地年月日。 */
    function formatPublishDate(value: string | null): string {
      if (value === null) {
        return '';
      }
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) {
        return '';
      }

      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${date.getFullYear()}-${month}-${day}`;
    }

    // 设置页的回滚区域：点击按钮弹出候选版本框，确认后降级。
    function RollbackSection({ t, store }: { t: Translate; store: VersionStore }): unknown {
      // 订阅共享状态
      const view = React.useSyncExternalStore(store.subscribe, store.getView);
      const snapshot = view.snapshot;
      const bootVersion = snapshot === null ? null : snapshot.bootVersion;
      const installedVersion = snapshot === null ? null : snapshot.installedVersion;
      const phase = snapshot === null ? null : snapshot.phase;
      const target = snapshot === null ? null : snapshot.target;

      // 版本框开关与锚点、候选版本、待确认的目标
      const [open, setOpen] = React.useState(false);
      const [anchor, setAnchor] = React.useState<PopoverAnchor | null>(null);
      const triggerRef = React.useRef<HTMLButtonElement | null>(null);
      const popoverRef = React.useRef<HTMLElement | null>(null);
      const [status, setStatus] = React.useState<'loading' | 'ready' | 'error'>('loading');
      const [versions, setVersions] = React.useState<RollbackVersion[]>([]);
      const [loadError, setLoadError] = React.useState<string | null>(null);
      const [pending, setPending] = React.useState<string | null>(null);
      const [reloadToken, setReloadToken] = React.useState(0);
      const [expanded, setExpanded] = React.useState(false);

      // 打开版本框时读取候选列表
      React.useEffect(() => {
        if (!open) {
          return;
        }
        let cancelled = false;
        setStatus('loading');
        setLoadError(null);
        setPending(null);
        setExpanded(false);
        void (async () => {
          try {
            const response = await fetch(VERSIONS_PATH, {
              method: 'GET',
              headers: { accept: 'application/json' },
              cache: 'no-store',
            });
            const text = await response.text();
            const payload: unknown = text === '' ? null : JSON.parse(text);
            if (!response.ok) {
              const failure = payload as { error?: { message?: string } } | null;
              const message =
                failure !== null && failure.error !== undefined && failure.error !== null
                  ? (failure.error.message as string)
                  : `GET ${VERSIONS_PATH} 返回 HTTP ${response.status}`;
              throw new Error(message);
            }
            if (cancelled) {
              return;
            }
            const parsed = payload as VersionsResponse;
            setVersions(Array.isArray(parsed.versions) ? parsed.versions : []);
            setStatus('ready');
          } catch (failure) {
            if (cancelled) {
              return;
            }
            setLoadError(describeError(failure));
            setStatus('error');
          }
        })();

        return () => {
          cancelled = true;
        };
      }, [open, reloadToken]);

      // 版本框贴住触发按钮，页面滚动或窗口尺寸变化时重新定位
      React.useLayoutEffect(() => {
        if (!open) {
          return;
        }
        const place = (): void => {
          const trigger = triggerRef.current;
          if (trigger === null) {
            return;
          }
          const rect = trigger.getBoundingClientRect();
          const left = Math.max(
            8,
            Math.min(rect.right - ROLLBACK_POPOVER_WIDTH, window.innerWidth - ROLLBACK_POPOVER_WIDTH - 8),
          );
          const below = rect.bottom + 6;
          const top =
            below + ROLLBACK_POPOVER_HEIGHT <= window.innerHeight - 8
              ? below
              : Math.max(8, rect.top - ROLLBACK_POPOVER_HEIGHT - 6);
          setAnchor({ top, left });
        };
        place();
        window.addEventListener('resize', place);
        document.addEventListener('scroll', place, true);
        return () => {
          window.removeEventListener('resize', place);
          document.removeEventListener('scroll', place, true);
        };
      }, [open]);

      // 点击版本框外部或按 Escape 关闭
      React.useEffect(() => {
        if (!open) {
          return;
        }
        const onPointerDown = (event: PointerEvent): void => {
          const targetNode = event.target as Node | null;
          if (targetNode === null) {
            return;
          }
          if (popoverRef.current !== null && popoverRef.current.contains(targetNode)) {
            return;
          }
          if (triggerRef.current !== null && triggerRef.current.contains(targetNode)) {
            return;
          }
          setOpen(false);
        };
        const onKeyDown = (event: KeyboardEvent): void => {
          if (event.key === 'Escape') {
            setOpen(false);
          }
        };
        document.addEventListener('pointerdown', onPointerDown);
        document.addEventListener('keydown', onKeyDown);
        return () => {
          document.removeEventListener('pointerdown', onPointerDown);
          document.removeEventListener('keydown', onKeyDown);
        };
      }, [open]);

      // 安装或重启期间禁止再次触发
      const busy = view.busy !== null || phase === 'installing' || phase === 'restarting';
      const hostError = snapshot === null || snapshot.lastError === null ? null : snapshot.lastError.message;
      const actionError = view.actionError !== null && view.lastAction === 'rollback' ? view.actionError : null;
      let progressText: string | null = null;
      if (phase === 'installing') {
        progressText = t('settings.rollback.installing', { version: target === null ? '' : target });
      } else if (phase === 'restarting') {
        progressText = t('settings.rollback.restarting');
      } else if (phase === 'restart-required' && installedVersion !== bootVersion) {
        progressText = t('settings.rollback.restartRequired', {
          version: installedVersion === null ? '' : installedVersion,
        });
      }

      // 默认只渲染最近的一批版本，展开后渲染全部
      const visibleVersions = expanded ? versions : versions.slice(0, DEFAULT_VISIBLE_ROLLBACK_VERSIONS);

      // 版本框内容：读取状态、候选列表或回滚确认
      const content: unknown[] = [];
      if (status === 'loading') {
        content.push(h('p', { className: 'dvc-settings-feedback', key: 'loading' }, t('settings.rollback.loading')));
      } else if (status === 'error') {
        content.push(
          h(
            'p',
            { className: 'dvc-settings-feedback', key: 'load-error', role: 'alert', 'data-tone': 'error' },
            t('settings.rollback.error', { message: loadError === null ? '' : loadError }),
          ),
        );
        content.push(
          h(
            'button',
            {
              type: 'button',
              className: 'dvc-button',
              key: 'retry',
              disabled: busy,
              onClick: () => {
                setReloadToken((value) => value + 1);
              },
            },
            t('settings.rollback.retry'),
          ),
        );
      } else if (versions.length === 0) {
        content.push(h('p', { className: 'dvc-settings-feedback', key: 'empty' }, t('settings.rollback.empty')));
      } else if (pending !== null) {
        content.push(
          h(
            'p',
            { className: 'dvc-rollback-confirmText', key: 'confirm-text' },
            t('settings.rollback.confirm', { version: pending }),
          ),
        );
        content.push(
          h(
            'div',
            { className: 'dvc-rollback-confirmActions', key: 'confirm-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'dvc-button',
                onClick: () => {
                  setPending(null);
                },
              },
              t('settings.rollback.cancel'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dvc-button',
                'data-primary': true,
                disabled: busy,
                onClick: () => {
                  const version = pending;
                  setPending(null);
                  setOpen(false);
                  void store.rollbackTo(version);
                },
              },
              t('settings.rollback.confirmAction'),
            ),
          ),
        );
      } else {
        content.push(
          h(
            'div',
            { className: 'dvc-rollback-list', key: 'list' },
            visibleVersions.map((entry) =>
              h(
                'div',
                { className: 'dvc-rollback-row', key: entry.version },
                h('span', { className: 'dvc-rollback-version' }, entry.version),
                h('span', { className: 'dvc-rollback-date' }, formatPublishDate(entry.publishedAt)),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dvc-button',
                    disabled: busy,
                    onClick: () => {
                      setPending(entry.version);
                    },
                  },
                  t('settings.rollback.action'),
                ),
              ),
            ),
          ),
        );
      }

      // 展开更多版本，展开后的列表在版本框内滚动
      const toggle =
        status === 'ready' && pending === null && versions.length > DEFAULT_VISIBLE_ROLLBACK_VERSIONS
          ? h(
              'button',
              {
                type: 'button',
                className: 'dvc-button dvc-rollback-toggle',
                key: 'toggle',
                disabled: busy,
                onClick: () => {
                  setExpanded((value) => !value);
                },
              },
              expanded
                ? t('settings.rollback.collapse')
                : t('settings.rollback.expand', { count: versions.length }),
            )
          : null;

      // 状态与错误提示
      const notices: unknown[] = [];
      if (actionError !== null) {
        notices.push(h('p', { className: 'dvc-error', key: 'action-error', role: 'alert' }, actionError));
      } else if (hostError !== null && phase === 'error') {
        notices.push(h('p', { className: 'dvc-error', key: 'host-error', role: 'alert' }, hostError));
      }
      if (progressText !== null) {
        notices.push(h('p', { className: 'dvc-note', key: 'progress' }, progressText));
      }

      // 版本框
      const popover =
        open && anchor !== null
          ? h(
              'section',
              {
                key: 'popover',
                className: 'dvc-rollback-popover',
                style: anchor,
                role: 'dialog',
                'aria-label': t('settings.rollback.pickTitle'),
                ref: popoverRef,
              },
              h(
                'header',
                { className: 'dvc-rollback-popoverHeader' },
                h('span', { className: 'dvc-rollback-popoverTitle' }, t('settings.rollback.pickTitle')),
              ),
              h('div', { className: 'dvc-rollback-popoverBody' }, content),
              toggle === null ? null : h('div', { className: 'dvc-rollback-popoverFooter' }, toggle),
            )
          : null;

      return h(
        'div',
        { className: 'dvc-settings-section' },
        h(
          'div',
          { className: 'dvc-rollback-header' },
          h('span', { className: 'dvc-settings-rowTitle' }, t('settings.rollback.title')),
          h(
            'div',
            { className: 'dvc-rollback-picker' },
            h(
              'button',
              {
                ref: triggerRef,
                type: 'button',
                className: 'dvc-button dvc-rollback-pick',
                'aria-haspopup': 'dialog',
                'aria-expanded': open,
                disabled: busy,
                onClick: () => {
                  setOpen((value) => !value);
                },
              },
              t('settings.rollback.pick'),
            ),
            popover,
          ),
        ),
        h('p', { className: 'dvc-settings-rowDesc' }, t('settings.rollback.desc')),
        notices,
        h('p', { className: 'dvc-note' }, t('panel.note.registry')),
      );
    }

    function apply(ctx: ClientContext): void {
      // 注册中英文词典
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-version-check: dictionaries');
      const t = ctx.locale.bind(NS);

      // 共享状态源与轮询
      const store = createVersionStore();
      ctx.effect(() => {
        store.start();
        return () => {
          store.stop();
        };
      }, 'dsh-version-check: state polling');

      // 侧边栏底部徽标
      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register(
          {
            name: 'sidebar.footer.action',
            id: 'dsh-version-check',
            order: 1000,
            locale: NS,
            inject: () => ({ store }),
          },
          VersionBadge,
        ),
      );

      // 设置页
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'dsh-version-check',
            order: 55,
            label: () => t('settings.nav'),
            locale: NS,
            inject: () => ({ store }),
          },
          VersionCheckSettings,
        ),
      );
    }

    return { inject, apply };
  },
});
