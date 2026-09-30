/**
 * desktop-install.mjs — 桌面端（Electron）DSH 安装的发现与共用依赖仓库的**只读**体检。
 *
 * ## 这个仓库是什么，以及为什么不能「对齐」它
 *
 * `~/.dsh/profiles/node_modules` 是补丁的**共用宿主依赖仓库**：补丁的宿主端
 * `import '@deepseek-ai/*'` 由 Node 从补丁的真实路径解析（`patches/<name>/node_modules`
 * 是指向该仓库的 junction），所以这里是唯一回答它们的地方。仓库里的
 * `@deepseek-ai/*` 是一整套 junction，指向**当初创建它的那套 dsh 安装**
 * （历史上是 npx 缓存里的 CLI，0.1.5-rc.2）。
 *
 * 桌面端的宿主是打包运行时 `resources/app.asar/dsh`（0.2.0-rc.2）。曾经尝试把仓库
 * 「对齐」到它，**三条路都被实测证否**：
 *
 * 1. **junction 指向 asar 内路径不可用**：Windows 建得出这种链接，但 Electron 的 asar
 *    兼容层只认 `.../app.asar/...` 形式的路径，经 junction 解析后的路径它认不出来，
 *    `readFileSync` 直接 ENOENT（实测：直连可读、经链接不可读）。
 * 2. **物化到磁盘同样不可取**：`cpSync` 走原生调用、对 asar 直接 ENOENT；即便逐文件
 *    复制，整个 `@deepseek-ai` 作用域是 **236 MB**。
 * 3. **删掉投影让宿主代答也不行**：运行时拦截层只解释**裸包名**的解析，不代答模块图
 *    之外的真实路径导入；删掉后补丁的 import 直接 MODULE_NOT_FOUND（实测）。
 *
 * 所以本模块只做两件事：**发现**正在运行的桌面端安装，以及**体检**仓库现状
 * （每条投影是否真的可用）。它绝不修改任何链接——这正是它的价值所在。
 *
 * ## 仓库应当被建成什么
 *
 * 既然「指向打包运行时」不可行，正确的做法是让仓库**按桌面端那个版本重建**：
 * 在 `profiles/` 目录里装 `@deepseek-ai/dsh`、`@deepseek-ai/dsh-llm`、
 * `@deepseek-ai/schemastery`（版本与该 release 对齐），然后用仓库自己的 `.pnpm`
 * 为 `@deepseek-ai/*` 补回顶层投影。这样补丁的宿主端 import 拿到的就是与宿主**同一
 * 版本**的包（本仓库当前即为 0.2.0-rc.2，实测三个 import 全部解析成功）。
 *
 * 体检结果里 `broken` 非空时，就按上面这条路重建；不要试图把链接指回某个旧的
 * npx 缓存，那个缓存会被 npm 清空（本项目就经历过一次：整套 `@deepseek-ai` 被清空，
 * 让 247 条投影同时变成断链）。
 */

import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** 共用的宿主依赖仓库：profiles 树下的 node_modules。 */
export function defaultStoreDir(home = homedir()) {
  return join(home, '.dsh', 'profiles', 'node_modules');
}

/**
 * 一个 DSH 安装的路径分解。
 * @param installRoot 安装根目录（含 `DeepSeek Harness.exe`）
 * @returns 资源目录、打包运行时目录与作用域目录
 */
export function installationPaths(installRoot) {
  const root = resolve(installRoot);
  const resources = join(root, 'resources');
  const runtimeDir = join(resources, 'app.asar', 'dsh');
  return {
    installRoot: root,
    resources,
    runtimeDir,
    runtimeModules: join(runtimeDir, 'node_modules'),
    runtimeScope: join(runtimeDir, 'node_modules', '@deepseek-ai'),
  };
}

/**
 * 判断一个目录是否是一套可用的桌面端安装。
 *
 * 注意：必须在**桌面端自带的 Electron** 下以 `ELECTRON_RUN_AS_NODE=1` 调用，否则
 * 普通 node 看不见 `app.asar` 内的文件，本函数会一律返回 undefined。
 *
 * @param installRoot 待判定的目录
 * @returns 该安装的路径分解，或 undefined
 */
export function asInstallation(installRoot) {
  if (typeof installRoot !== 'string' || installRoot === '') return undefined;
  const paths = installationPaths(installRoot);
  if (!existsSync(join(paths.runtimeScope, 'dsh', 'package.json'))) return undefined;
  return paths;
}

/**
 * 从命令行里取 `--app-path=` 的值（Electron 渲染进程会带上它）。
 * @param commandLine 进程命令行
 * @returns 去掉尾部 `app.asar` 后的 resources 目录，取不到时 undefined
 */
