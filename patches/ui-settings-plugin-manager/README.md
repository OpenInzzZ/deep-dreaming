# 插件管理标签页(用户级 dsh 插件)

为 dsh Web 设置中的「插件」分区新增一个**插件管理**标签页,提供:

1. **插件状态过滤**
   - 启用状态:已启用 / 已停用
   - 运行状态:已挂载 / 挂载失败 / 加载中 / 等待依赖 / 卸载中 / 未挂载
2. **插件分类(官方 / 自定义)**
   - 官方:`@deepseek-ai/*` 包与 `cordis:` Loader 内建(随 dsh 发行)
   - 自定义:文件 URL、路径、第三方包等其余来源
3. 原有搜索与卡片展开详情保持不变。

## 目录结构

```
patches/ui-settings-plugin-manager/
├── package.json   # 声明 dsh.client 浏览器入口 + 依赖顺序
├── lib/
│   ├── index.js   # node 端空实现(仅让 Loader 挂载该条目)
│   └── client.js  # 浏览器端实现(手写 bundle,无构建步骤)
└── README.md
```

`client.js` 只依赖平台模块表内的词(`react`、`react/jsx-runtime`、
`@deepseek-ai/dsh-client-ui-primitives`),不依赖任何构建工具。

## 部署(加载到 dsh)

dsh 运行时需要从 profile 的 node_modules 按包名解析该插件,因此本仓库是
**实现来源**,另需在部署侧建立指向本目录的链接:

- 在 `~/.dsh/profiles/node_modules/@local/` 下创建指向本目录的目录联接
  (junction),或把本目录复制过去:

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\node_modules\@local\dsh-client-ui-settings-plugin-manager" -Target "D:\GitHub\deep-dreaming\patches\ui-settings-plugin-manager"
```

- 在 `~/.dsh/profiles/web/cordis.patch.yml` 中插入启用条目:

```yaml
- insert:
    - id: ui-settings-plugin-manager
      name: '@local/dsh-client-ui-settings-plugin-manager'
```

`cordis.patch.yml` 由运行中的 dsh 热加载(watch-only HMR):保存后数秒内自动
挂载,浏览器刷新一次页面即可看到新标签页,**无需重启服务器**。

## 如何使用

1. 打开 dsh Web 界面 → **设置(Settings)** → 左侧 **插件** 分区。
2. 切换顶部标签页到 **管理(Manager)** —— 列表即当前 profile 的全部插件条目。
3. 每个插件一张卡片,展示:名称、来源分类、启用/运行状态;点击卡片内容区
   可展开查看详情(加载器条目信息)。
4. 用三个下拉筛选器 + 搜索框收窄列表,各条件之间为 **AND(与)** 关系:
   - **Category(分类)**:全部 / 官方 / 自定义 —— 官方指 `@deepseek-ai/*`
     与 `cordis:` 内建,自定义指文件 URL、路径、第三方包等来源;
   - **Enablement(启用状态)**:全部 / 已启用 / 已停用;
   - **Runtime status(运行状态)**:全部 / 已挂载 / 挂载失败 / 加载中 /
     等待依赖 / 卸载中 / 未挂载。
   - 搜索框按插件名/模块名模糊匹配;无匹配时显示空状态提示文案。
5. 常用排查场景:某个插件没生效 → 状态筛「挂载失败」,或筛选「自定义」+
   「已停用」查看被禁用的条目。

## 启停与卸载

| 操作 | 做法 |
| --- | --- |
| 启用 | 在 `cordis.patch.yml` 插入上述条目 |
| 停用 | 把该条目改为 `- id: ui-settings-plugin-manager` + `disabled: true` |
| 卸载 | 删除补丁条目,并删除 `node_modules/@local/` 下的链接 |

## 注意事项

- 标签页 id 为 `manager`;若未来 dsh 发行版内置了同名插件,二者会冲突,
  届时删除本用户级插件即可。
- 修改 `client.js` 后无需重启服务器:补丁层热加载只处理条目增删,浏览器
  端 bundle 内容变更需要刷新页面(若 rev 未变可强制刷新)。
