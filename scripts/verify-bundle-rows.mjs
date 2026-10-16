/**
 * verify-bundle-rows.mjs — bundle 行的仓库侧不变量（不碰真实 profile）。
 *
 * 迁移后每个补丁都是 bundle：package.json 声明 `dsh.bundle.patch`，包内自带
 * `cordis.patch.yml` 承载 loader 行。boot 对「同一 id 两个 owner」是 fail-loud
 * 的（`TypeError: duplicate loader entry id`），而行错位/名字对不上则是**静默
 * 不加载**——插件页卡片缺一行、某个 host 路由 404，没有任何报错。所以这些结构
 * 必须在仓库侧被钉死：
 *
 *   1. package.json 声明了 dsh.bundle.patch，且指向的文件存在；
 *   2. yml 里恰好一个 `- insert:` 块，块内的行 id 与清单声明一致（一个 bundle
 *      可以有多行 —— 插件页里它就是「包含的组件」，官方先例 agent-team-profile）；
 *   3. 每行的 name 要么等于本包 package.json 的 name（补丁自己），要么指向仓库里
 *      另一个补丁包（组件包，如 mcp-servers 的每服务一行）；Loader 用 name import
 *      插件本体，对不上就静默 pending；
 *   4. 被引用的包必须导出 ./package.json 与 ./locale/*.json 且 en/zh 标题齐全、
 *      同一卡内互不相同 —— 组件标题取自**该行 name 指向的包**的 locale
 *      （plugin-manager `declaredRows` → `packages.metaOf(row.name, base)`），
 *      缺了就回退成包名，两个组件会同名（另见 scripts/verify-plugin-meta.mjs）；
 *   5. files 数组（若声明）必须带上 cordis.patch.yml；
 *   6. 所有行 id 跨包唯一（重复 id = 下次启动直接中断）；
 *   7. 目录里不能藏着未登记的 cordis.patch.yml；
 *   8. 反过来，patches/ 下每个包都必须被某一行引用，否则它是改了也不生效的死代码；
 *   9. 客户端半端的 CSS 数组必须 `join('\n')` 再注入 —— 直接赋值会被 Chrome 丢规则。
 *
 * 运行：node scripts/verify-bundle-rows.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const patchesDir = join(repoRoot, 'patches')

/** dir -> 该 bundle 的 yml 应声明的 loader 行 id（一行或多行）。 */
const BUNDLES = {
    'session-cleanup': ['session-cleanup'],
    'ui-settings-model-capabilities': ['ui-settings-model-capabilities'],
    'ui-queue-tools': ['ui-queue-tools'],
    'temp-session': ['temp-session'],
    'whale-background': ['whale-background'],
    'dsh-project-memory': ['project-memory'],
    'mcp-servers': ['mcp-servers'],
}

let checks = 0
const ok = (label) => { checks += 1; console.log(`  ✓ ${label}`) }

const patchDirs = () => readdirSync(patchesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name)

/** 仓库里 package.json name -> dir（组件包靠它被行引用）。 */
function packageIndex() {
    const byName = new Map()
    for (const dir of patchDirs()) {
        const manifestPath = join(patchesDir, dir, 'package.json')
        if (!existsSync(manifestPath)) continue
        byName.set(JSON.parse(readFileSync(manifestPath, 'utf8')).name, dir)
    }
    return byName
}

/** 某个包的 locale meta.title；缺文件返回 undefined。 */
function localeTitle(dir, locale) {
    const p = join(patchesDir, dir, 'locale', `${locale}.json`)
    if (!existsSync(p)) return undefined
    return JSON.parse(readFileSync(p, 'utf8'))?.meta?.title
}

/**
 * 抽 `- insert:` 块里的 (id, name) 行对。
 *
 * 够用即可，不引 YAML 依赖：仓库里所有行都是 `- id:` 紧跟 `name:`、`config:` 在
 * 其后。若有人换了顺序，这里会少解析一行，由「行数与清单一致」的断言当场失败。
 */
