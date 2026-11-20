/**
 * todo-board 的领域动作层：把 `store.js`（数据）与 `markdown.js`（镜像）缝在
 * 一起，向上给工具、HTTP 路由和设置页提供同一组动作。
 *
 * 所有写动作都走 `withBoardLock`：不同工作区的会话可能**同时**调用工具，而
 * 一次调用是 read→modify→write 三步；不加锁时后写的会把先写的新增整条覆盖掉。
 * 写成功之后顺手重写三份 Markdown 镜像——镜像永远与 JSON 同一次提交，不存在
 * "JSON 改了、文档还是旧的"的窗口。
 */
import { readFile } from 'node:fs/promises'
import {
  KINDS,
  boardPaths,
  cleanText,
  compactNumbers,
  completeItem,
  createItem,
  filterItems,
  loadBoard,
  mergeItem,
  normalizeBoard,
  nowIso,
  resolveBoardRoot,
  saveBoard,
  sortItems,
  summarize,
  withBoardLock,
  writeTextAtomic,
} from './store.js'
import { mirrorPaths, renderItemDoc, renderMirrors, renderSummary } from './markdown.js'
import { parseMarkdown, projectOfPath } from './import.js'

/**
 * 清单访问器：把「配置 → 根目录 → 路径」这段解析收在一次调用里，并挂上面向
 * 工具/路由的动作方法。
 *
 * 三种用法并存是有意的：`read`/`write` 是底层原语（测试与特殊动作直接用），
 * `list`/`add`/`update`/… 是工具调用的动作，末尾的 `view`/`refreshMirrors`
 * 是面板与设置页要的整体视图。全部共享同一个 `paths`，所以换根目录只需构造
 * 一次访问器。
 * @param config - 已解盒的插件配置（至少含 `rootDir`）。
 */
export function createBoardAccess(config) {
  const paths = boardPaths(resolveBoardRoot(config?.rootDir))
  const access = {
    paths,
    /**
     * 只读快照。
     * @returns 规范化后的清单。
     */
    read: () => loadBoard(paths),
    /**
     * 在锁内读改写，落盘 JSON 后重写镜像。
     * @param mutate - `(board) => ({ board, result, changed })`；
     *   `changed` 为 false 时只读不写（例如查询类动作也走同一条路时）。
     * @returns 变更返回值与落盘后的清单。
     */
    async write(mutate) {
      return withBoardLock(paths.root, async () => {
        const board = normalizeBoard(await loadBoard(paths))
        const outcome = await mutate(board)
        if (outcome === undefined || outcome.changed === false) {
          return { board, result: outcome?.result, saved: board }
        }
        const saved = await saveBoard(paths, outcome.board ?? board)
        await writeMirrors(paths, saved)
        return { board: saved, result: outcome.result, saved }
      })
    },
    /** 查询（只读）。 */
    list: (options) => listItems(access, options),
    /** 新增一条。 */
    async add(input) {
      const outcome = await addItem(access, input)
      // 编号在创建时分配、落盘时保留（`assignStableNumbers` 不会按位置重排），
      // 所以回执里的编号读存盘后的那份，和镜像/列表看到的一致。
      const id = outcome.result.item.id
      const saved = outcome.saved.items.find((item) => item.id === id) ?? outcome.result.item
      return { item: saved, number: saved.number }
    },
    /** 更新一条。 */
    async update(id, patch) {
      const outcome = await updateItem(access, id, patch)
      const saved = outcome.saved.items.find((item) => item.id === id) ?? outcome.result.item
      return { item: saved }
    },
    /** 完成一条（生成 done）。 */
    async complete(id, patch) {
      const outcome = await completeItemById(access, id, patch ?? {})
      // 同上：done 的编号也在存盘后读，避免回执与镜像不一致。
      const doneId = outcome.result.item.id
      const saved = outcome.saved.items.find((item) => item.id === doneId) ?? outcome.result.item
      return { item: saved, archived: outcome.result.archived }
    },
    /** 归档（软删除）。 */
    async archive(id) {
      const outcome = await archiveItem(access, id)
      return outcome.result
    },
    /** 硬删除。 */
    async remove(id) {
      const outcome = await deleteItem(access, id)
      return outcome.result
    },
    /** 从 Markdown 导入。 */
    importFile: (options) => importFile(access, options),
    /** 只重写镜像。 */
    refreshMirrors: () => refreshMirrors(access),
    /** 单条详情（右侧边栏的详情页用）。 */
    detail: (id) => itemDetail(access, id),
    /** 面板/提示词用的整体视图。 */
    view: () => boardView(access),
  }
  return access
}

/**
 * 重写三份 Markdown 镜像。
 *
 * 单独成函数是因为「只重写镜像、不动 JSON」也是一个合法动作（用户删了某个
 * .md 想让它长回来）。镜像写失败不能回滚 JSON：JSON 才是权威数据，镜像只是
 * 视图；把错误抛给调用方让它显示在结果里即可。
 * @param paths - `boardPaths()` 的结果。
 * @param board - 清单。
 */
