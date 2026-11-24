/**
 * 纯逻辑测试：store / markdown / import / board 动作层。
 *
 * 不需要 DSH 运行时，也不碰用户的真实清单——每个用例都指向一个临时目录。
 * 重点覆盖三件容易出错的事：
 *   1. 三份 Markdown 镜像与源文档同形（标题、锚点、小节顺序、硬交付物）。
 *   2. 导入的解析规则（三种标题形态、`**小节**` 切块、幂等跳过）。
 *   3. 并发写不丢更新（`withBoardLock` 的存在理由）。
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

import {
  KINDS,
  boardPaths,
  completeItem,
  createItem,
  emptyBoard,
  filterItems,
  isoDate,
  normalizeBoard,
  resolveBoardRoot,
  sectionOrder,
  sortItems,
  summarize,
} from '../lib/store.js'
import { anchorOf, branchSuffix, renderBranchDoc, renderDoneDoc, renderItemDoc, renderTodoDoc } from '../lib/markdown.js'
import { parseMarkdown, projectOfPath } from '../lib/import.js'
import {
  executeTodoCommand,
  inferKind,
  isDuplicateCommand,
  resolveRef,
} from '../lib/commands.js'
import {
  addItem,
  archiveItem,
  completeItemById,
  createBoardAccess,
  deleteItem,
  importFile,
  listItems,
  refreshMirrors,
  updateItem,
} from '../lib/board.js'

let passed = 0
let failed = 0

/**
 * 跑一个用例并汇总结果。
 * @param label - 用例名。
 * @param run - 用例体。
 */
async function test(label, run) {
  try {
    await run()
    passed += 1
    console.log(`ok   ${label}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${label}`)
    console.error(error)
  }
}

/** 建一个临时清单目录。 */
async function scratch() {
  const root = await mkdtemp(join(tmpdir(), 'todo-board-test-'))
  return { root, paths: boardPaths(root) }
}

console.log('— store —')

await test('isoDate 用本地日期而不是 UTC', () => {
  // 2026-11-19 07:30 UTC+8 的 UTC 日期仍是 11-19；用 00:30 才能区分。
  const local = new Date(2026, 10, 19, 0, 30)
  assert.equal(isoDate(local), '2026-11-19')
})

await test('sectionOrder 三种种类各自有序', () => {
  assert.deepEqual(sectionOrder('todo').slice(0, 3), ['背景', '现状', '方案'])
  assert.deepEqual(sectionOrder('done').slice(0, 2), ['根因', '实现'])
  assert.deepEqual(sectionOrder('branch').slice(2, 5), ['分支', 'SQL', 'Nacos'])
  assert.deepEqual(sectionOrder('unknown'), sectionOrder('todo'))
})

await test('resolveBoardRoot 默认落在 .dsh/todo-board', () => {
  assert.match(resolveBoardRoot(''), /\.dsh[\\/]todo-board$/)
  assert.equal(resolveBoardRoot('D:\\custom\\board'), 'D:\\custom\\board')
})

await test('normalizeBoard 修好重复 id 与错位 seq', () => {
  const board = normalizeBoard({
    version: 99,
    seq: { todo: 1 },
    items: [
      { id: 'dup', kind: 'todo', number: 1, project: 'a', title: 'one' },
      { id: 'dup', kind: 'todo', number: 2, project: 'a', title: 'two' },
    ],
  })
  assert.equal(board.version, 1)
  assert.equal(new Set(board.items.map((item) => item.id)).size, 2)
  assert.equal(board.seq.todo, 2)
})

await test('createItem 补齐序号、状态、日期', () => {
  const item = createItem({ title: '写测试', project: 'deep-dreaming' }, emptyBoard())
  assert.equal(item.kind, 'todo')
  assert.equal(item.number, 1)
  assert.equal(item.status, 'TODO')
  assert.equal(item.date, isoDate())
  assert.equal(item.project, 'deep-dreaming')
})

await test('completeItem 生成 done 并保留溯源', () => {
  const board = emptyBoard()
  const source = createItem({ title: '修好 X', project: 'p', sections: { 方案: '换掉 Y' } }, board)
  board.items.push(source)
  board.seq.todo = 1
  const done = completeItem(source, board, {})
  assert.equal(done.kind, 'done')
  assert.equal(done.status, '✅')
  assert.equal(done.fromId, source.id)
  assert.equal(done.sections['实现'], '换掉 Y')
})

await test('summarize 忽略归档项', () => {
  const board = normalizeBoard({
    items: [
      { kind: 'todo', title: 'a', project: 'p' },
      { kind: 'todo', title: 'b', project: 'p', archived: true },
      { kind: 'done', title: 'c', project: 'q' },
    ],
  })
  const summary = summarize(board.items)
  assert.deepEqual(summary.counts, { todo: 1, done: 1, branch: 0 })
  assert.deepEqual(summary.projects, ['p', 'q'])
})

await test('sortItems 把待办排在已办前', () => {
  const items = sortItems([
    { id: 'a', kind: 'done', project: 'p', number: 1 },
    { id: 'b', kind: 'todo', project: 'p', number: 2 },
    { id: 'c', kind: 'branch', project: 'p', number: 3 },
  ])
  assert.deepEqual(items.map((item) => item.kind), ['todo', 'branch', 'done'])
})

