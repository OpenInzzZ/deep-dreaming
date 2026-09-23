# whale-background

会话区域背景插件:在对话滚动区居中偏右显示鲸鱼娘透明图(13% 透明度)。

## 功能

- 在 DSH Web 的会话对话区域居中偏右(水平中心再右移 125px,垂直居中)显示鲸鱼娘背景图
- 图片采用 13% 透明度(`opacity: 0.13`),不干扰正常阅读
- 使用 `whale-girl-transparent.png` 作为背景源

## 实现原理

- Host 半通过 `webServer.register` 注册精确路由 `/whale-background.png`,把图片字节直接回给浏览器。
- Client 半在模块加载时注入一段 `<style data-plugin data-plugin-css>`,用 CSS `::before` 伪元素和 `data-conversation-scroll` 属性选择器定位到会话滚动区域,把 `background-image` 指向上面那条路由。

## 依赖

- 图片资源按候选列表依次查找,第一个存在的即被使用:
  1. 本补丁自己的 `assets/whale-girl-transparent.png`(仓库中不存在;放入即可优先命中)
  2. 旧的兄弟路径 `ui-settings-other/assets/whale-girl-transparent.png`
  3. 用户级资源目录 `~/.dsh/assets/whale-girl-transparent.png`
- 三处都不存在时,Host 半会打一条 warning 日志并跳过路由注册(插件照常挂载,只是没有背景图)。
- 需要 DSH 的 `webServer` 服务可用

## 安装

通过 `install.ps1` 自动安装,或手动创建 junction 链接:

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\node_modules\@local\dsh-client-whale-background" -Target "<repo>\patches\whale-background"
```

然后在 `~/.dsh/profiles/web/cordis.patch.yml` 添加:

```yaml
- insert:
    - id: whale-background
      name: '@local/dsh-client-whale-background'
```
