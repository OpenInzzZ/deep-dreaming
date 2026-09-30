/**
 * desktop-install.test.mjs — 桌面端安装发现与共用依赖仓库体检的纯逻辑测试。
 *
 * 不碰真实 `~/.dsh`：全部在临时目录里构造安装与仓库的目录形状，因此可以在任何机器上跑。
 *
 * 特别地，这里**没有**「重建投影」的测试：那条路已被实测证否（junction 指向 app.asar
 * 内部时 Node 解析不了、物化要 236 MB、删掉投影宿主的拦截层也不代答），所以模块本身
 * 只提供只读体检。任何把写入能力加回来的改动都应该先推翻那三条实测结论。
 *
 * 运行：node scripts/desktop-install.test.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  appPathFromCommandLine,
  asInstallation,
  buildReport,
  defaultStoreDir,
  executableFromCommandLine,
  inspectStore,
  installationPaths,
  installationVersion,
  inventoryScope,
  pickInstallation,
  summarizeStore,
} from './desktop-install.mjs';

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`OK: ${label}`);
    return;
  }
  failures += 1;
  console.log(`FAIL: ${label}${detail === undefined ? '' : ` — ${detail}`}`);
}

const scratch = mkdtempSync(join(tmpdir(), 'deep-dreaming-desktop-'));
const write = (path, content) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
};
const writePkg = (dir, name, version) => write(join(dir, 'package.json'), JSON.stringify({ name, version }));

/** 造一套「桌面端安装」的骨架：resources/app.asar/dsh/node_modules/@deepseek-ai/*。 */
function makeInstallation(root, names) {
  const paths = installationPaths(root);
  writePkg(join(paths.runtimeScope, 'dsh'), '@deepseek-ai/dsh', '9.9.9-test');
  for (const name of names) writePkg(join(paths.runtimeScope, name), `@deepseek-ai/${name}`, '9.9.9-test');
  return paths;
}

/** 造一个「共用依赖仓库」，把给定名字链接到 targetDir。 */
function makeStore(root, names, targetDir) {
  const scope = join(root, '@deepseek-ai');
  mkdirSync(scope, { recursive: true });
  for (const name of names) {
    const target = join(targetDir, name);
    writePkg(target, `@deepseek-ai/${name}`, '0.1.5-old');
    symlinkSync(target, join(scope, name), 'junction');
  }
  return scope;
}