export async function writeMirrors(paths, board) {
  const rendered = renderMirrors(board)
  const targets = mirrorPaths(paths)
  const written = []
  for (const [kind, text] of Object.entries(rendered)) {
    await writeTextAtomic(targets[kind], text)
    written.push(targets[kind])
  }
  return written
}

/**
 * 新增一条事项。
 * @param access - `createBoardAccess()` 的结果。
 * @param input - `{ kind, project, title, status, date, sections, tags, module, flags }`。
 */
export async function addItem(access, input) {
  if (typeof input?.title !== 'string' || input.title.trim().length === 0) {
    throw badRequest('title-required', 'title 不能为空：新增事项至少要有一句可读的标题')
  }
  return access.write((board) => {
    const item = createItem(input, board)
    return {
      changed: true,
      board: { ...board, seq: { ...board.seq, [item.kind]: item.number }, items: [...board.items, item] },
      result: { item, number: item.number },
    }
  })
}

/**
 * 更新一条事项。
 * @param access - 访问器。
 * @param id - 事项 id。
 * @param patch - 变更（见 `mergeItem`）。
 */
export async function updateItem(access, id, patch) {
  return access.write((board) => {
    const index = board.items.findIndex((item) => item.id === id)
    if (index === -1) throw badRequest('item-not-found', `没有 id 为 ${id} 的事项`, { id })
    const next = mergeItem(board.items[index], patch ?? {})
    const items = [...board.items]
    items[index] = next
    return { changed: true, board: { ...board, items }, result: { item: next } }
  })
}

/**
 * 把一条待办标记为已办：原条目归档、新建一条 `done` 事项。
 * @param access - 访问器。
 * @param id - 待办 id。
 * @param patch - 完成信息（`{ sections, tags, date }`）。
 */
export async function completeItemById(access, id, patch) {
  return access.write((board) => {
    const index = board.items.findIndex((item) => item.id === id)
    if (index === -1) throw badRequest('item-not-found', `没有 id 为 ${id} 的事项`, { id })
    const source = board.items[index]
    if (source.kind === 'done') throw badRequest('already-done', `id ${id} 已经是已办事项`, { id })
    const done = completeItem(source, board, patch ?? {})
    const items = [...board.items]
    items[index] = { ...source, archived: true, updatedAt: nowIso(), completedId: done.id }
    items.push(done)
    return {
      changed: true,
      board: { ...board, seq: { ...board.seq, done: done.number }, items },
      result: { item: done, archived: source.id },
    }
  })
}

/**
 * 显式整理编号：每个 kind 内按「未归档在前、归档在后」重排成 1..N。
 *
 * 这是唯一会主动改变已有编号的入口，必须由用户确认（命令的 `confirm`）。
 * 整理后旧 `#N` 引用失效；不在每次保存时自动重排，就是为了不让用户刚给的
 * 编号在下一轮悄悄指向别的条目。
 * @param access - 访问器。
 * @returns `{ count, changes, seq }`。
 */
export async function renumberBoard(access) {
  return access.write((board) => {
    const plan = compactNumbers(board.items)
    const changes = plan.changes.map(({ item, from, to }) => ({
      id: item.id,
      kind: item.kind,
      title: item.title,
      archived: item.archived === true,
      from,
      to,
    }))
    if (changes.length === 0) {
      return { changed: false, result: { count: 0, changes: [], seq: plan.seq } }
    }
    return {
      changed: true,
      board: { ...board, seq: plan.seq, items: board.items },
      result: { count: changes.length, changes, seq: plan.seq },
    }
  }).then((outcome) => outcome.result)
}

/**
 * 归档（软删除）一条事项：从目录与镜像里消失，但 JSON 里保留。
 * @param access - 访问器。
 * @param id - 事项 id。
 */
export async function archiveItem(access, id) {
  return access.write((board) => {
    const index = board.items.findIndex((item) => item.id === id)
    if (index === -1) throw badRequest('item-not-found', `没有 id 为 ${id} 的事项`, { id })
    const items = [...board.items]
    items[index] = { ...items[index], archived: true, updatedAt: nowIso() }
    return { changed: true, board: { ...board, items }, result: { id, archived: true } }
  })
}

/**
 * 硬删除一条事项：真的从 board.json 里抹掉。
 *
 * 与 `archiveItem` 分开是有意的：归档是日常工作（完成、清理视图），删除是
 * 危险动作，需要调用方明确选择。两者都不动 Markdown 镜像以外的东西。
 * @param access - 访问器。
 * @param id - 事项 id。
 */
export async function deleteItem(access, id) {
  return access.write((board) => {
    const items = board.items.filter((item) => item.id !== id)
    if (items.length === board.items.length) throw badRequest('item-not-found', `没有 id 为 ${id} 的事项`, { id })
    return { changed: true, board: { ...board, items }, result: { id, deleted: true } }
  })
}

