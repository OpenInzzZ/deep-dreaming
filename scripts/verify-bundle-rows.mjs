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
 *   2. yml 里恰好一个 `- insert:` 行，id 与 package name 互相印证；
 *   3. 行 name 必须等于 package.json 的 name —— Loader 用它 import 插件本体，
 *      对不上就静默 pending（这正是 AGENTS「客户端半端」要求 seed 对齐的同款陷阱）；
 *   4. exports 必须导出 ./package.json 与 ./locale/*.json，否则插件页元信息
 *      （readPluginMeta）回退成包名 —— 见 scripts/verify-plugin-meta.mjs；
 *   5. 所有行 id 跨包唯一（重复 id = 下次启动直接中断）。
 *
 * 运行：node scripts/verify-bundle-rows.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** dir -> loader row id (bundle yml 的 insert 行 id)。 */
const BUNDLES = {
    'session-cleanup': 'session-cleanup',
    'ui-settings-model-reasoning': 'ui-settings-model-reasoning',
    'ui-queue-tools': 'ui-queue-tools',
    'temp-session': 'temp-session',
    'whale-background': 'whale-background',
    'dsh-project-memory': 'project-memory',
}

let checks = 0
const ok = (label) => { checks += 1; console.log(`  ✓ ${label}`) }

/** 从 yml 文本里抽数组元素上的字段（够用即可，不引 YAML 依赖）。 */
function rowField(text, key) {
    const m = new RegExp(`^\\s*-?\\s*${key}:\\s*['"]?([^'"\\r\\n]+?)['"]?\\s*$`, 'm').exec(text)
    return m ? m[1].trim() : undefined
}

function countInsertBlocks(text) {
    return (text.match(/^- insert:[ \t]*$/gm) || []).length
}

try {
    for (const [dir, expectedId] of Object.entries(BUNDLES)) {
        console.log(`\n== ${dir} ==`)
        const source = join(repoRoot, 'patches', dir)
        assert.ok(existsSync(source), `${dir}: 补丁目录不存在`)

        // 1. manifest 声明
        const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
        assert.ok(manifest.dsh?.bundle?.patch, `${dir}: package.json 缺少 dsh.bundle.patch 声明`)
        const patchRel = manifest.dsh.bundle.patch
        const patchAbs = join(source, patchRel)
        assert.ok(existsSync(patchAbs), `${dir}: dsh.bundle.patch 指向的文件不存在: ${patchRel}`)
        ok(`dsh.bundle.patch -> ${patchRel}`)

        // 2/3. yml 结构 + id/name 互相印证
        const yml = readFileSync(patchAbs, 'utf8')
        assert.equal(countInsertBlocks(yml), 1, `${dir}: cordis.patch.yml 必须恰好一个顶层 - insert: 块`)
        const rowId = rowField(yml, 'id')
        const rowName = rowField(yml, 'name')
        assert.equal(rowId, expectedId, `${dir}: 行 id 应为 ${expectedId}，实际 ${rowId}`)
        assert.equal(rowName, manifest.name, `${dir}: 行 name (${rowName}) 必须等于 package.json name (${manifest.name})，否则 Loader 静默不加载`)
        ok(`insert 行 id=${rowId} name=${rowName} 与 manifest 一致`)

        // 4. 元信息 subpath 导出
        assert.ok(manifest.exports?.['./package.json'], `${dir}: exports 缺少 ./package.json（readPluginMeta 需要）`)
        assert.ok(manifest.exports?.['./locale/*.json'], `${dir}: exports 缺少 ./locale/*.json（插件页标题会回退成包名）`)
        assert.ok(existsSync(join(source, 'locale', 'en.json')), `${dir}: locale/en.json 缺失`)
        assert.ok(existsSync(join(source, 'locale', 'zh.json')), `${dir}: locale/zh.json 缺失`)
        ok('exports 暴露 package.json + locale，且 en/zh 齐全')

        // 5. files 数组（若声明）必须带上 cordis.patch.yml：file: 协议打包会裁掉它，
        //    bundle 层就再也读不到行 —— pnpm 用 link: 时无感，纯防御。
        if (Array.isArray(manifest.files)) {
            assert.ok(manifest.files.includes('cordis.patch.yml'), `${dir}: files 数组缺少 cordis.patch.yml（file: 打包会丢行）`)
            ok('files 数组包含 cordis.patch.yml')
        }
    }

    // 5. 跨包 id 唯一：重复 id 会让 boot fail-loud 中断。
    const ids = Object.values(BUNDLES)
    assert.equal(new Set(ids).size, ids.length, `行 id 跨包重复: ${ids.join(', ')}`)
    ok(`全部 ${ids.length} 个行 id 跨包唯一`)

    // 目录里不能藏着未登记的 bundle yml（新加补丁忘了进 install/deploy 清单）。
    const dirs = readdirSync(join(repoRoot, 'patches'), { withFileTypes: true })
        .filter((e) => e.isDirectory()).map((e) => e.name)
    const orphans = dirs.filter((d) => !Object.hasOwn(BUNDLES, d)
        && existsSync(join(repoRoot, 'patches', d, 'cordis.patch.yml')))
    assert.deepEqual(orphans, [], `这些补丁有 cordis.patch.yml 却不在 BUNDLES 清单里: ${orphans.join(', ')}`)
    ok('无未登记的 cordis.patch.yml')
} finally {
    // 无临时目录，占位保持与 verify-plugin-meta 相同的收尾形状。
}

console.log(`\n结果: ${checks} 项全部通过`)