await test('sortItems 按序号排，不按项目排（跨项目时编号必须单调）', () => {
  // 曾经按 project 排（分组时代的遗留），界面会把 #2 印在 #1 前面，
  // 看起来就像编号塌了。序号现在是全 kind 内连续的位置。
  const items = sortItems([
    { id: 'b', kind: 'todo', project: 'deep-dreaming', number: 2 },
    { id: 'a', kind: 'todo', project: 'taikoo-saas', number: 1 },
    { id: 'c', kind: 'todo', project: 'taikoo-saas', number: 3 },
  ])
  assert.deepEqual(items.map((item) => item.number), [1, 2, 3])
  assert.deepEqual(items.map((item) => item.id), ['a', 'b', 'c'])
})

await test('filterItems 支持按 #序号 精确过滤（`功能分支 #17` 的查询面）', () => {
  const items = [
    { id: 't1', kind: 'todo', project: 'p', number: 1 },
    { id: 'b1', kind: 'branch', project: 'p', number: 1 },
    { id: 'b17', kind: 'branch', project: 'p', number: 17 },
    { id: 'b18', kind: 'branch', project: 'p', number: 18, archived: true },
  ]
  // 只给序号：三个清单里同号的都返回（#1 在待办与功能分支里各有一条）。
  assert.deepEqual(filterItems(items, { number: 1 }).map((item) => item.id), ['t1', 'b1'])
  // 序号 + kind 才是精确定位：模型读「功能分支 #17」时应当这样查。
  assert.deepEqual(filterItems(items, { kind: 'branch', number: 17 }).map((item) => item.id), ['b17'])
  // 归档条目默认不出现；要查历史条目得显式 includeArchived。
  assert.deepEqual(filterItems(items, { kind: 'branch', number: 18 }).map((item) => item.id), [])
  assert.deepEqual(
    filterItems(items, { kind: 'branch', number: 18, includeArchived: true }).map((item) => item.id),
    ['b18'],
  )
})

console.log('— markdown —')

await test('branchSuffix 渲染三个标记', () => {
  assert.equal(branchSuffix({ ddl: true, sql: true, nacos: false }), '（有DDL，有SQL，无Nacos）')
})

await test('anchorOf 待办用 tocN、分支用 toc-slug', () => {
  assert.equal(anchorOf({ kind: 'todo', number: 7, title: 'x' }), 'toc7')
  assert.equal(anchorOf({ kind: 'branch', number: 1, title: 'AI 数据看板' }), 'toc-ai-数据看板')
})

