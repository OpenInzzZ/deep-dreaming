# whale-background

会话区域背景插件:在对话滚动区居中偏右显示鲸鱼娘透明图(13% 透明度)。

## 功能

- 在会话对话区域(`[data-conversation-scroll]`)居中偏右(水平中心再右移 125px,
  垂直居中)显示鲸鱼娘背景图:伪元素固定定位、`pointer-events: none`,
  不干扰阅读与交互;
- 图片采用 13% 透明度(`opacity: 0.13`),不干扰正常阅读;
- 背景源为 `whale-girl-transparent.png`,由 host 半以固定路由提供,
  客户端半只注入一段 CSS。

## 实现原理(两半各干一件事)

- **Host 半(`lib/index.js`)**:`inject: ['webServer']`,在 `apply` 里用
  `ctx.webServer.register({ kind: 'exact', path: '/whale-background.png', handler })`
  提供图片(启动时同步读入内存,带 `cache-control: public, max-age=86400`),
  `ctx.effect(...)` 保证卸载即注销路由。
  > 早期版本用 `ctx.get('webServer')` + 提前 return,服务尚未 active 时静默
  > 跳过注册,表现为「鲸鱼娘失踪」;现在靠 `inject` 声明依赖并由测试守住。
- **Client 半(`lib/client.js`)**:手写 bundle,经
  `window.__ModuleLoader__.load` 注册;Cordis `apply` 本身不做事,真正的
  动作是**模块体样式注入**——`style[data-plugin=...][data-plugin-css=...]`
  标签,由模块加载器在卸载时按 tag 回收。CSS 用 `::before` 伪元素 +
  `background-image: url("/whale-background.png")` 定位到
  `[data-conversation-scroll]::before`。

## 依赖与升级注意

- 图片资源按候选列表依次查找,第一个存在的即被使用(host 半按
  `import.meta.url` 相对定位前两处,不写死绝对路径):
  1. 本补丁自己的 `assets/whale-girl-transparent.png`(仓库中不存在;放入即可优先命中)
  2. 旧的兄弟路径 `ui-settings-other/assets/whale-girl-transparent.png`
  3. 用户级资源目录 `~/.dsh/assets/whale-girl-transparent.png`
- 三处都不存在时,Host 半打一条 warning 并跳过路由注册(插件照常挂载,只是没有背景图)。
- 需要 DSH 的 `webServer` 服务(`ctx.webServer.register` 的路由形状
  `{ kind, path, handler }` 在 0.1.5-rc.2 仍然成立);
- **升级 dsh 后要确认 `[data-conversation-scroll]` 仍然存在**——该属性由
  `dsh-client-ui-conversation` 的会话根节点提供,一旦改名背景图会静默消失
  (`patches/whale-background/tests/load-smoke.mjs` 守住路由与资源,守不住
  宿主 DOM 属性,这一点只能靠人眼/dom 快照核对)。

## 安装

`scripts/install.ps1` 会自动建 junction 并补 patch 条目,或手工:

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\node_modules\@local\dsh-client-whale-background" -Target "<repo>\patches\whale-background"
```

然后在 `~/.dsh/profiles/web/cordis.patch.yml` 添加:

```yaml
- insert:
    - id: whale-background
      name: '@local/dsh-client-whale-background'
```

条目热生效(数秒);本补丁**源码**改动需重启 dsh web。验证路由是否在服务:

```powershell
Invoke-WebRequest http://127.0.0.1:3080/whale-background.png -UseBasicParsing | Select-Object StatusCode, RawContentLength
# 期望 200 且约 816 KB(image/png)
```

## 测试

```powershell
node patches/whale-background/tests/load-smoke.mjs
```

真实 Cordis 装载 host 半:断言 `inject` 声明了 `webServer`、路由
`/whale-background.png` 注册成功、handler 真的返回 PNG 字节头、`dispose`
后路由注销,以及(apply 时同步读取的)图片资源确实存在。
