# 模型能力 —— 给自定义(llm-pi-ai)模型图形化配置「思考」与「图片输入」

在 DSH 桌面端的 **设置 → 模型** 页面，为每个 pi-ai 提供方卡片(自定义路由)增加一块
**模型能力** 区域，逐模型配置两项能力:

| 能力 | 写回字段 | 说明 |
| --- | --- | --- |
| **思考** | `reasoningEfforts` | 开关 + 档位勾选 + 每档的**发送值**;开启后输入框的模型菜单出现「推理等级」行 |
| **图片** | `input` | 三态:**跟随上游** / **仅文本** / **支持图片** |

写入落点是该提供方在组合层的 `models` 数组(与内置 `deepseek-v4-pro` 的手写配置完全同形)。

## 为什么需要这个补丁

官方对自定义提供方**有意不做思考配置**——`ui-settings-models/src/client/ProviderEditor.tsx:14`
写着 *"Reasoning effort is deliberately absent: it is a per-MODEL capability"*:同一路由下各模型
的档位不一致,提供方级别的控件只会写出某些模型不认的值。模型菜单里的「推理等级」完全由模型的
`reasoningEfforts` 决定:

| `reasoningEfforts` | 效果 |
| --- | --- |
| 省略 | 跟随内置目录能力(自定义模型 = 无) |
| `false` | 明确为非推理模型,模型菜单不出现「推理等级」 |
| `{off: null, low: low, ...}` | 开启思考;`off` 档留空 = 不发送思考参数,其余档发送各自的值 |
| `{off: none, high: high, ...}` | `off` 档也可带显式值(如 `none`):选中「关闭」时照样上线 —— 供默认就会思考、必须显式传参才关的网关用 |

图片输入则**官方已有 UI**:模型行的「输入类型」勾选框(`ModelRow` → `ModelInputTypes`,
`inputField="input"`)。本补丁把它收进同一张卡片,理由是那个勾选框表达不了第三种状态:
它渲染的是**继承来的**模态列表,一旦点动任一勾选框就把这份列表**写成声明**,等于把上游目录
冻结成快照。卡片里的三态区分正是为此:

| 选择 | 存储 | 语义 |
| --- | --- | --- |
| 跟随上游 | **移除** `input` | 沿上游目录条目,再沿路由 `defaultInput` |
| 仅文本 | `input: [text]` | 声明端点只吃文本(纠正目录里记着图片的模型) |
| 支持图片 | `input: [text, image]` | 声明端点吃图片 —— 手写声明的视觉模型靠这条才可用 |

> 注意:`input` 是**对端点的声明,不是探测**。官方不改写目录记录的模型能力,pi-ai 也不会去
> 问网关认什么;声明了端点不认的图片,会在回合中途被提供方拒绝。

## 使用

1. 打开 **设置 → 模型**,任意 pi-ai 提供方(含自定义与内置)卡片下方出现 **模型能力**。
2. 每个模型:**思考** 开关 + 状态(未配置 / 思考已关闭 / 思考已开启);打开即进入档位编辑
   (默认档位:`关闭/低/中/高/最高`)。同一行的 **图片** 三态选择器决定图片输入。
3. 「档位」展开后,逐档勾选,并为每个档位(含**关闭**档)填写**发送值**(发送值默认与档位同名,
   例如 `low` 就填 `low` —— 具体拼写以提供方网关为准;关闭档留空即「不发送参数」,占位符会提示)。
4. 点 **保存**,一条路径操作写回该提供方的 `models` 整数组;模型菜单立即出现「推理等级」。
   失败(校验/权限拒绝)会在卡片内提示:配置未生效 —— 此时草稿保留在界面上,可直接改完重试,
   或点「放弃」回到已落库的状态。

## 实现要点

- **扩展位**:`settings.models.provider-card`(keyed,`entryKey` = 提供方的 settings 命名空间);
  本补丁以 `key: 'llm-pi-ai'` 注册,一次注册覆盖所有 pi-ai 提供方卡片。
- **数据通道**:官方设置传输面 —— `ctx.configForms.get('llm-pi-ai')`(0.1.7-alpha.1 起由
  `settingsScope.bind({namespace})` 改名而来):读走共享 describe 镜像(`getSnapshot()`/
  `subscribe()`),写走该 scope 的路径操作(`scope.mutate([{op:'set',path,value}])`,带
  revision 栅栏);底层的 `remote.settings` 调用由 scope 控制器持有,所以本补丁 inject 的是
  `configForms`。不新增 RPC 通道,宿主始终是唯一事实来源。
- **两层读法**:`snapshot.value` 是宿主**解析后**的 section(`input` 缺席会被 schema 物化成
  `[]`),`snapshot.user` 是**用户层原样存储**的内容 —— 「跟随上游」与「仅文本」只能靠
  `user` 层区分,这正是本卡片相对官方勾选框的增量。
- **写入形状**:一条 `set` 路径操作覆盖 `providers.<路由>.models` **整个数组**
  (路径操作不能按数组下标深入 —— `applyPathOp` 会把数组展开成普通对象)。未改动的模型原样透传;
  「跟随上游」是**删键**,不是写空数组,否则会把上游目录钉死。
  ⚠️ 因此编辑后用户层会持有整份 `models` 列表并**遮蔽**组合层(`cordis.patch.yml`)里的同一路由:
  之后改组合层不再生效,以这份存储为准。
- **host 半**:空实现,仅用于激活 loader entry —— dsh 只把「已激活」的条目组合进浏览器启动图。

## 文件

```
patches/ui-settings-model-capabilities/
├── package.json                  # @local/dsh-client-ui-settings-model-capabilities
├── lib/index.js                  # host 半(空实现,激活 entry)
├── lib/client.js                 # 浏览器半:模型能力卡片
├── tests/load-smoke.mjs          # 真实 cordis 加载 host 半
└── verify-model-capabilities.mjs # 契约 + jsdom 渲染/交互/保存 ops 断言
```

## 验证

```powershell
node patches/ui-settings-model-capabilities/tests/load-smoke.mjs
node patches/ui-settings-model-capabilities/verify-model-capabilities.mjs
```

修改 `lib/*.js` 后需重启 dsh(源码变更不热更);包内 `cordis.patch.yml` 的行结构变更也需重启
(bundle 层文件不在 HMR 监视范围)。装载方式见仓库根 `scripts/install.ps1`(全部补丁统一装成
bundle:pnpm link + `dsh.profile.bundles`)。

> 本补丁由 `ui-settings-model-reasoning` 迭代而来(原名只覆盖思考),loader 条目 id 与包名都已
> 随目录改名;旧条目由 `scripts/install.ps1` 在迁移时注销。
