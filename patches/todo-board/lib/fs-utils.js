/**
 * 文件写入的原子封装。
 *
 * 直接 `writeFile` 到目标路径时，进程在写一半被杀会留下半份文件；rename 在同一
 * 卷上是原子的，读者要么看到旧版要么看到新版。板数据已经搬到 SQLite，这个工具
 * 现在只服务三份 Markdown 镜像与显式导出的 `board.json`。
 */
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'

/**
 * 原子写文本：先写同目录临时文件再 rename。
 * @param path - 目标文件。
 * @param text - 完整内容。
 */
export async function writeTextAtomic(path, text) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(temporary, text, 'utf8')
  await rename(temporary, path)
}
