# ui-settings-balance — 设置「账户余额」页

在 DSH 设置面板里新增一个**只读**的「账户余额」区块：显示当前 DeepSeek 账户的
**充值余额**与**赠金余额**（按币种分行），并提供手动刷新。

它是 `ui-settings-other` 的继任者：原来那一页（服务运行状态 / 创建桌面快捷方式 /
检查更新 / 重启服务）整体下线了——那些都以 Web 端的生命周期为准，而本仓库现在以
**DSH 桌面端**为目标，桌面端的运行状态、更新与重启都由应用自己负责。归档见
[`archive/README.md`](../../archive/README.md)。

## 它做什么 / 不做什么

| 做 | 不做 |
| --- | --- |
| 从宿主 `deepseekAccount` 服务读取余额并展示 | 不自己直连 DeepSeek 平台接口 |
| 未登录 / 查询失败 / 服务缺失都给出明确说明 | 不把「未登录」渲染成 0 余额 |
| 提供手动刷新，并在标签页回到前台且数据过期时自动重读 | 不做短周期轮询（避免用户正在看的数字自己跳动） |
| 覆盖标题栏 favicon 为鲸鱼娘图标 | 不提供登录、充值、重启、更新等任何控制 |

登录与充值仍然在 DSH 自己的「账户」设置里完成——本页只在未登录时提示去那里。

## 数据来源（为什么用宿主服务而不是直连）

宿主已经挂载了 `deepseekAccount`（`@deepseek-ai/dsh-deepseek-account`），它负责：

- 持有本地凭据（grant），并按其派生出站请求头；
- 在 401 / `code 40003` 时清除失效凭据；
- 让**余额**与**资料**的查询结果彼此独立（余额失败不会把资料一起判失败）；
- 区分「未登录」（返回 `null`）与「查询失败」（返回 `{ status: 'failed' }`）。

补丁里重写这套链路只会把凭据处理写错，所以 `/app/balance` 直接调用该服务：

```js
deepseekAccount.getBalance({ version, locale, timezoneOffsetSeconds })
// → { status: 'ready', value: [钱包…], bonusWallets: [赠金…] } | { status: 'failed' } | null
```

`AccountClientMetadata` 不是装饰：DSH 用它推导发往平台的**语言**与**时区**，
缺失会让服务端给出不同的结果。语言取自宿主 `locale` 服务的当前快照
（`ctx.get('locale').getSnapshot().active`），时区取本机偏移（与浏览器同约定，东为正）。

## `/app/balance` 的返回形态

面板完全按 `status` 渲染，这也是测试重点覆盖的地方：

| `status` | 含义 | 面板表现 |
| --- | --- | --- |
| `ready` | 拿到余额 | 按币种列出充值 / 赠金金额 |
| `signed-out` | 没有本地凭据（服务返回 `null`） | 提示去「账户」设置登录，**不显示任何金额** |
| `failed` | 平台查询失败或抛错 | 显示失败原因 |
| `unavailable` | 宿主没有挂载 `deepseekAccount` | 说明服务未挂载 |

## 安装与卸载

本补丁是**目录包插件**：junction 链接进共享仓库 + 在 profile 的
`cordis.patch.yml` 里插入一行。

```powershell
# 安装（连同其它补丁一起，幂等）
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
# 只做校验
powershell -ExecutionPolicy Bypass -File .\scripts\deploy.ps1
```

装载行（由 `scripts/install.ps1` 幂等写入 `~/.dsh/profiles/desktop/cordis.patch.yml`）：

```yaml
- insert:
    - id: ui-settings-balance
      name: '@local/dsh-client-ui-settings-balance'
```

卸载三步：删掉上面那一行 → 删除
`~/.dsh/profiles/node_modules/@local/dsh-client-ui-settings-balance` 这个 junction →
重启桌面端。

> `cordis.patch.yml` 的改动会**热应用**（数秒内生效，无需重启）；但补丁**源码**
> 的改动必须重启应用：`scripts/restart-desktop.ps1`。

## 测试

```powershell
node patches/ui-settings-balance/tests/load-smoke.mjs        # 真实 Cordis 装载：路由 / 围栏 / 四种状态
node patches/ui-settings-balance/tests/client-contract.mjs   # 区块注册 / 双语文案 / 各状态渲染（需 jsdom）
```

`load-smoke` 覆盖：`inject` 契约、`/ui-settings-balance/health` 与 `/favicon.svg`
路由、`/app` 前缀路由的围栏（跨源 403 / 非 POST 405 / 非 JSON 415 / 坏 JSON 400）、
`balanceInfo` 的四种状态、以及卸载时路由 disposer 全部释放。

`client-contract` 覆盖：只有**一个** `settings.section` 注册（id `balance`）、
中英文字典键集一致、`ready` 渲染三行金额、`signed-out` 不渲染任何金额元素、
`failed` / `unavailable` / 传输异常 / `ok:false` 信封都渲染原因、刷新按钮会重新读取。

## 已知边界

- **图标名必须与 DSH 版本一致**：`0.2.0-rc.2` 把
  `@deepseek-ai/dsh-client-ui-primitives` 的图标导出从 `…Outline16/14` 改名为
  `…OutlineRegular/Medium`。本补丁用的是新名；旧名不会报错，只会**静默渲染出空图标**
  （这也是全仓库其它补丁一起改名修掉的问题，见 `scripts/migrate-icon-names.mjs`）。
- 余额来自平台查询，**不是实时**：默认在挂载时读一次，之后靠手动刷新或标签页回到
  前台（超过 5 分钟）时重读。
- favicon 覆盖依赖 `assets/favicon-128.png` 存在；缺失时只警告，不影响余额功能。