function insertRows(text) {
    const rows = []
    const re = /^\s*- id:\s*['"]?([^'"\r\n]+?)['"]?\s*\r?\n\s*name:\s*['"]?([^'"\r\n]+?)['"]?\s*$/gm
    let m
    while ((m = re.exec(text)) !== null) rows.push({ id: m[1].trim(), name: m[2].trim() })
    return rows
}

function countInsertBlocks(text) {
    return (text.match(/^- insert:[ \t]*$/gm) || []).length
}

/** 某个 bundle 包声明的 cordis.patch.yml 绝对路径。 */
function patchPathOf(dir) {
    const manifest = JSON.parse(readFileSync(join(patchesDir, dir, 'package.json'), 'utf8'))
    return join(patchesDir, dir, manifest.dsh.bundle.patch)
}

const packages = packageIndex()

try {
    for (const [dir, expectedIds] of Object.entries(BUNDLES)) {
        console.log(`\n== ${dir} ==`)
        const source = join(patchesDir, dir)
        assert.ok(existsSync(source), `${dir}: 补丁目录不存在`)

        // 1. manifest 声明
        const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
        assert.ok(manifest.dsh?.bundle?.patch, `${dir}: package.json 缺少 dsh.bundle.patch 声明`)
        const patchRel = manifest.dsh.bundle.patch
        const patchAbs = join(source, patchRel)
        assert.ok(existsSync(patchAbs), `${dir}: dsh.bundle.patch 指向的文件不存在: ${patchRel}`)
        ok(`dsh.bundle.patch -> ${patchRel}`)

        // 2. yml 结构 + 行 id 与清单一致
        const yml = readFileSync(patchAbs, 'utf8')
        assert.equal(countInsertBlocks(yml), 1, `${dir}: cordis.patch.yml 必须恰好一个顶层 - insert: 块`)
        const rows = insertRows(yml)
        assert.deepEqual(rows.map((row) => row.id).sort(), [...expectedIds].sort(),
            `${dir}: 行 id 应为 [${expectedIds.join(', ')}]，实际 [${rows.map((row) => row.id).join(', ') || '未解析到行'}]`)
        ok(`${rows.length} 行：${rows.map((row) => row.id).join(', ')}`)

        // 3 + 4. 每行 name 可解析；被引用的包元信息齐全且同卡标题唯一
        const titles = { zh: new Map(), en: new Map() }
        for (const row of rows) {
            const selfRow = row.name === manifest.name
            const rowDir = selfRow ? dir : packages.get(row.name)
            assert.ok(rowDir, `${dir}: 行 ${row.id} 的 name (${row.name}) 既不是本包，也不是 patches/ 下任何包的 name —— Loader 会静默不加载`)
            const rowSource = join(patchesDir, rowDir)
            const rowManifest = JSON.parse(readFileSync(join(rowSource, 'package.json'), 'utf8'))
            assert.ok(rowManifest.exports?.['./package.json'], `${rowDir}: exports 缺少 ./package.json（readPluginMeta 需要）`)
            assert.ok(rowManifest.exports?.['./locale/*.json'], `${rowDir}: exports 缺少 ./locale/*.json（标题会回退成包名）`)
            for (const locale of ['zh', 'en']) {
                const title = localeTitle(rowDir, locale)
                assert.ok(title, `${rowDir}: locale/${locale}.json 缺少 meta.title`)
                const seen = titles[locale]
                const clash = [...seen.entries()].find(([otherName, otherTitle]) => otherTitle === title && otherName !== row.name)
                assert.ok(!clash, `${dir}: 行 ${row.id} 与行 ${clash?.[0]} 在 ${locale} 下同名「${title}」—— 插件页里两个组件无法区分`)
                seen.set(row.name, title)
            }
            ok(`行 ${row.id} -> ${row.name}${selfRow ? '（本包）' : `（组件包 ${rowDir}）`}，zh/en 标题齐且同卡唯一`)
        }

        // 5. bundle 自己的 files 数组（若声明）必须带上 cordis.patch.yml：file: 协议
        //    打包会裁掉它，bundle 层就再也读不到行 —— pnpm 用 link: 时无感，纯防御。
        if (Array.isArray(manifest.files)) {
            assert.ok(manifest.files.includes('cordis.patch.yml'), `${dir}: files 数组缺少 cordis.patch.yml（file: 打包会丢行）`)
            ok('files 数组包含 cordis.patch.yml')
        }
    }

    // 6. 跨包 id 唯一：重复 id 会让 boot fail-loud 中断。
    const ids = Object.values(BUNDLES).flat()
    assert.equal(new Set(ids).size, ids.length, `行 id 跨包重复: ${ids.join(', ')}`)
    ok(`全部 ${ids.length} 个行 id 跨包唯一`)

    // 7. 目录里不能藏着未登记的 bundle yml（新加补丁忘了进 install/deploy 清单）。
    const orphans = patchDirs().filter((d) => !Object.hasOwn(BUNDLES, d)
        && existsSync(join(patchesDir, d, 'cordis.patch.yml')))
    assert.deepEqual(orphans, [], `这些补丁有 cordis.patch.yml 却不在 BUNDLES 清单里: ${orphans.join(', ')}`)
    ok('无未登记的 cordis.patch.yml')

    // 8. 反向：每个包都要么自己是被登记的 bundle，要么被某一行引用，否则它是改了
    //    也不生效的死代码。（伞包本身不出现在任何行里 —— 它靠 `dsh.profile.bundles`
    //    挂载，行是它替别人声明的。）
    const referenced = new Set(Object.keys(BUNDLES).map((dir) =>
        JSON.parse(readFileSync(join(patchesDir, dir, 'package.json'), 'utf8')).name))
    for (const dir of Object.keys(BUNDLES)) {
        for (const row of insertRows(readFileSync(patchPathOf(dir), 'utf8'))) referenced.add(row.name)
    }
    const dead = [...packages.entries()].filter(([name]) => !referenced.has(name)).map(([, dir]) => dir)
    assert.deepEqual(dead, [], `这些包既不是 bundle 也没被任何 loader 行引用（死代码）: ${dead.join(', ')}`)
    ok(`全部 ${packages.size} 个包都被挂载（bundle 自身或被行引用）`)
    // 10. 客户端半端注入 <style> 的必须是**字符串**。数组直接赋值会走
    //     Array.toString()，规则之间是逗号：Chrome 在表顶层遇到游离逗号会丢掉
    //     后续规则（jsdom 照单全收，所以 DOM 测试抓不到）——实测过：卡片只剩
    //     第一条样式。仓库的写法是在声明处 `].join('\n')`。
    const clients = []
    for (const dir of patchDirs()) {
        for (const rel of ['client.js', join('lib', 'client.js')]) {
            const p = join(patchesDir, dir, rel)
            if (existsSync(p)) clients.push(p)
        }
    }
    const badCss = clients.filter((p) => {
        const text = readFileSync(p, 'utf8')
        if (!/const CSS = \[/u.test(text)) return false
        const joinedAtSource = /\]\.join\(/u.test(text)
        const joinedAtInject = /textContent\s*=\s*CSS\.join\(/u.test(text)
        return !(joinedAtSource || joinedAtInject)
    }).map((p) => p.slice(patchesDir.length + 1))
    assert.deepEqual(badCss, [], `这些客户端把 CSS 数组原样赋给 textContent（逗号拼接会被 Chrome 丢规则）: ${badCss.join(', ')}`)
    ok(`${clients.length} 个客户端半端的样式注入都是字符串`)
} finally {
    // 无临时目录，占位保持与 verify-plugin-meta 相同的收尾形状。
}

console.log(`\n结果: ${checks} 项全部通过`)