export function appPathFromCommandLine(commandLine) {
  if (typeof commandLine !== 'string') return undefined;
  // 值可能带引号（路径含空格），也可能不带；两种情况都在首个空白处结束，
  // 因此不能用「贪婪到下一个 flag」的写法，否则会把 `--` 吞进路径。
  const match = /--app-path=("[^"]*"|\S*)/u.exec(commandLine);
  if (match === null || match[1] === '') return undefined;
  const appPath = match[1].replace(/^"|"$/gu, '').replace(/[\\/]+$/u, '');
  return appPath.toLowerCase().endsWith('app.asar') ? dirname(appPath) : appPath;
}

/**
 * 从命令行里取可执行文件路径。
 * @param commandLine 进程命令行
 * @returns 首个带引号的 token，取不到时 undefined
 */
export function executableFromCommandLine(commandLine) {
  if (typeof commandLine !== 'string') return undefined;
  // 只认带引号的形态：桌面端主进程一定以 `"C:\...\DeepSeek Harness.exe"` 开头，
  // 而无引号形态在路径含空格时无法与后续 flag 划界，猜出来的路径比没有更糟。
  const match = /^\s*"([^"]+)"/u.exec(commandLine);
  return match === null ? undefined : match[1];
}

/**
 * 在候选路径中挑出第一套可用的桌面端安装。
 * @param candidates `{ value, source }` 列表
 * @returns 找到的安装路径分解与来源，全部不可用时 undefined
 */
export function pickInstallation(candidates) {
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    const paths = asInstallation(candidate.value);
    if (paths !== undefined) return { ...paths, source: candidate.source };
  }
  return undefined;
}

/** 缺省候选安装位置（Windows 安装器默认落在 LOCALAPPDATA）。 */
export function defaultCandidates() {
  const local = process.env.LOCALAPPDATA;
  const programFiles = process.env.ProgramFiles;
  const candidates = [];
  if (typeof local === 'string' && local !== '') {
    candidates.push({ value: join(local, 'Programs', 'DeepSeek Harness'), source: 'localappdata' });
  }
  if (typeof programFiles === 'string' && programFiles !== '') {
    candidates.push({ value: join(programFiles, 'DeepSeek Harness'), source: 'programfiles' });
  }
  return candidates;
}

