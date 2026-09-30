/**
 * 图标名迁移映射生成器。
 *
 * DSH 0.2.0-rc.2 的 @deepseek-ai/dsh-client-ui-primitives 把图标导出从
 * `<Name>Outline<16|14>` 改名为 `<Name>Outline<Regular|Medium>`（笔画粗细维度，
 * 尺寸改由 `size` prop 控制，默认 16）。客户端模块表由 packages/client/web/src/seed.ts
 * 播种，用的就是这套 0.2.0-rc.2 的导出，所以补丁里的旧名会解析成 undefined。
 *
 * 同一个改名也适用于测试里的**桩模块**：验证脚本按名字注入图标，桩名不同步就会
 * 让组件变成 undefined（React 报 "Element type is invalid"），而不是渲染失败。
 *
 * 本脚本从 DSH 源码的导出表生成映射，并扫描仓库里的引用。
 *
 * 用法：node scripts/migrate-icon-names.mjs [--apply]
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const DSH_SOURCE = process.env.DSH_SOURCE ?? 'D:\\GitHub\\deepseek-harness';
const ICONS_FILE = join(DSH_SOURCE, 'packages', 'client', 'ui-primitives', 'src', 'icons', 'index.tsx');

/** DSH 0.2.0-rc.2 实际导出的图标名。 */
function readExportedIcons() {
  const source = readFileSync(ICONS_FILE, 'utf8');
  const names = new Set();
  for (const match of source.matchAll(/^export const (Icon[A-Za-z0-9]+)/gmu)) names.add(match[1]);
  return names;
}

/**
 * 旧名 -> 新名。
 * `…Outline16` -> `…OutlineRegular`（16px 是默认尺寸，无需 size prop）
 * `…Outline14` -> `…OutlineMedium`（14px 需要显式 size，见调用方）
 * 没有 Outline 段的名字（如 IconSparkle16）同理。
 */
function buildRenameMap(exported) {
  const map = new Map();
  for (const name of exported) {
    if (!name.endsWith('Regular') && !name.endsWith('Medium')) continue;
    const stem = name.replace(/(Regular|Medium)$/u, '');
    const suffix = name.endsWith('Regular') ? '16' : '14';
    map.set(`${stem}${suffix}`, name);
  }
  return map;
}

/** 补丁目录下的所有 JS/MJS 文件（client 半边与验证脚本都要同步改）。 */
function listSources(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'archive') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { listSources(path, out); continue; }
    if (entry.isFile() && /\.(mjs|js)$/u.test(entry.name)) out.push(path);
  }
  return out;
}

const exported = readExportedIcons();
const rename = buildRenameMap(exported);
const apply = process.argv.includes('--apply');

console.log(`DSH source : ${ICONS_FILE}`);
console.log(`exported   : ${exported.size} icons, ${rename.size} legacy names mapped`);
console.log(`mode       : ${apply ? 'APPLY' : 'dry-run'}\n`);

let totalHits = 0;
let unknownHits = 0;
const fileEdits = [];

for (const file of listSources(join(repoRoot, 'patches'))) {
  const original = readFileSync(file, 'utf8');
  const used = new Set([...original.matchAll(/\bIcon[A-Za-z0-9]+\b/gu)].map(match => match[0]));
  // 只处理"带旧尺寸后缀"的名字，避免把业务变量名当成图标。
  const legacy = [...used].filter(name => rename.has(name));
  const unknown = [...used].filter(name => /Outline\d|Icon\w+\d{2}$/u.test(name) && !rename.has(name) && !exported.has(name));
  if (legacy.length === 0 && unknown.length === 0) continue;

  let next = original;
  for (const name of legacy) next = next.replace(new RegExp(`\\b${name}\\b`, 'gu'), rename.get(name));
  const relative = file.slice(repoRoot.length + 1);
  console.log(relative);
  for (const name of legacy) console.log(`   ${name} -> ${rename.get(name)}`);
  for (const name of unknown) { console.log(`   [UNKNOWN] ${name} is in neither the export table nor the rename map`); unknownHits++; }
  totalHits += legacy.length;
  if (next !== original) fileEdits.push([file, next]);
}

console.log(`\n${totalHits} legacy reference(s), ${unknownHits} unknown name(s), ${fileEdits.length} file(s) affected`);
if (apply && fileEdits.length > 0) {
  for (const [file, content] of fileEdits) writeFileSync(file, content);
  console.log(`applied ${fileEdits.length} file(s)`);
} else if (!apply && fileEdits.length > 0) {
  console.log('dry-run: pass --apply to write');
}
