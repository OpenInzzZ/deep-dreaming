/**
 * 校验补丁的「插件展示元信息」。
 *
 * DSH 在插件管理页与设置的内置插件清单里展示每个插件的标题/描述/图标，读法是
 * `packages/boot/app-boot/src/package-meta.ts` 的 `readPluginMeta`：
 *
 *   title       = 各 locale 文件 meta.title  → package.json.name    → 完整模块名
 *   description = 各 locale 文件 meta.description → package.json.description → 空
 *   icon        = package.json 顶层 icon（相对路径，SVG/PNG/JPEG/WebP，≤256 KiB）
 *
 * 关键点：它**不加载插件**，只用 Node 的模块解析去读 `<包名>/locale/<lang>.json`
 * 与 `<包名>/package.json`。所以这两条 subpath 必须出现在 package.json 的
 * `exports` 里，缺一个就整段回退到包名与英文技术描述（我们之前就是这样）。
 *
 * 本脚本复刻该解析逻辑，直接算出「页面会显示什么」，而不是只检查文件是否存在。
 * 一切都在临时目录里造假包，绝不碰真实 profile。
 *
 * 运行：node scripts/verify-plugin-meta.mjs
 */
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PATCHES = ['session-cleanup', 'ui-settings-model-reasoning', 'ui-queue-tools', 'temp-session', 'whale-background']
const LANGUAGE_ID = /^[A-Za-z][A-Za-z0-9-]*$/

/* ---------------------------------------------------------------------------
 * 官方 readPluginMeta 的等价实现（只保留我们依赖的部分）
 * ------------------------------------------------------------------------- */

/** 一个 locale 文件里的展示字段。 */
function displayFieldsOf(file) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  assert.ok(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed), `${file}: 顶层必须是对象`)
  const meta = parsed.meta ?? {}
  assert.ok(meta !== null && typeof meta === 'object' && !Array.isArray(meta), `${file}: meta 必须是对象`)
  const field = (name) => {
    const value = meta[name]
    if (value === undefined) return undefined
    assert.equal(typeof value, 'string', `${file}: meta.${name} 必须是字符串`)
    assert.notEqual(value.trim(), '', `${file}: meta.${name} 不能是空串`)
    return value
  }
  return { title: field('title'), description: field('description') }
}

/**
 * 收集 `<包名>/locale/` 下全部语言文件。
 *
 * 官方以 `locale/en.json` 作为发现入口，再扫描它所在目录的兄弟 `.json`，
 * 并要求语言 id 合法、不重复、且都在同一个目录里。
 */
function dictionariesOf(packageDir, resolveSubpath) {
  const englishPath = resolveSubpath(`${packageDir}/locale/en.json`)
  const dictionaries = new Map()
  for (const name of readdirSync(dirname(englishPath))) {
    if (!name.endsWith('.json')) continue
    const language = name.slice(0, -5)
    assert.ok(LANGUAGE_ID.test(language), `locale 文件名必须是语言 id，收到 ${name}`)
    const id = language.toLowerCase()
    assert.ok(!dictionaries.has(id), `locale 重复：${id}`)
    dictionaries.set(id, displayFieldsOf(resolveSubpath(`${packageDir}/locale/${name}`)))
  }
  return dictionaries
}

/** 官方的逐字段回退与英文兜底。 */
function localizedText(field, dictionaries, fallback, finalFallback) {
  const entries = [...dictionaries].flatMap(([language, fields]) => {
    const value = fields[field]
    return value === undefined ? [] : [[language, value]]
  })
  if (entries.length === 0) return fallback
  return { en: fallback ?? finalFallback, ...Object.fromEntries(entries) }
}

