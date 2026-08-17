# whale-background

会话区域背景插件:在对话滚动区右下角显示鲸鱼娘透明图(15% 透明度)。

## 功能

- 在 DSH Web 的会话对话区域右下角显示鲸鱼娘背景图
- 图片采用 15% 透明度,不干扰正常阅读
- 使用 `whale-girl-transparent.png` 作为背景源

## 实现原理

通过 Host 半的 `webServer.tapIndex` 在 index.html 中注入 `<style>` 标签,
利用 CSS `::before` 伪元素和 `data-conversation-scroll` 属性选择器定位到
会话滚动区域,添加背景图。

## 依赖

- 图片资源来自 `ui-settings-other` 补丁的 `assets/whale-girl-transparent.png`
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