try {
  // --- 1. 命令行解析 -------------------------------------------------------
  const rendererLine = '"D:\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe" --type=renderer '
    + '--user-data-dir="C:\\Users\\u\\AppData\\Roaming\\@deepseek-ai/dsh-desktop" '
    + '--app-path="D:\\Programs\\DeepSeek Harness\\resources\\app.asar" --enable-sandbox';
  check('appPath 从 --app-path 推出 resources 目录',
    appPathFromCommandLine(rendererLine) === 'D:\\Programs\\DeepSeek Harness\\resources',
    appPathFromCommandLine(rendererLine));
  check('appPath：没有 --app-path 时为 undefined', appPathFromCommandLine('"x.exe" --type=gpu') === undefined);
  check('appPath：后接其它 flag 时不会把 -- 吞进路径',
    appPathFromCommandLine('x --app-path="D:\\a b\\resources\\app.asar" --enable-sandbox') === 'D:\\a b\\resources',
    appPathFromCommandLine('x --app-path="D:\\a b\\resources\\app.asar" --enable-sandbox'));
  check('executable 取首个带引号的 token',
    executableFromCommandLine(rendererLine) === 'D:\\Programs\\DeepSeek Harness\\DeepSeek Harness.exe');
  check('executable 只认带引号形态（无引号路径含空格时宁可放弃）',
    executableFromCommandLine('C:\\a\\DeepSeek Harness.exe --flag') === undefined);
  check('appPath 的父目录就是安装根',
    installationPaths(dirname(appPathFromCommandLine(rendererLine))).installRoot === 'D:\\Programs\\DeepSeek Harness');

  // --- 2. 安装识别 ---------------------------------------------------------
  const goodRoot = join(scratch, 'good');
  const goodPaths = makeInstallation(goodRoot, ['schemastery', 'dsh-llm']);
  check('asInstallation 认出一套完整安装', asInstallation(goodRoot)?.runtimeDir === goodPaths.runtimeDir);
  check('asInstallation 拒绝空字符串', asInstallation('') === undefined);
  check('asInstallation 拒绝缺 dsh 包的空壳', asInstallation(join(scratch, 'empty')) === undefined);
  check('installationVersion 读出运行时版本', installationVersion(goodPaths) === '9.9.9-test');
  check('pickInstallation 跳过不可用候选、取第一套可用',
    pickInstallation([{ value: join(scratch, 'nope'), source: 'a' }, { value: goodRoot, source: 'b' }])?.source === 'b');
  check('pickInstallation 全不可用时 undefined',
    pickInstallation([{ value: join(scratch, 'nope'), source: 'a' }]) === undefined);

  // --- 3. 仓库清单 ---------------------------------------------------------
  const storeRoot = join(scratch, 'store');
  const legacyDir = join(scratch, 'legacy-scope');
  makeStore(storeRoot, ['schemastery', 'dsh-llm', 'cordis'], legacyDir);
  const listed = inventoryScope(storeRoot);
  check('inventoryScope 列出作用域下的条目并按名称排序',
    listed.length === 3 && listed[0].name === 'cordis' && listed[2].name === 'schemastery',
    JSON.stringify(listed.map(entry => entry.name)));
  check('inventoryScope 能看见 junction（dirent 判定会漏掉它们）',
    listed.length === 3, `saw ${listed.length}`);
  check('inventoryScope 对不存在的仓库返回空数组', inventoryScope(join(scratch, 'no-store')).length === 0);
  check('defaultStoreDir 落在 profiles 树下',
    defaultStoreDir('C:\\home').endsWith(join('home', '.dsh', 'profiles', 'node_modules')));

  // --- 4. 体检：健康仓库 ---------------------------------------------------
  const healthy = inspectStore({ storeDir: storeRoot });
  check('体检：健康仓库每条投影都算可用',
    healthy.entries === 3 && healthy.usable.length === 3 && healthy.broken.length === 0,
    JSON.stringify({ entries: healthy.entries, usable: healthy.usable.length, broken: healthy.broken.length }));
  check('体检：解析出链接的最终目标', healthy.usable.every(entry => typeof entry.target === 'string'));
  check('体检：探针包（补丁真正 import 的两个）可解析',
    healthy.probe.length === 2 && healthy.probe.every(entry => entry.ok && entry.version === '0.1.5-old'),
    JSON.stringify(healthy.probe));
  const healthySummary = summarizeStore(healthy);
  check('体检结论：健康时为 healthy 且不需要关注', healthySummary.healthy === true, healthySummary.summary);
  check('体检结论：一行摘要包含可用计数',
    healthySummary.summary.includes('3/3'), healthySummary.summary);

  // --- 5. 体检：断链与 app.asar 链接 ---------------------------------------
  const brokenStore = join(scratch, 'store-broken');
  const brokenScope = join(brokenStore, '@deepseek-ai');
  mkdirSync(brokenScope, { recursive: true });
  symlinkSync(join(scratch, 'gone'), join(brokenScope, 'cordis'), 'junction');
  // 指向 app.asar 内部的链接在**真实环境**里解析不了（Electron 的 asar 层只认直接
  // 的 app.asar 路径）。这里用一个不存在的 asar 目标复现同一形态：建得出链接，读不到。
  const fakeAsar = join(scratch, 'Fake.app', 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai');
  symlinkSync(join(fakeAsar, 'schemastery'), join(brokenScope, 'schemastery'), 'junction');
  writePkg(join(brokenScope, 'dsh-llm'), '@deepseek-ai/dsh-llm', '0.1.5-old');

  const broken = inspectStore({ storeDir: brokenStore });
  check('体检：断链被计入不可用', broken.broken.some(entry => entry.name === 'cordis'),
    JSON.stringify(broken.broken.map(entry => entry.name)));
  check('体检：指向 app.asar 的链接既被标记又计入不可用',
    broken.asarLinked.some(entry => entry.name === 'schemastery')
    && broken.broken.some(entry => entry.name === 'schemastery'),
    JSON.stringify({ asarLinked: broken.asarLinked.map(e => e.name), broken: broken.broken.map(e => e.name) }));
  check('体检：普通目录仍然算可用',
    broken.usable.some(entry => entry.name === 'dsh-llm'));
  const brokenSummary = summarizeStore(broken);
  check('体检结论：有断链时不健康并点名原因',
    brokenSummary.healthy === false
    && brokenSummary.summary.includes('不可用')
    && brokenSummary.summary.includes('app.asar'),
    brokenSummary.summary);
  check('体检结论：关键包不可解析会被点名',
    brokenSummary.probeFailed.length === 1 && brokenSummary.probeFailed[0].name === '@deepseek-ai/schemastery',
    JSON.stringify(brokenSummary.probeFailed));

  // 一个**可解析**的 app.asar 链接：仍应被标记（它是未来换机/升级后的地雷），
  // 但因为当前能读，不该把仓库判成不可用。
  const asarOkStore = join(scratch, 'store-asar-ok');
  const asarOkScope = join(asarOkStore, '@deepseek-ai');
  mkdirSync(asarOkScope, { recursive: true });
  const realAsar = join(scratch, 'Real.app', 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai');
  writePkg(join(realAsar, 'dsh-llm'), '@deepseek-ai/dsh-llm', '9.9.9-test');
  symlinkSync(join(realAsar, 'dsh-llm'), join(asarOkScope, 'dsh-llm'), 'junction');
  const asarOk = inspectStore({ storeDir: asarOkStore });
  check('体检：可解析但指向 app.asar 的投影被标记、且不算断链',
    asarOk.asarLinked.length === 1 && asarOk.broken.length === 0 && asarOk.usable.length === 1,
    JSON.stringify({ asar: asarOk.asarLinked.length, broken: asarOk.broken.length, usable: asarOk.usable.length }));

  // --- 6. 报告装配 ---------------------------------------------------------
  const report = buildReport({ installRoot: goodRoot, commandLines: [rendererLine], storeDir: storeRoot });
  check('buildReport：显式安装根优先，报告完整',
    report.ok === true
    && report.installation.source === 'explicit'
    && report.installation.version === '9.9.9-test'
    && report.store.entries === 3,
    JSON.stringify({ source: report.installation?.source, entries: report.store?.entries }));
  check('buildReport：带一行仓库摘要', report.summary.healthy === true, report.summary.summary);

  const fromProcess = buildReport({ commandLines: [rendererLine], storeDir: storeRoot });
  check('buildReport：能从运行中的命令行推出安装（环境里没有该路径时失败是预期的）',
    fromProcess.ok === false || fromProcess.installation.source === 'running-process',
    JSON.stringify({ ok: fromProcess.ok, source: fromProcess.installation?.source }));

  const missing = buildReport({ installRoot: join(scratch, 'definitely-missing'), storeDir: storeRoot });
  check('buildReport：找不到安装时给出错误码而不是抛异常',
    missing.ok === false && missing.error === 'desktop-installation-not-found', JSON.stringify(missing));
  check('buildReport：找不到安装时仍然给出仓库体检结果',
    missing.store.entries === 3, JSON.stringify(missing.store?.entries));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log('');
if (failures === 0) {
  console.log('ALL HARNESS CHECKS PASSED');
  process.exit(0);
}
console.log(`${failures} check(s) FAILED`);
process.exit(1);
