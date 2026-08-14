# dsh-plugins

个人 dsh(DeepSeek Harness)用户级插件集。每个子目录是一个独立的 dsh 插件包,
部署方式见各插件 README(通过 `~/.dsh` 的补丁层 + node_modules 链接加载,
不修改 dsh 源码)。

| 插件 | 说明 |
| --- | --- |
| [ui-settings-plugin-manager](./ui-settings-plugin-manager/) | Web 设置「插件管理」标签页:插件状态过滤 + 官方/自定义分类 |