/**
 * 查询事项（只读，不落盘）。
 * @param access - 访问器。
 * @param options - `{ kind, project, status, module, query, includeArchived, limit }`。
 */
export async function listItems(access, options = {}) {
  const board = normalizeBoard(await access.read())
  const all = sortItems(filterItems(board.items, options))
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : all.length
  return {
    items: all.slice(0, limit),
    matched: all.length,
    truncated: all.length > limit,
    summary: summarize(board.items),
  }
}

/**
 * 只重写镜像（JSON 不动）。
 *
 * 走 `write` 的锁是必要的：镜像由 board.json 渲染，如果此刻另一路正在写 JSON，
 * 不加锁就可能把旧内容盖在新镜像上。`changed:false` 让 `write` 跳过 JSON 落盘，
 * 这里再单独写三份 Markdown。
 * @param access - 访问器。
 */
export async function refreshMirrors(access) {
  return withBoardLock(access.paths.root, async () => {
    const board = normalizeBoard(await loadBoard(access.paths))
    const written = await writeMirrors(access.paths, board)
    return { written, summary: summarize(board.items) }
  })
}

/**
 * 从 Markdown 文档导入事项。
 *
 * 幂等：`project + title + kind` 已存在的条目计为 skipped，所以对同一份文档
 * 反复导入不会产生重复项——用户升级 TODO.md 之后可以再跑一次。
 * @param access - 访问器。
 * @param options - `{ path, kind, project?, module?, dryRun? }`。
 */
export async function importFile(access, options) {
  const filePath = String(options?.path ?? '')
  if (filePath.length === 0) throw badRequest('path-required', '需要给出要导入的 Markdown 文件路径')
  let text
  try {
    text = await readFile(filePath, 'utf8')
  } catch (cause) {
    throw badRequest('import-unreadable', `读不到文件 ${filePath}：${cause.message}`, { path: filePath })
  }
  const kind = KINDS.includes(options?.kind) ? options.kind : 'todo'
  const project = cleanText(options?.project) || projectOfPath(filePath) || '未归类'
  const parsed = parseMarkdown(text, kind)
  if (parsed.entries.length === 0) {
    throw badRequest('import-empty', `${filePath} 里没有认出任何条目（期望 \`### \` 开头的标题）`, { path: filePath })
  }
  if (options?.dryRun === true) {
    return {
      imported: parsed.entries.length,
      skipped: 0,
      project,
      titles: parsed.entries.slice(0, 50).map((entry) => entry.title),
      dryRun: true,
    }
  }
  return access.write((board) => {
    const seen = new Set(board.items.map((item) => `${item.kind}\u0000${item.project}\u0000${item.title}`))
    const added = []
    let skipped = 0
    let seq = { ...board.seq }
    const items = [...board.items]
    for (const entry of parsed.entries) {
      const key = `${kind}\u0000${project}\u0000${entry.title}`
      if (seen.has(key)) { skipped += 1; continue }
      seen.add(key)
      seq = { ...seq, [kind]: (seq[kind] ?? 0) + 1 }
      items.push(createItem({
        kind,
        project,
        title: entry.title,
        status: entry.status,
        date: entry.date,
        sections: entry.sections,
        module: entry.module ?? options?.module,
        flags: entry.flags,
      }, { ...board, seq }))
      added.push(entry.title)
    }
    return {
      changed: added.length > 0,
      board: { ...board, seq, items },
      result: { imported: added.length, skipped, project, titles: added.slice(0, 50), dryRun: false },
    }
  }).then((outcome) => outcome.result)
}

/**
 * 面板/设置页需要的完整视图：清单 + 计数 + 路径。
 * @param access - 访问器。
 */
export async function boardView(access) {
  const board = normalizeBoard(await access.read())
  return {
    board,
    summary: summarize(board.items),
    prompt: renderSummary(board),
    paths: access.paths,
    items: sortItems(board.items.filter((item) => item.archived !== true)),
  }
}

/**
 * 单条事项的详情：渲染好的 Markdown + 正文原来的小节，给右侧边栏的详情页用。
 *
 * 镜像里那一段与这里同源（都走 `renderItemDoc`），所以「详情页看到的」与
 * 「文件里写的」必然是同一份文本。
 * @param access - 访问器。
 * @param id - 事项 id。
 */
export async function itemDetail(access, id) {
  const board = normalizeBoard(await access.read())
  const item = board.items.find((candidate) => candidate.id === id)
  if (item === undefined) {
    throw badRequest('item-not-found', `没有 id 为 ${String(id)} 的事项`, { id })
  }
  return { item, markdown: renderItemDoc(item) }
}

/**
 * 构造带错误码的请求错误，路由层据此给出 `{ ok:false, error }` 信封。
 * @param code - 机器可读错误码。
 * @param message - 面向人的说明。
 * @param details - 附加信息。
 */
export function badRequest(code, message, details = {}) {
  const error = new Error(message)
  error.code = code
  error.details = details
  return error
}