await test('renderTodoDoc 与源文档同形（目录 + 锚点 + 小节顺序）', () => {
  const board = normalizeBoard({
    items: [{
      kind: 'todo', number: 1, project: 'taikoo-saas', title: '跨项目清单', status: '待验证', date: '2026-11-19',
      sections: { 关联: '见 DONE', 背景: '旧方式只覆盖单仓库', 方案: 'board.json + 镜像' },
    }],
  })
  const doc = renderTodoDoc(board)
  assert.match(doc, /^# TODO 清单\n/)
  assert.match(doc, /## 目录/)
  assert.match(doc, /- \[\[待验证\] 1\. 跨项目清单 — 2026-11-19\]\(#toc1\)/)
  assert.match(doc, /<a id="toc1"><\/a>/)
  assert.match(doc, /### \[待验证\] 1\. 跨项目清单 — 2026-11-19/)
  // 小节按 sectionOrder 排：背景 → 方案 → 关联
  const background = doc.indexOf('**背景**')
  const plan = doc.indexOf('**方案**')
  const relation = doc.indexOf('**关联**')
  assert.ok(background < plan && plan < relation, 'sections must follow sectionOrder')
})

await test('renderDoneDoc 用 ✅ 标题且不带序号', () => {
  const board = normalizeBoard({
    items: [{ kind: 'done', number: 3, project: 'p', title: '修好 X', status: '✅', date: '2026-11-18', sections: { 根因: '竞态' } }],
  })
  const doc = renderDoneDoc(board)
  assert.match(doc, /^# DONE 清单\n/)
  assert.match(doc, /### ✅ 修好 X — 2026-11-18/)
  assert.match(doc, /\*\*根因\*\*/)
})

await test('renderBranchDoc 带模块两级目录、后缀与汇总表', () => {
  const board = normalizeBoard({
    items: [
      {
        kind: 'branch', number: 1, project: 'taikoo-saas', module: 'Foundry SaaS',
        title: '看板保存', status: '', date: '2026-11-19',
        flags: { ddl: true, sql: true, nacos: false },
        sections: { 背景: '需要多次保存', 分支: 'feat/board · taikoo-saas-web', SQL: '无', Nacos: '无' },
      },
    ],
  })
  const doc = renderBranchDoc(board)
  assert.match(doc, /^# 功能分支整理\n/)
  assert.match(doc, /## 目录/)
  assert.match(doc, /- \[Foundry SaaS\]\(#toc-foundry-saas\)/)
  assert.match(doc, /### 看板保存（有DDL，有SQL，无Nacos）/)
  assert.match(doc, /## 模块汇总/)
  assert.match(doc, /\| Foundry SaaS \| 1 \|/)
})

await test('多项目时待办目录出现项目分组', () => {
  const board = normalizeBoard({
    items: [
      { kind: 'todo', number: 1, project: 'alpha', title: 'A', status: 'TODO', date: '2026-11-19' },
      { kind: 'todo', number: 2, project: 'beta', title: 'B', status: 'TODO', date: '2026-11-19' },
    ],
  })
  const doc = renderTodoDoc(board)
  assert.match(doc, /- \*\*alpha\*\*/)
  assert.match(doc, /    - \[\[TODO\] 2\. B — 2026-11-19\]\(#toc2\)/)
})

console.log('— import —')

await test('parseMarkdown 读 TODO 形态', () => {
  const { entries } = parseMarkdown([
    '# TODO 清单',
    '',
    '## 待办事项',
    '',
    '<a id="toc1"></a>',
    '',
    '### [TODO] 1. 跨项目清单 — 2026-11-19',
    '',
    '**背景**',
    '',
    '只覆盖单仓库。',
    '',
    '**方案**',
    '',
    'JSON + 镜像。',
    '',
    '---',
  ].join('\n'), 'todo')
  assert.equal(entries.length, 1)
  assert.equal(entries[0].number, 1)
  assert.equal(entries[0].status, 'TODO')
  assert.equal(entries[0].title, '跨项目清单')
  assert.equal(entries[0].date, '2026-11-19')
  assert.deepEqual(entries[0].sections, { 背景: '只覆盖单仓库。', 方案: 'JSON + 镜像。' })
})

await test('parseMarkdown 读 DONE 形态', () => {
  const { entries } = parseMarkdown([
    '## 已完成事项',
    '',
    '### ✅ 修好竞态 — 2026-11-18',
    '',
    '**根因**',
    '',
    '两处同时写。',
  ].join('\n'), 'done')
  assert.equal(entries.length, 1)
  assert.equal(entries[0].title, '修好竞态')
  assert.equal(entries[0].date, '2026-11-18')
  assert.equal(entries[0].sections['根因'], '两处同时写。')
})

await test('parseMarkdown 读功能分支形态（模块 + 标记）', () => {
  const { entries } = parseMarkdown([
    '# 功能分支整理',
    '',
    '## 目录',
    '',
    '## Foundry SaaS',
    '',
    '<a id="toc-board"></a>',
    '',
    '### 看板保存（有DDL，有SQL，无Nacos）',
    '',
    '**分支**',
    '',
    'taikoo-saas-web · feat/board',
  ].join('\n'), 'branch')
  assert.equal(entries.length, 1)
  assert.equal(entries[0].title, '看板保存')
  assert.equal(entries[0].module, 'Foundry SaaS')
  assert.deepEqual(entries[0].flags, { ddl: true, sql: true, nacos: false })
  assert.equal(entries[0].sections['分支'], 'taikoo-saas-web · feat/board')
})

await test('parseMarkdown 把小节前的自由段落落到首个已知小节', () => {
  const { entries } = parseMarkdown([
    '### 没有小节的条目',
    '',
    '这段没有加粗标题。',
  ].join('\n'), 'branch')
  assert.equal(entries[0].sections['背景'], '这段没有加粗标题。')
})

await test('projectOfPath 跳过 zky_doc 这类分类目录', () => {
  assert.equal(projectOfPath('D:\\GitHub\\taikoo-saas\\TODO.md'), 'taikoo-saas')
  assert.equal(projectOfPath('D:\\GitHub\\taikoo-saas\\zky_doc\\功能分支整理.md'), 'taikoo-saas')
})

console.log('— board 动作 —')

await test('add / list / update / complete / archive / delete 全链路', async () => {
  const { root, paths } = await scratch()
  try {
    const access = createBoardAccess({ rootDir: root })
    const added = await access.add({ title: '写文档', project: 'demo', sections: { 背景: '需要说明' } })
    assert.equal(added.number, 1)

    const listed = await access.list({ project: 'demo' })
    assert.equal(listed.matched, 1)
    assert.equal(listed.items[0].title, '写文档')

    const updated = await access.update(added.item.id, { status: '待验证', sections: { 方案: '先写 README' } })
    assert.equal(updated.item.status, '待验证')
    assert.equal(updated.item.sections['背景'], '需要说明')
    assert.equal(updated.item.sections['方案'], '先写 README')

    const completed = await access.complete(added.item.id, { sections: { 实现: '写了 README' } })
    assert.equal(completed.item.kind, 'done')
    const after = await access.list({ includeArchived: true })
    assert.equal(after.matched, 2)

    await access.archive(completed.item.id)
    const visible = await access.list({ includeArchived: false })
    assert.equal(visible.items.filter((item) => item.kind === 'done').length, 0)

    await access.remove(added.item.id)
    const left = await access.list({ includeArchived: true })
    assert.equal(left.matched, 1)

    // 镜像由库里的清单渲染；board.json 只在显式导出时出现。
    const todoText = await readFile(paths.todo, 'utf8')
    assert.match(todoText, /^# TODO 清单\n/)
    assert.equal(existsSync(paths.board), false, 'the live store is board.db, not board.json')
    await access.exportJson()
    const exported = JSON.parse(await readFile(paths.board, 'utf8'))
    assert.equal(exported.version, 1)
    assert.equal(exported.items.length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('完整条目走一遍后镜像内容正确', async () => {
  const { root, paths } = await scratch()
  try {
    const access = createBoardAccess({ rootDir: root })
    const added = await access.add({ title: '看板保存', kind: 'branch', project: 'taikoo-saas', module: 'Foundry SaaS', flags: { ddl: true }, sections: { 分支: 'feat/x' } })
    assert.equal(added.item.kind, 'branch')
    const doc = await readFile(paths.branch, 'utf8')
    assert.match(doc, /### 看板保存（有DDL，无SQL，无Nacos）/)
    assert.match(doc, /## Foundry SaaS/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('importFile 幂等：第二次全部跳过', async () => {
  const { root } = await scratch()
  try {
    const source = join(root, 'TODO.md')
    await writeFile(source, [
      '# TODO 清单',
      '',
      '## 待办事项',
      '',
      '### [TODO] 1. 条目一 — 2026-11-19',
      '',
      '**背景**',
      '',
      '说明一。',
      '',
      '### [TODO] 2. 条目二 — 2026-11-19',
      '',
      '**背景**',
      '',
      '说明二。',
    ].join('\n'), 'utf8')

    const access = createBoardAccess({ rootDir: join(root, 'board') })
    const first = await access.importFile({ path: source, kind: 'todo', project: 'demo' })
    assert.equal(first.imported, 2)
    assert.equal(first.skipped, 0)

    const second = await access.importFile({ path: source, kind: 'todo', project: 'demo' })
    assert.equal(second.imported, 0)
    assert.equal(second.skipped, 2)

    const listed = await access.list({})
    assert.equal(listed.matched, 2)
    assert.deepEqual(listed.items.map((item) => item.title).sort(), ['条目一', '条目二'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('importFile dryRun 不落盘', async () => {
  const { root } = await scratch()
  try {
    const source = join(root, 'DONE.md')
    await writeFile(source, '### ✅ 一件事 — 2026-11-18\n\n**根因**\n\n原因。\n', 'utf8')
    const boardRoot = join(root, 'board')
    const access = createBoardAccess({ rootDir: boardRoot })
    const dry = await access.importFile({ path: source, kind: 'done', dryRun: true })
    assert.equal(dry.imported, 1)
    assert.equal(dry.dryRun, true)
    await assert.rejects(() => readFile(boardPaths(boardRoot).board, 'utf8'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('并发 add 不丢更新', async () => {
  const { root } = await scratch()
  try {
    const access = createBoardAccess({ rootDir: root })
    await Promise.all(Array.from({ length: 12 }, (_unused, index) => access.add({ title: `并发 ${index}`, project: 'race' })))
    const listed = await access.list({ project: 'race' })
    assert.equal(listed.matched, 12)
    const numbers = listed.items.map((item) => item.number).sort((left, right) => left - right)
    assert.deepEqual(numbers, Array.from({ length: 12 }, (_unused, index) => index + 1))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('跨进程并发 add 也不丢更新、编号不重复', async () => {
  const { root } = await scratch()
  try {
    const moduleUrl = pathToFileURL(join(import.meta.dirname, '..', 'lib', 'board.js')).href
    const childPath = join(root, 'race-child.mjs')
    await writeFile(childPath, [
      `import { createBoardAccess } from ${JSON.stringify(moduleUrl)}`,
      'const access = createBoardAccess({ rootDir: process.argv[2] })',
      'for (let index = 0; index < 5; index += 1) {',
      '  await access.add({ title: process.argv[3] + " " + index, project: "xproc" })',
      '}',
    ].join('\n'), 'utf8')
    const run = (tag) => new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(process.execPath, [childPath, root, tag], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      let stderr = ''
      child.stderr.on('data', (chunk) => { stderr += String(chunk) })
      child.on('error', rejectPromise)
      child.on('exit', (code) => {
        if (code === 0) resolvePromise()
        else rejectPromise(new Error(`${tag} child exited ${code}: ${stderr}`))
      })
    })
    await Promise.all([run('a'), run('b')])

    const access = createBoardAccess({ rootDir: root })
    const listed = await access.list({ project: 'xproc' })
    assert.equal(listed.matched, 10, 'both processes must contribute all five items')
    const numbers = listed.items.map((item) => item.number).sort((left, right) => left - right)
    assert.deepEqual(numbers, Array.from({ length: 10 }, (_unused, index) => index + 1))
    assert.equal(new Set(listed.items.map((item) => item.id)).size, 10, 'ids must stay unique across processes')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('refreshMirrors 在库为空时也要建出镜像', async () => {
  const { root, paths } = await scratch()
  try {
    const access = createBoardAccess({ rootDir: root })
    await refreshMirrors(access)
    assert.match(await readFile(paths.todo, 'utf8'), /^# TODO 清单\n/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('坏 board.json 在迁移时报 board-corrupt 而不是静默清空', async () => {
  const { root, paths } = await scratch()
  try {
    await writeFile(paths.board, '{ not json', 'utf8')
    const access = createBoardAccess({ rootDir: root })
    await assert.rejects(() => access.list({}), (error) => error.code === 'board-corrupt')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('旧 board.json 首次加载自动迁移进 board.db 并留备份', async () => {
  const { root, paths } = await scratch()
  try {
    // 造一份旧格式 JSON（与迁移前插件写出的结构一致）。
    await writeFile(paths.board, JSON.stringify({
      version: 1,
      updatedAt: '2026-11-19T00:00:00.000Z',
      seq: { todo: 2, done: 0, branch: 0 },
      items: [
        { id: 'tb_t_old1', kind: 'todo', number: 1, project: 'p', title: '旧待办一', status: 'TODO', date: '2026-11-19', sections: { 背景: '旧数据' }, tags: [], createdAt: '2026-11-19T00:00:00.000Z', updatedAt: '2026-11-19T00:00:00.000Z' },
        { id: 'tb_t_old2', kind: 'todo', number: 2, project: 'p', title: '旧待办二', status: 'TODO', date: '2026-11-19', sections: {}, tags: [], createdAt: '2026-11-19T00:00:00.000Z', updatedAt: '2026-11-19T00:00:00.000Z' },
      ],
    }), 'utf8')

    const access = createBoardAccess({ rootDir: root })
    const listed = await access.list({})
    assert.equal(listed.matched, 2)
    assert.equal(listed.items[0].title, '旧待办一')
    assert.ok(existsSync(paths.db), 'board.db must be created by the migration')
    assert.equal(existsSync(paths.board), false, 'the migrated JSON must be renamed to a .bak')
    const backups = (await readdir(root)).filter((name) => name.startsWith('board.json.migrated-') && name.endsWith('.bak'))
    assert.equal(backups.length, 1, 'exactly one migration backup')

    // 再读一次不重复导入、编号不变。
    const again = await createBoardAccess({ rootDir: root }).list({})
    assert.equal(again.matched, 2)
    assert.deepEqual(again.items.map((item) => item.number), [1, 2])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('SQLite 往返保留 archived / fromId / sections', async () => {
  const { root } = await scratch()
  try {
    const access = createBoardAccess({ rootDir: root })
    const added = await access.add({ title: '待办甲', project: 'p', sections: { 背景: '起因' } })
    await access.complete(added.item.id, { sections: { 实现: '做了' } })
    // 换一个访问器（相当于关库重开），确认字段真的落进了表而不是内存。
    const board = await createBoardAccess({ rootDir: root }).read()
    const done = board.items.find((item) => item.kind === 'done')
    assert.ok(done !== undefined)
    assert.equal(done.fromId, added.item.id)
    assert.equal(done.sections['实现'], '做了')
    const source = board.items.find((item) => item.id === added.item.id)
    assert.equal(source.archived, true)
    assert.equal(source.sections['背景'], '起因')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('空标题被拒（title-required）', async () => {
  const { root } = await scratch()
  try {
    const access = createBoardAccess({ rootDir: root })
    await assert.rejects(() => access.add({ title: '   ' }), (error) => error.code === 'title-required')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('不存在的 id 报 item-not-found', async () => {
  const { root } = await scratch()
  try {
    const access = createBoardAccess({ rootDir: root })
    await assert.rejects(() => access.update('nope', { title: 'x' }), (error) => error.code === 'item-not-found')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

assert.deepEqual(KINDS, ['todo', 'done', 'branch'])

console.log('— 右侧边栏的详情 —')

await test('renderItemDoc 的三种标题形态与源文档一致', () => {
  // 详情页看到的标题必须与镜像里那一段逐字相同，否则「界面一套、文件一套」。
  const board = normalizeBoard(emptyBoard())
  const todo = createItem({ kind: 'todo', project: 'p', title: '待办甲', status: '待验证', date: '2026-11-19', sections: { 背景: '起因' } }, board)
  const done = createItem({ kind: 'done', project: 'p', title: '已办乙', date: '2026-11-18', sections: { 实现: '做了' } }, board)
  const branch = createItem({ kind: 'branch', project: 'p', module: 'Foundry SaaS', title: '分支丙', flags: { ddl: true, sql: true, nacos: false }, tags: ['cache', '权限'], sections: { 分支: 'repo/x' } }, board)

  assert.match(renderItemDoc(todo), /^### \[待验证\] 1\. 待办甲 — 2026-11-19$/m)
  assert.match(renderItemDoc(done), /^### ✅ 已办乙 — 2026-11-18$/m)
  assert.match(renderItemDoc(branch), /^### 分支丙（有DDL，有SQL，无Nacos）$/m)
  // 小节用加粗标题渲染，正文跟在空行之后 —— MarkdownText 靠这个认出段落。
  assert.match(renderItemDoc(todo), /\*\*背景\*\*\n\n起因/)
  // 元信息与 tags 走 Markdown（斜体 / 行内代码），不能用 HTML 的 `<sub>`：平台的
  // MarkdownText 把裸 HTML 当纯文本渲染，<sub> 会原样显示成尖括号（实测报过）。
  assert.match(renderItemDoc(branch), /^\*p · Foundry SaaS\*$/m)
  assert.match(renderItemDoc(branch), /^`cache` `权限`$/m)
  assert.equal(renderItemDoc(branch).includes('<sub>'), false, 'no raw HTML may leak into the detail document')
})

await test('renderItemDoc 空小节给出可读的提示而不是空白', () => {
  const board = normalizeBoard(emptyBoard())
  const bare = createItem({ kind: 'todo', project: 'p', title: '没正文', date: '2026-11-19' }, board)
  assert.match(renderItemDoc(bare), /_这条事项还没有正文小节。_/)
})

await test('access.detail 取回 markdown 且与镜像里的那一段同源', async () => {
  const { root } = await scratch()
  try {
    const access = createBoardAccess({ rootDir: root })
    const added = await access.add({ title: '详情甲', sections: { 背景: '一句话背景' } })
    const detail = await access.detail(added.item.id)
    assert.equal(detail.item.id, added.item.id)
    assert.match(detail.markdown, /^### \[TODO\] 1\. 详情甲/m)
    assert.match(detail.markdown, /\*\*背景\*\*\n\n一句话背景/)
    // 镜像文件里能找到同一段正文：详情页与文件不会各说一套。
    const mirror = await readFile(access.paths.todo, 'utf8')
    assert.ok(mirror.includes('**背景**\n\n一句话背景'), 'the mirror must carry the same body')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('access.detail 对不存在的 id 报 item-not-found', async () => {
  const { root } = await scratch()
  try {
    const access = createBoardAccess({ rootDir: root })
    await assert.rejects(() => access.detail('nope'), (error) => error.code === 'item-not-found')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

console.log('\n— /workboard 命令 —')

/** 造一条命令调用。handler 只读 `agent.session.header.cwd` 与 `rawInput`。 */
function invocationOf(rawInput, cwd = 'D:\\GitHub\\deep-dreaming') {
  return { agent: { session: { header: { cwd } } }, rawInput, attachments: [], signal: new AbortController().signal }
}

await test('resolveRef 认 #序号、裸数字与完整 id，并按 kind 限定', () => {
  const items = [
    { id: 'a', kind: 'todo', number: 1, title: '待办一' },
    { id: 'b', kind: 'done', number: 1, title: '已办一' },
    { id: 'c', kind: 'todo', number: 7, title: '待办七', archived: true },
  ]
  assert.equal(resolveRef(items, '#1', ['todo']).id, 'a')
  assert.equal(resolveRef(items, '1', ['done']).id, 'b')
  // 同号的多条里优先未归档的那条。
  const mixed = [{ id: 'x', kind: 'todo', number: 1, title: '旧的', archived: true }, { id: 'y', kind: 'todo', number: 1, title: '新的' }]
  assert.equal(resolveRef(mixed, '#1').id, 'y')
  assert.equal(resolveRef(items, 'tb_unknown'), undefined)
  assert.equal(resolveRef(items, ''), undefined)
})

await test('inferKind 先看显式参数，再按文件名认三份文档', () => {
  assert.equal(inferKind('done', 'whatever.md'), 'done')
  assert.equal(inferKind('', 'D:\\taikoo-saas\\TODO.md'), 'todo')
  assert.equal(inferKind('', 'D:\\taikoo-saas\\DONE.md'), 'done')
  assert.equal(inferKind('', 'D:\\taikoo-saas\\zky_doc\\功能分支整理.md'), 'branch')
  assert.equal(inferKind('', 'D:\\notes\\random.md'), undefined)
})

await test('/workboard <标题> 记一条待办，project 取工作区目录名', async () => {
  const { root } = await scratch()
  try {
    const access = createBoardAccess({ rootDir: root })
    let refreshed = 0
    const result = await executeTodoCommand(access, invocationOf('修好登录页的报错'), { onChanged: () => { refreshed += 1 } })
    assert.equal(result.kind, 'success')
    assert.match(result.text, /已记到跨项目工作清单：/)
    assert.match(result.text, /deep-dreaming/)
    // 写动作必须让提示词缓存失效，否则下一轮还读旧摘要。
    assert.equal(refreshed, 1)
    const view = await access.view()
    assert.equal(view.items[0].title, '修好登录页的报错')
    assert.equal(view.items[0].project, 'deep-dreaming')
    // 镜像同时落盘。
    assert.match(await readFile(access.paths.todo, 'utf8'), /修好登录页的报错/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('/workboard 无参列出未完成项，且不含已办', async () => {
  const { root } = await scratch()
  try {
    const access = createBoardAccess({ rootDir: root })
    const added = await access.add({ title: '甲', project: 'p' })
    await access.add({ title: '乙', project: 'p' })
    await access.complete(added.item.id, {})
    const result = await executeTodoCommand(access, invocationOf(''))
    assert.equal(result.kind, 'success')
    assert.match(result.text, /未完成的待办 1 条/)
    // 归档的「甲」仍是 #1，剩下的「乙」保持创建时的 #2——编号是稳定引用，
    // 不随列表位置变化（这是用户明确要求的：他给的 #N 不能因为完成/删除而指到别的条目）。
    assert.match(result.text, /#2 \[TODO\] · p  乙/)
    assert.ok(!result.text.includes('甲'), 'the completed item must not be listed as open')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('删除中间一条不回填编号，历史水位不下降', async () => {
  const { root } = await scratch()
  try {
    const access = createBoardAccess({ rootDir: root })
    const first = await access.add({ title: '甲', project: 'p' })
    const second = await access.add({ title: '乙', project: 'p' })
    const third = await access.add({ title: '丙', project: 'p' })
    assert.deepEqual([first.number, second.number, third.number], [1, 2, 3])

    // 删掉中间那条：剩下两条保持 #1 / #3，不会把「丙」改成 #2。
    await access.remove(second.item.id)
    const view = await access.view()
    assert.deepEqual(view.items.map((item) => item.number), [1, 3])
    assert.deepEqual(view.items.map((item) => item.title), ['甲', '丙'])
    // seq 是历史水位，不能因为硬删除降到 2，否则下一条会复用 #3。
    assert.equal(view.board.seq.todo, 3)

    // 镜像里的编号与界面同源（都读 `item.number`）。
    const todoDoc = await readFile(access.paths.todo, 'utf8')
    assert.match(todoDoc, /\[TODO\] 1\. 甲/)
    assert.match(todoDoc, /\[TODO\] 3\. 丙/)

    // 再新增一条：接在历史水位之后成为 #4，而不是复用删除的 #2。
    const fourth = await access.add({ title: '丁', project: 'p' })
    assert.equal(fourth.number, 4)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('完成中间一条后，后面的编号保持不动，跨项目也一样', async () => {
  const { root } = await scratch()
  try {
    const access = createBoardAccess({ rootDir: root })
    // 交错两个项目：排序不能按 project，否则界面上会出现 #2 排在 #1 前面。
    const a = await access.add({ title: '甲', project: 'taikoo-saas' })
    const b = await access.add({ title: '乙', project: 'deep-dreaming' })
    await access.add({ title: '丙', project: 'taikoo-saas' })
    assert.deepEqual((await access.view()).items.map((item) => item.number), [1, 2, 3])

    // 完成 #2（乙）：剩下的待办编号保持「甲 #1、丙 #3」，不回填。
    // 注意 `view.items` 是混合视图（已办排在最后），这里只看待办。
    await access.complete(b.item.id, {})
    const view = await access.view()
    const open = view.items.filter((item) => item.kind === 'todo')
    assert.deepEqual(open.map((item) => item.title), ['甲', '丙'])
    assert.deepEqual(open.map((item) => item.number), [1, 3])
    // 已办自己也是从 #1 起算的。
    assert.deepEqual(
      view.items.filter((item) => item.kind === 'done').map((item) => item.number),
      [1],
    )

    // 再新增接在历史水位之后成为 #4，回执里的号码就是存盘后的那个。
    const added = await access.add({ title: '丁', project: 'deep-dreaming' })
    assert.equal(added.number, 4)
    assert.deepEqual(
      (await access.view()).items.filter((item) => item.kind === 'todo').map((item) => item.number),
      [1, 3, 4],
    )

    const todoDoc = await readFile(access.paths.todo, 'utf8')
    assert.match(todoDoc, /\[TODO\] 1\. 甲/)
    assert.match(todoDoc, /\[TODO\] 3\. 丙/)
    assert.match(todoDoc, /\[TODO\] 4\. 丁/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('/workboard renumber 预览不写，confirm 整理编号', async () => {
  const { root } = await scratch()
  try {
    const access = createBoardAccess({ rootDir: root })
    await access.add({ title: '甲', project: 'p' })
    const second = await access.add({ title: '乙', project: 'p' })
    await access.add({ title: '丙', project: 'p' })
    await access.remove(second.item.id)
    assert.deepEqual((await access.view()).items.map((item) => item.number), [1, 3])

    const preview = await executeTodoCommand(access, invocationOf('renumber'))
    assert.equal(preview.kind, 'success')
    assert.match(preview.text, /编号整理预览/)
    assert.match(preview.text, /丙  #3 → #2/)
    // 预览不能落盘：编号仍然是 #1 / #3。
    assert.deepEqual((await access.view()).items.map((item) => item.number), [1, 3])

    const confirmed = await executeTodoCommand(access, invocationOf('renumber confirm'))
    assert.equal(confirmed.kind, 'success')
    assert.match(confirmed.text, /已整理 1 条编号/)
    const after = await access.view()
    assert.deepEqual(after.items.map((item) => item.number), [1, 2])
    assert.equal(after.board.seq.todo, 2)

    // 整理后新号从压缩后的末尾继续；旧的 #3 引用已失效（这里 #3 属于新条目）。
    const added = await access.add({ title: '丁', project: 'p' })
    assert.equal(added.number, 3)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('/workboard done 用 #序号 完成，回执带上新编号', async () => {
  const { root } = await scratch()
  try {
    const access = createBoardAccess({ rootDir: root })
    await access.add({ title: '要被完成的', project: 'p' })
    const result = await executeTodoCommand(access, invocationOf('done #1'))
    assert.equal(result.kind, 'success')
    assert.match(result.text, /已办：/)
    const view = await access.view()
    assert.equal(view.items.filter((item) => item.kind === 'done').length, 1)
    // 原条目归档而不是消失。
    assert.equal(view.board.items.find((item) => item.kind === 'todo').archived, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('/workboard done 对不存在的序号给人话，而不是抛栈', async () => {
  const { root } = await scratch()
  try {
    const access = createBoardAccess({ rootDir: root })
    const result = await executeTodoCommand(access, invocationOf('done #99'))
    assert.equal(result.kind, 'error')
    assert.match(result.text, /找不到 #99/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('/workboard del 真的删掉', async () => {
  const { root } = await scratch()
  try {
    const access = createBoardAccess({ rootDir: root })
    await access.add({ title: '待删', project: 'p' })
    const result = await executeTodoCommand(access, invocationOf('del #1'))
    assert.equal(result.kind, 'success')
    assert.match(result.text, /已删除：/)
    const view = await access.view()
    assert.equal(view.board.items.length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('/workboard import 按文件名认 kind 并幂等', async () => {
  const { root } = await scratch()
  const source = await mkdtemp(join(tmpdir(), 'todo-board-src-'))
  try {
    const access = createBoardAccess({ rootDir: root })
    const doc = join(source, 'DONE.md')
    await writeFile(doc, [
      '# DONE 清单',
      '',
      '## 已完成事项',
      '',
      '### ✅ 修好了一个 bug — 2026-11-18',
      '',
      '**根因**',
      '',
      '空指针。',
      '',
    ].join('\n'), 'utf8')
    const first = await executeTodoCommand(access, invocationOf(`import ${doc}`))
    assert.equal(first.kind, 'success')
    assert.match(first.text, /导入 1 条（done/)
    const second = await executeTodoCommand(access, invocationOf(`import ${doc}`))
    assert.match(second.text, /导入 0 条（done，跳过已存在的 1 条）/)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(source, { recursive: true, force: true })
  }
})

await test('/workboard import 认不出 kind 时要求显式给出', async () => {
  const { root } = await scratch()
  try {
    const access = createBoardAccess({ rootDir: root })
    const result = await executeTodoCommand(access, invocationOf('import D:\\notes\\random.md'))
    assert.equal(result.kind, 'error')
    assert.match(result.text, /判断不出/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('/workboard export 重写三份镜像', async () => {
  const { root } = await scratch()
  try {
    const access = createBoardAccess({ rootDir: root })
    await access.add({ title: '有东西才写', project: 'p' })
    const result = await executeTodoCommand(access, invocationOf('export'))
    assert.equal(result.kind, 'success')
    assert.match(result.text, /已重写 3 份 Markdown 镜像/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('/workboard help 与写错的子命令都给出用法', async () => {
  const { root } = await scratch()
  try {
    const access = createBoardAccess({ rootDir: root })
    const help = await executeTodoCommand(access, invocationOf('help'))
    assert.match(help.text, /\/workboard done <id\|#序号>/)
    const missing = await executeTodoCommand(access, invocationOf('done'))
    assert.equal(missing.kind, 'error')
    assert.match(missing.text, /缺少要标记已办的事项/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('archiveAll 一键归档「已办」：全部软删除、镜像同步、不动其他清单', async () => {
  const { root, paths } = await scratch()
  try {
    const access = createBoardAccess({ rootDir: root })
    await access.add({ kind: 'done', title: '已办一', project: 'p1', date: '2026-11-20' })
    await access.add({ kind: 'done', title: '已办二', project: 'p2', date: '2026-11-21' })
    await access.add({ kind: 'todo', title: '待办一', project: 'p1' })
    await access.add({ kind: 'branch', title: '分支一', project: 'p1', module: 'm' })

    const first = await access.archiveAll('done')
    assert.deepEqual(first, { kind: 'done', archived: 2 })

    // 软删除：条目仍在 board.json 里，只是标了 archived；其他清单不受影响。
    const board = await access.read()
    const done = board.items.filter((item) => item.kind === 'done')
    assert.equal(done.length, 2, '归档是软删除，不能把条目从库里抹掉')
    for (const item of done) assert.equal(item.archived, true)
    assert.equal(board.items.filter((item) => item.kind === 'todo' && item.archived !== true).length, 1)
    assert.equal(board.items.filter((item) => item.kind === 'branch' && item.archived !== true).length, 1)

    // 计数与镜像同步：已办 0，DONE.md 回到空态。
    const view = await access.view()
    assert.equal(view.summary.counts.done, 0)
    assert.ok((await readFile(paths.done, 'utf8')).includes('暂无已完成事项'))
    // 系统提示词里的摘要也按「未归档」计，不能把刚归档的已办算进去。
    assert.match(view.prompt, /已办 0 条/)

    // 再点一次：没有可归档的，不写盘（changed=false）。
    const again = await access.archiveAll('done')
    assert.deepEqual(again, { kind: 'done', archived: 0 })

    // 未知清单种类必须报错，而不是静默什么都不做。
    await assert.rejects(() => access.archiveAll('nope'), (error) => error?.code === 'unknown-kind')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await test('isDuplicateCommand 只认命令重名那一种消息', () => {
  assert.equal(isDuplicateCommand(new Error('command "todo" is already registered (for a per-agent variant, mount a command-injected plugin under that agent\'s `agent.ctx`)'), 'todo'), true)
  assert.equal(isDuplicateCommand(new Error('command "other" is already registered'), 'todo'), false)
  assert.equal(isDuplicateCommand(new Error('boom'), 'todo'), false)
  assert.equal(isDuplicateCommand(undefined, 'todo'), false)
})

console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILED'} — ok ${passed} / fail ${failed}`)
if (failed > 0) process.exitCode = 1