/** 复刻 readPluginMeta：返回设置页/插件页会显示的内容。 */
function readPluginMeta(packageName, resolveSubpath) {
  let dictionaries = new Map()
  try {
    dictionaries = dictionariesOf(packageName, resolveSubpath)
  } catch (error) {
    if (error?.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED' && error?.code !== 'ERR_MODULE_NOT_FOUND' && error?.code !== 'ENOENT') throw error
  }
  let manifest
  try {
    manifest = JSON.parse(readFileSync(resolveSubpath(`${packageName}/package.json`), 'utf8'))
  } catch (error) {
    if (error?.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED' && error?.code !== 'ERR_MODULE_NOT_FOUND' && error?.code !== 'ENOENT') throw error
  }
  return {
    title: localizedText('title', dictionaries, typeof manifest?.name === 'string' ? manifest.name : undefined, packageName),
    description: localizedText('description', dictionaries, typeof manifest?.description === 'string' ? manifest.description : undefined, ''),
  }
}

/* ---------------------------------------------------------------------------
 * 校验
 * ------------------------------------------------------------------------- */

const stage = mkdtempSync(join(tmpdir(), 'plugin-meta-'))
let checks = 0
const ok = (label) => { checks += 1; console.log(`  ✓ ${label}`) }

/**
 * 解析一个 subpath，等价于 Loader 的读法。
 *
 * 用 `createRequire(parentFile).resolve`，不用 `import.meta.resolve(spec, parent)`：
 * 在 Node 24 上后者会忽略第二个参数、始终从**当前文件**解析（实测确认），假包
 * 因此永远找不到。Cordis/Loader 用的也是 `createRequire` 这条路。
 */
function makeResolver(parentFile) {
  const require = createRequire(parentFile)
  return (specifier) => require.resolve(specifier)
}

/** 写回一个 JSON 文件（回归守卫用）。 */
function writeJson(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
}

/**
 * 读取一个展示字段的实际取值。
 *
 * 官方的 `LocalizedText` 有两种形态：有 locale 时是 `{ en, zh, … }` 映射，
 * 没有 locale 时**直接就是回退字符串**（`localizedText` 在 entries 为空时
 * `return fallback`）。断言必须两种都接受，否则会把正确的回退误判成缺失。
 */
function textValue(value, language = 'en') {
  if (value === undefined) return undefined
  if (typeof value === 'string') return value
  return value[language]
}

try {
  for (const patch of PATCHES) {
    console.log(`\n== ${patch} ==`)
    const source = join(repoRoot, 'patches', patch)

    // 1. 源文件必须存在且字段合法（不依赖任何解析器）
    for (const language of ['en', 'zh']) {
      const fields = displayFieldsOf(join(source, 'locale', `${language}.json`))
      assert.ok(fields.title !== undefined, `${patch}/locale/${language}.json 缺少 meta.title`)
      assert.ok(fields.description !== undefined, `${patch}/locale/${language}.json 缺少 meta.description`)
    }
    const en = displayFieldsOf(join(source, 'locale', 'en.json'))
    const zh = displayFieldsOf(join(source, 'locale', 'zh.json'))
    assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort(), `${patch}: 中英字段集合必须一致`)
    ok(`locale/en.json + zh.json 存在，字段完整且中英一致（${Object.keys(en).length} 个字段）`)

    // 2. 中文必须真的和英文不同，否则就是忘了翻译
    for (const field of ['title', 'description']) {
      assert.notEqual(zh[field], en[field], `${patch}: zh.${field} 与 en.${field} 完全相同，可能漏翻`)
    }
    ok('中文标题与描述都已本地化（不是英文副本）')

    // 3. 端到端：把它当作已安装的 npm 包放进一个 node_modules，用真实解析器读
    const fakeRoot = join(stage, patch)
    const installed = join(fakeRoot, 'node_modules', ...`@local/dsh-${patch}`.split('/'))
    cpSync(source, installed, { recursive: true, filter: (src) => !src.includes('node_modules') })
    writeJson(join(fakeRoot, 'entry.mjs'), '// 解析起点：模拟 Loader 的 baseUrl，让裸包名从假 node_modules 解析\n')
    const resolveSubpath = makeResolver(join(fakeRoot, 'entry.mjs'))
    const meta = readPluginMeta(`@local/dsh-${patch}`, resolveSubpath)

    assert.ok(meta.title !== undefined, `${patch}: 解析后拿不到标题`)
    assert.equal(meta.title.en, en.title, `${patch}: 英文标题应来自 locale`)
    assert.equal(meta.title.zh, zh.title, `${patch}: 中文标题应来自 locale`)
    assert.notEqual(meta.title.en, `@local/dsh-${patch}`, `${patch}: 标题回退到了包名，说明 locale subpath 没导出`)
    assert.equal(meta.description.en, en.description, `${patch}: 英文描述应来自 locale`)
    assert.equal(meta.description.zh, zh.description, `${patch}: 中文描述应来自 locale`)
    ok(`端到端解析成功 → zh 标题「${meta.title.zh}」/ en 标题「${meta.title.en}」`)

    // 4. 描述必须比 package.json 的技术描述更像人话（那就是我们写 locale 的理由）
    const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
    assert.notEqual(meta.description.zh, manifest.description, `${patch}: 描述仍是 package.json 的技术句`)
    assert.ok(!meta.description.zh.startsWith('User-level plugin:'), `${patch}: 描述不该带 "User-level plugin:" 前缀`)
    ok('描述已脱离 package.json 的英文技术句')

    // 5. 回归守卫：把 locale 导出摘掉，就必须回退（证明前面测的是真机制，不是巧合）
    const stripped = JSON.parse(JSON.stringify(manifest))
    delete stripped.exports['./locale/*.json']
    const bareDir = join(stage, `${patch}-stripped`, 'node_modules', ...stripped.name.split('/'))
    cpSync(source, bareDir, { recursive: true, filter: (src) => !src.includes('node_modules') })
    writeJson(join(bareDir, 'package.json'), stripped)
    const bareRoot = join(stage, `${patch}-stripped`)
    writeJson(join(bareRoot, 'entry.mjs'), '// 同上\n')
    const fellBack = readPluginMeta(stripped.name, makeResolver(join(bareRoot, 'entry.mjs')))
    // 无 locale 时官方直接**回退成纯字符串**（localizedText 在 entries 为空时
    // `return fallback`），不是 `{ en }` 映射——所以断言要走 textValue()。
    assert.equal(textValue(fellBack.title), stripped.name, `${patch}: 摘掉 locale 导出后标题本应回退到包名`)
    assert.equal(textValue(fellBack.description), manifest.description, `${patch}: 摘掉 locale 导出后描述本应回退到 package.json`)
    ok('回归守卫有效：摘掉 ./locale/*.json 导出即回退到包名 + 技术描述')

    // 6. 设置页会剥掉 npm scope 与 dsh 前缀显示回退短名；locale 标题原样保留
    assert.ok(!/[（(]/.test(meta.title.zh), `${patch}: 标题含括号，可能被页面当作技术名二次格式化`)
    assert.ok(Array.from(meta.title.zh).length <= 12, `${patch}: 中文标题过长（${meta.title.zh}）`)
    ok(`标题长度与格式适合列表显示（${Array.from(meta.title.zh).length} 字）`)
  }
} finally {
  rmSync(stage, { recursive: true, force: true })
}

console.log(`\n结果: ${checks} 项全部通过`)
