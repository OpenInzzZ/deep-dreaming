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
├── package.json            # 声明 dsh.client 浏览器入口 + 依赖顺序
├── lib/
│   ├── index.js            # host 半:/plugin-toggle RPC 通道(启停写 patch 文件)
│   └── client.js           # 浏览器端实现(手写 bundle,无构建步骤)
├── tests/
│   └── load-smoke.mjs      # 真实 Cordis 加载冒烟(Invalid effect 回归)
├── verify-plugin-manager.mjs  # 契约验证:host 启停 + client 清单/过滤器
└── README.md
```

`client.js` 只依赖平台模块表内的词(`react`、`react/jsx-runtime`、
`@deepseek-ai/dsh-client-ui-primitives`),不依赖任何构建工具;host 半只
用 Node 内置模块与注入的 `connection` 服务。

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
挂载,host 与 client 半均热生效,**无需重启服务器**;其它用户补丁的变更
可在设置 →「其他」页点 **重载用户插件** 手动触发同样的热重载。
修改本补丁源码后需重启 dsh web 才生效。

**职责边界**:本页**仅负责插件启停管理**(清单 + 启停按钮);插件的配置
卡片统一在「插件配置」页(`settings.plugin.item`)编辑,不在此页重复展示。

## 如何使用

1. 打开 dsh Web 界面 → **设置(Settings)** → 左侧 **插件** 分区。
2. 切换顶部标签页到 **插件管理** —— 列表即当前 profile 的全部插件条目。
3. 每个插件一张卡片,展示:名称、来源分类、启用/运行状态;点击卡片内容区
   可展开查看详情(加载器条目信息)。
4. 用三个下拉筛选器 + 搜索框收窄列表,各条件之间为 **AND(与)** 关系:
   - **Category(分类)**:全部 / 官方 / 自定义 —— 官方指 `@deepseek-ai/*`
     与 `cordis:` 内建,自定义指文件 URL、路径、第三方包等来源;
   - **Enablement(启用状态)**:全部 / 已启用 / 已停用;
   - **Runtime status(运行状态)**:全部 / 已挂载 / 挂载失败 / 加载中 /
     等待依赖 / 卸载中 / 未挂载。
   - 搜索框按插件名/模块名模糊匹配;无匹配时显示空状态提示文案。
5. **启停插件**:每张卡片底部有「停用 / 启用」按钮(本管理页自身除外)。
   点击后 host 端改写 `~/.dsh/profiles/web/cordis.patch.yml`(追加/移除
   `- id: <条目> + disabled: true` 补丁行),dsh 的热加载在数秒内卸载或
   重新装载该插件 —— **不重启服务、不中断会话**,且选择写入 patch 文件、
   重启后保持。操作结果(已生效/失败)显示在按钮旁,列表自动刷新。
6. 常用排查场景:某个插件没生效 → 状态筛「挂载失败」,或筛选「自定义」+
   「已停用」查看被禁用的条目。

## 启停与卸载

| 操作 | 做法 |
| --- | --- |
| 启用/停用 | 管理页卡片按钮(**热生效**,推荐);或手工改 `cordis.patch.yml` |
| 停用(手工) | 追加顶层补丁行 `- id: <条目id>` + `  disabled: true` |
| 卸载 | 删除补丁条目,并删除 `node_modules/@local/` 下的链接 |

> 启停按钮的 host 实现(`lib/index.js`)经 `/plugin-toggle` RPC 通道
> (`authority: 'loopback'`)读写 patch 文件;只有 `entryId` 为普通标识符
> (字母/数字/`.`/`_`/`-`)的条目可操作,非法值被响亮拒绝。本管理页自身
> 被保护,不能从页面停用(否则无法在此恢复),需手工编辑 patch 文件。

## 注意事项

- 标签页 id 为 `manager`;若未来 dsh 发行版内置了同名插件,二者会冲突,
  届时删除本用户级插件即可。
- 修改 `client.js` 后无需重启服务器:补丁层热加载只处理条目增删,浏览器
  端 bundle 内容变更需要刷新页面(若 rev 未变可强制刷新)。
- 停用/启用写入 patch 文件后由 dsh 热加载生效;若热重载失败,条目保持
  上次状态,可点设置 →「其他」页的 **重载用户插件** 重试。

## 测试

```powershell
node verify-plugin-manager.mjs          # 契约验证(host 启停逻辑用临时 patch 文件)
node tests/load-smoke.mjs               # 真实 Cordis 加载冒烟
```

覆盖:host 半 disabled 块追加/移除/幂等、非法 entryId 拒绝、`/plugin-toggle`
通道(loopback)与端点校验、apply 不返回 thenable 的 P0 回归守卫;client 半
bundle handoff、tab 注册(id/order)、zh/en 字典对齐、toggleEnabled 注入面;
DOM 段(需 jsdom)覆盖过滤器与卡片启停按钮点击 → `/plugin-toggle` 调用。