/** 读取一套安装自带的 dsh 包版本。 */
export function installationVersion(paths) {
  try {
    const manifest = JSON.parse(readFileSync(join(paths.runtimeScope, 'dsh', 'package.json'), 'utf8'));
    return typeof manifest.version === 'string' ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 列出仓库里 `@deepseek-ai` 作用域下的投影条目。
 *
 * 用 `lstatSync` 而不是 `dirent.isDirectory()`：Windows 上 NTFS junction 在
 * `withFileTypes` 里既不是符号链接也不是目录，用 dirent 判定会把**全部** junction
 * 静默丢掉。`lstatSync` 不跟随链接，因此断链的条目仍会被列出并计入体检结果。
 *
 * @param storeDir 共用宿主依赖仓库
 * @returns 名称升序的 `{ name, path }` 列表
 */
export function inventoryScope(storeDir) {
  const scope = join(storeDir, '@deepseek-ai');
  if (!existsSync(scope)) return [];
  return readdirSync(scope, { withFileTypes: true })
    .map(entry => ({ name: entry.name, path: join(scope, entry.name) }))
    .filter(entry => lstatSync(entry.path, { throwIfNoEntry: false }) !== undefined)
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** 解析链接的最终目标；断链或普通目录返回 undefined。 */
function canonicalTarget(path) {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/**
 * 体检：仓库里的每条投影是否**真的能被 Node 解析**。
 *
 * 判定只做一件事：`<投影>/package.json` 能否读到。这一条能同时抓住断链、指向
 * `app.asar` 内部的链接（Electron 的 asar 层不认这种二次解析路径），以及空目录。
 * 结果是**只读**的，不会修改任何链接。
 *
 * @param options.storeDir 共用宿主依赖仓库
 * @returns `{ entries, usable, broken, asarLinked, probe }`
 */
export function inspectStore({ storeDir = defaultStoreDir() } = {}) {
  const entries = inventoryScope(storeDir);
  const usable = [];
  const broken = [];
  const asarLinked = [];
  for (const entry of entries) {
    const target = canonicalTarget(entry.path) ?? null;
    const rawTarget = target ?? readLinkTarget(entry.path);
    if (rawTarget !== null && rawTarget.includes('app.asar')) asarLinked.push({ ...entry, target: rawTarget });
    if (existsSync(join(entry.path, 'package.json'))) usable.push({ ...entry, target: rawTarget });
    else broken.push({ ...entry, target: rawTarget });
  }
  return {
    storeDir,
    entries: entries.length,
    usable,
    broken,
    asarLinked,
    probe: PROBE_PACKAGES.map(name => probePackage(storeDir, name)),
  };
}

/** 读取链接的原始目标（不做最终解析），断链/普通目录返回 null。 */
function readLinkTarget(path) {
  try {
    if (!lstatSync(path).isSymbolicLink()) return null;
    // realpathSync 已失败时退回读取 reparse point 的目标。
    return readlinkSync(path);
  } catch {
    return null;
  }
}

/** 补丁宿主端真正会 import 的包：它们必须可解析，否则补丁加载即失败。 */
export const PROBE_PACKAGES = ['@deepseek-ai/schemastery', '@deepseek-ai/dsh-llm'];

/** 体检一个包是否可解析（只读）。 */
function probePackage(storeDir, name) {
  const path = join(storeDir, ...name.split('/'));
  let version = undefined;
  let ok = false;
  try {
    version = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')).version;
    ok = true;
  } catch {
    ok = false;
  }
  const target = canonicalTarget(path) ?? readLinkTarget(path);
  return { name, ok, version, target };
}

/**
 * 组装完整的发现 + 体检报告，供 CLI 与测试共用。
 * @param options.installRoot 显式指定的安装根目录（可选）
 * @param options.candidates 额外的候选安装根目录
 * @param options.commandLines 运行中 Electron 进程的命令行
 * @param options.storeDir 共用宿主依赖仓库
 * @returns 报告；发现不到安装时带 `error`
 */
export function buildReport({ installRoot, candidates = [], commandLines = [], storeDir = defaultStoreDir() } = {}) {
  const derived = [];
  for (const commandLine of commandLines) {
    const appPath = appPathFromCommandLine(commandLine);
    if (appPath !== undefined) derived.push({ value: dirname(appPath), source: 'running-process' });
    const exe = executableFromCommandLine(commandLine);
    if (exe !== undefined && /DeepSeek Harness\.exe$/iu.test(exe)) {
      derived.push({ value: dirname(exe), source: 'running-executable' });
    }
  }
  const explicit = typeof installRoot === 'string' && installRoot !== ''
    ? { value: installRoot, source: 'explicit' }
    : undefined;
  const found = pickInstallation([explicit, ...derived, ...candidates, ...defaultCandidates()]);
  const store = inspectStore({ storeDir });
  if (found === undefined) {
    return { ok: false, error: 'desktop-installation-not-found', storeDir, store };
  }
  return {
    ok: true,
    installation: { ...found, version: installationVersion(found) },
    storeDir,
    store,
    summary: summarizeStore(store),
  };
}

/**
 * 把体检结果压成一行结论 + 是否需要人工关注。
 * @param store {@link inspectStore} 的结果
 */
export function summarizeStore(store) {
  const probeFailed = store.probe.filter(entry => !entry.ok);
  const healthy = store.broken.length === 0 && probeFailed.length === 0;
  const parts = [`${store.usable.length}/${store.entries} 条投影可解析`];
  if (store.broken.length > 0) parts.push(`${store.broken.length} 条不可用`);
  if (store.asarLinked.length > 0) parts.push(`${store.asarLinked.length} 条指向 app.asar（Node 无法解析）`);
  if (probeFailed.length > 0) parts.push(`关键包不可解析: ${probeFailed.map(entry => entry.name).join(', ')}`);
  return { healthy, summary: parts.join(' / '), probeFailed };
}

// ---------------------------------------------------------------------------
// CLI：给 PowerShell 调用。stdout 只有一个 JSON 对象，便于 ConvertFrom-Json。
//
//   discover [--install-root X] [--processes-file F] [--store-dir S]
//
// 必须在**桌面端自带的 Electron** 下以 ELECTRON_RUN_AS_NODE=1 运行：普通 node 看不见
// app.asar 内的文件，会把安装报成不存在。进程命令行由 PowerShell 收集后经
// --processes-file 传入（本模块不 spawn shell）。
// ---------------------------------------------------------------------------
if (import.meta.main) {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const positional = argv.slice(1).filter(argument => !argument.startsWith('--'));
  const flag = (name) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined;
  };
  const emit = (payload, code) => {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    process.exit(code);
  };

  try {
    if (command !== 'discover' && command !== 'check') {
      emit({ ok: false, error: `unknown-command: ${String(command)}` }, 2);
    }
    const processesFile = flag('processes-file');
    let commandLines = [];
    if (processesFile !== undefined && existsSync(processesFile)) {
      const parsed = JSON.parse(readFileSync(processesFile, 'utf8'));
      commandLines = (Array.isArray(parsed) ? parsed : [])
        .map(entry => (typeof entry === 'string' ? entry : entry?.CommandLine))
        .filter(line => typeof line === 'string');
    }
    const storeDir = flag('store-dir');
    const report = buildReport({
      installRoot: flag('install-root') ?? positional[0],
      commandLines,
      ...(storeDir === undefined ? {} : { storeDir }),
    });
    // Keep the payload small: PowerShell 5.1 chokes on deeply nested hundred-entry arrays.
    emit({
      ...report,
      store: {
        entries: report.store.entries,
        usable: report.store.usable.length,
        broken: report.store.broken.map(entry => entry.name),
        asarLinked: report.store.asarLinked.map(entry => entry.name),
        probe: report.store.probe,
      },
    }, report.ok && report.summary.healthy ? 0 : 1);
  } catch (error) {
    emit({ ok: false, error: String(error?.message ?? error) }, 2);
  }
}
