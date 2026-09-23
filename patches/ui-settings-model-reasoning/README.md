# 模型思考配置 —— 给自定义(llm-pi-ai)模型加「思考开关 + 思考等级」

在 dsh Web 的 **设置 → 模型** 页面,为每个 pi-ai 提供方卡片(自定义路由)增加一块
**思考配置** 区域:逐模型控制「是否支持思考」,并编辑各档位的**发送值**。配置写回
`settings.yaml` 的 `llm-pi-ai.providers.<路由>.models[].reasoningEfforts`,输入框的
模型菜单随后出现「推理等级」行 —— 与内置 `deepseek-v4-pro` 的手写配置完全同形。

## 为什么需要这个补丁

dsh 官方对自定义提供方**有意不做**推理配置(源码注释:"effort is a per-MODEL
capability" —— 同一路由下各模型的档位不一致,提供方级别的控件只会写出某些模型
不认的值),模型菜单里的「推理等级」完全由模型的 `reasoningEfforts` 决定:

| `reasoningEfforts` | 效果 |
| --- | --- |
| 省略 | 跟随内置目录能力(自定义模型 = 无) |
| `false` | 明确为非推理模型,模型菜单不出现「推理等级」 |
| `{off: null, low: low, ...}` | 开启思考;`off` 档 = 不发送思考参数,其余档发送各自的值 |

官方把这块留给 `settings.yaml` 手写。本补丁用官方预留的外部扩展位
(`settings.models.provider-card`,按 settings 命名空间分发)把 UI 补上。

## 使用

1. 打开 **设置 → 模型**,任意 pi-ai 提供方(含自定义与内置)卡片下方出现
   **思考配置**。
2. 每个模型一行:**思考** 开关 + 状态(未配置 / 思考已关闭 / 思考已开启)。
   打开开关即进入档位编辑(默认档位:`关闭/低/中/高/最高`)。
3. 「档位」展开后,逐档勾选,并为每个思考档填写**发送值**(关闭档固定为
   「不发送参数」;发送值默认与档位同名,例如 `low` 就填 `low` ——
   具体拼写以提供方网关为准)。
4. 点 **保存**,写入 `settings.yaml`;模型菜单立即出现「推理等级」。
   失败(校验/权限拒绝)会在卡片内提示:配置未生效 —— 此时草稿保留在界面上,
   可直接改完重试,或点「放弃」回到已落库的状态。

## 实现要点

- **扩展位**:`settings.models.provider-card`(keyed,`entryKey` = 提供方的
  settings 命名空间);本补丁以 `key: 'llm-pi-ai'` 注册,一次注册覆盖所有
  pi-ai 提供方卡片。
- **数据通道**:官方设置传输面 —— `ctx.settingsScope.bind({namespace:
  'llm-pi-ai'})`:读走共享 describe 镜像(`getSnapshot()`/`subscribe()`),写走
  该 scope 的路径操作(`scope.mutate([{op:'set',path,value}])`,带 revision
  栅栏);底层的 `remote.settings` 调用由 scope 控制器持有,所以本补丁 inject
  的是 `settingsScope`。不新增 RPC 通道,宿主始终是唯一事实来源。
- **写入形状**:一条 `set` 路径操作覆盖 `providers.<路由>.models` **整个数组**
  (路径操作不能按数组下标深入 —— `applyPathOp` 会把数组展开成普通对象)。
  未改动的模型原样透传。
- **host 半**:空实现,仅用于激活 loader entry —— dsh 只把「已激活」的条目
  组合进浏览器启动图。

## 文件

```
patches/ui-settings-model-reasoning/
├── package.json            # @local/dsh-client-ui-settings-model-reasoning
├── lib/index.js            # host 半(空实现,激活 entry)
├── lib/client.js           # 浏览器半:思考配置卡片
├── tests/load-smoke.mjs    # 真实 cordis 加载 host 半
└── verify-model-reasoning.mjs  # 契约 + jsdom 渲染/交互/保存 ops 断言
```

## 验证

```powershell
node patches/ui-settings-model-reasoning/tests/load-smoke.mjs
node patches/ui-settings-model-reasoning/verify-model-reasoning.mjs
```

修改 `lib/*.js` 后需重启 dsh(源码变更不热更);`cordis.patch.yml` 条目变更
数秒热生效。
