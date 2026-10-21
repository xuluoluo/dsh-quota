# dsh-quota —— 把 opencode-go / Grok / Command Code 的额度与用量摊到界面上

DSH 的模型选择器只告诉你「用哪个模型」，不告诉你「这个 provider 这个月还剩多少」、
「我刚用掉多少 token」。这个插件补的正是这两块：参考
[yetone/magpie](https://github.com/yetone/magpie) 的 `internal/provider`（`quotas.go`、
`key_allowance.go`、`commandcode_plan.go`、`opencode_endpoints.go`）与它的 Usage 页，
直接问厂商自己的接口，并把每次模型调用的 usage 记下来。

界面上是四块：

1. **composer 下方的常驻窄条**（`conversation.composer.dock`）—— 不用打开设置就能看到
   `OpenCode Go 35% · Grok ⚠100% · 今日 ≈$0.42`；过阈值的那家带 ⚠，点一下刷新。
   composer 右侧那枚 chip 与它是同一份数字，**默认关掉**（`showChip: true` 才回来）；
3. **设置 → 额度**（`settings.section` 里的 `quota` 页）—— 用量四宫格（含估算花费）+ 七天条带 +
   模型明细，然后是每个 provider 的卡片：窗口进度条（**最紧的排最前**）+ 重置倒计时 + 凭据区
   （保存 / 清除 / **测试**）；
4. 列表上方的 **+ 添加供应商** —— 写进 profile 的 `cordis.patch.yml`，重启还在；pi-ai 目录里
   没有的供应商会顺手把模型路由也写上。

## 一、额度从哪来

| provider | 接口 | 读什么 |
|---|---|---|
| OpenCode Go | `GET https://opencode.ai/zen/go/v1/usage` | `usage.rolling / weekly / monthly` 的 `percent` 与 `resetsAt` |
| Grok（SuperGrok / X Premium） | `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits` | `config.creditUsagePercent`、`currentPeriod`、`productUsage`（GrokBuild / Cursor / GrokBot 分项）、`prepaidBalance`、有 cap 时的 `onDemand*` |
| Command Code | `GET https://api.commandcode.ai/alpha/billing/credits`<br>`GET https://api.commandcode.ai/alpha/billing/subscriptions` | `windowLimits.fiveHour / weekly` 的 `used/cap/resetAt`；`credits.monthlyCredits + purchasedCredits + freeCredits` 当月余额；订阅给出套餐名（Go / Pro / GOAT / Max / Ultra）、到期与是否续费 |
| DeepSeek 官方 API | `GET https://api.deepseek.com/user/balance` | `is_available`，以及 `balance_infos[0]` 的 `total_balance / granted_balance / topped_up_balance`（按币种取符号：CNY `¥`、USD `$`） |
| 阿里云百炼 | —— | 没有公开的余额 / 用量接口（账单在阿里云 Billing API，要 AccessKey，不是 DashScope key），所以这张卡**只存 key**，不编数字 |

Command Code 的 `billing/credits` 不告诉你套餐，而当月额度的分母是套餐给的（GOAT = $70/月），
所以第二支接口**并行**只读一次、缓存 10 分钟（magpie 也是这么做的；它有时要 15–20 秒，
排在后面会把整张卡拖慢）。读不到就退回「只显示余额」。

卡里的窗口**按已用比例从大到小排**：第一行就是最可能挡住你下一次请求的那个限制。

DeepSeek 的卡是**余额**，不是窗口：官方只给金额、不给分母，所以它不画进度条，只报
`余额 · ¥110.00` 和构成（充值 / 赠金），`is_available: false` 时在金额前写明「can not pay」。
它用的是 `DEEPSEEK_API_KEY`；DSH 账号本身的余额仍然看「账号与余额」页 —— 两套账单不是一回事。

这几个端点在这台机器上真实跑通过，不是照文档猜的形状 —— `test/live-probe.mjs` 可随时复看。

## 二、用量从哪来

`llm/stream` 是 DSH 每次模型调用都要过的 waterfall。插件包住它：每个 chunk 原样传下去
（看不见任何差别），同时记住结束前那一个 `usage` chunk ——
`{ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens }` ——
和这次调用的 `provider / model`。失败的调用（`finish.kind = error | aborted`）不记。

于是「谁发起的调用」都算得到：对话、压缩、自动起标题。数据落在一个小 JSON 里：

```
$DSH_HOME/.quota-usage.json          # 默认 ~/.dsh/.quota-usage.json
{ "version": 1, "days": { "2026-10-20": { "totals": {...}, "models": { "opencode-go/deepseek-v4.1-flash": {...} } } } }
```

保留 30 天，页面看近 7 天 + 今天；写入是 2 秒防抖的一次原子替换（先写 `.tmp-<pid>` 再 rename），
插件卸载时再刷一次。计数不是业务数据，写失败只吞掉，不打扰模型调用。

页面上：TOKEN 总量（输入 / 输出）、缓存读取（含命中率 = 缓存 /（缓存 + 新输入））、
推理 token、调用次数，七天条带，以及按 `provider / model` 的明细（重的那条在前）。

### 花费：按目录价折算

`build/prices.js` 是从 pi-ai 目录里抽出来的价目表（**USD / 百万 token**，`input / output /
cacheRead / cacheWrite`），由 `tools/gen-prices.mjs` 从 `_ref/pi-ai/dist/providers/data/*.json`
生成，覆盖当前这套 route 用到的 36 个模型。有价就出数：TOKEN 卡上写近 7 天的 `≈$3.17`，
每条模型行写它自己的 `≈$0.013`，窄条写今天。

**这是估算，不是账单**：OpenCode Go / Grok 是订阅制，不是按 token 计价；按目录价折算只是让你
横向比较「今天这几轮大概值多少钱」。要改价，在配置里覆盖：

```yaml
prices:
  "opencode-go/deepseek-v4.1-flash": { input: 0.15, output: 0.6, cacheRead: 0.003 }
```

### 阈值告警

`alertAt`（默认 90）与 `alertCriticalAt`（默认 97）按「最紧的那个窗口」判；余额卡按
`balanceFloor`（默认 5，同一币种单位）判。命中的卡片头挂 `⚠ 接近上限 / 已达上限`，
窄条上那家的百分比变红并加 ⚠，页面顶部也会写一行「已达上限 · Grok」。

## 三、凭据：登录，或者存 key

插件自己不落任何秘密，两条路都走 DSH 的凭据缝（`ctx.credentials`）：

### Grok：设备码登录（会真的把 DSH 接通）

点「登录 Grok」→ Host 用 pi-ai 同一个 client_id（`b1a00492-…`）、同一套 scope 去
`auth.x.ai/oauth2/device/code` 领设备码 → 页面显示 `user code` 和带 code 的授权链接 →
你在浏览器里确认 → Host 轮询 `/oauth2/token` → 拿到 grant 后写进

```
~/.dsh/.credentials.yaml → records["llm-pi-ai/xai"]
{ kind: grant, payload: { type: oauth, access, refresh, expires } }
```

也就是 `dsh-llm-pi-ai` 自己读的那条记录 —— 所以**在这里登录完，DSH 里选 Grok 模型就能直接对话**。
token 快过期（< 5 分钟）时读额度会先用 refresh_token 续一次并回写，续不动就让卡片说「登录过期」。
「退出登录」删掉这条记录。

### OpenCode Go / Command Code：API key

粘贴 key → `POST /quota/key` → `ctx.credentials.set("OPENCODE_GO_API_KEY" | "COMMANDCODE_API_KEY", …)`。
和 Models 页同一个存储，所以优先级也一样：**凭据库 > 环境变量 > 项目 .env > ~/.dsh/.env**；
卡片写明当前值来自哪一层，`清除` 只删凭据库那份。

Command Code 没存 key 时自动读它 CLI 的登录 `~/.commandcode/auth.json`（`apiKey` + `userName`），
卡片显示「使用 Command Code CLI 的登录 · 用户名」。这条只读，所以没有「清除」。

### 阿里云百炼：只有 key

百炼的 DashScope key 是 OpenAI 兼容的（`https://dashscope.aliyuncs.com/compatible-mode/v1`），
但这版 pi-ai 的 provider 目录里没有百炼。所以除了把 key 存成 `DASHSCOPE_API_KEY`，添加这个
供应商时还会往 `llm-pi-ai.providers` 写一条路由：

`yaml
ali:
  displayName: 阿里云百炼
  apiKeyEnv: DASHSCOPE_API_KEY
  api: openai-completions
  baseURL: https://dashscope.aliyuncs.com/compatible-mode/v1
  models: [qwen3.8-max, qwen3.8-flash]
`

模型 id 是从 `GET /compatible-mode/v1/models` 的实际返回里挑的（那份列表有 178 个）。
之后调用产生的 token 照样进上面的用量统计。

## 四、添加 / 移除供应商

列表上方一个「+ 添加供应商」按钮：点开是预设 + `id` + 可选（显示名 / 网关地址 / 凭据引用）的表单，添加成功后自动收起。
卡头右上角的「移除」做反向操作。

写的是 **profile 自己的 patch 层**（`cordis.patch.yml` 里 id 为 `dsh-quota` 的那一行），
不是插件内部的状态文件 —— 所以重启、升级都还在，也能被别的工具读到。第一次添加会把
三个内置目标显式写下来（否则「写了 providers 就是整份替换」会把它们弄丢）。

现在有五种预设：`opencode-go`、`xai-billing`（Grok，走设备码登录）、`commandcode`、
`deepseek-api`（只有余额）、`bailian`（只存 key）。

加了供应商还要能在**模型**里看见。pi-ai 目录里已经有的（`opencode-go` / `xai`）不需要做什么；
目录里没有的（目前只有 `bailian`），预设里带了一份 `route`，添加时插件会顺手在
`llm-pi-ai.providers` 写一条路由（`api` / `baseURL` / `models`），否则它只活在额度页、
模型选择器里看不到。

**凭据引用填的是名字，不是 key**：`apiKeyEnv` 必须长成 `DASHSCOPE_API_KEY` 这样；
填成 key 会被 400 拒掉，配置里要是已经写成 key 形状，读的时候会被丢掉、退回预设的引用
（避免把 key 当引用带到页面上）。
同一个预设可以加多次 —— 换网关、换 key、换账号都行。

## 五、安装

已经在 `desktop` profile 里装好了（`@local/dsh-quota`）。重装/更新：

```
plugin_manager install_bundle  target = D:\Documents\deepseek-harness\default-workspace\plugins\dsh-quota
```

生效规则：**客户端 JS 每次页面加载都重新读盘**，改 `build/client.js` 后刷新页面即可；
**Host 侧（`index.js` / `providers.js` / `usage.js` / `xai-oauth.js`）换了代码要重启 DSH**。

## 六、配置（都是可选的）

```yaml
- id: dsh-quota
  name: '@local/dsh-quota'
  config:
    enabled: true          # false = 整页停用（chip 也消失）
    refreshMs: 60000       # 额度快照缓存与自动刷新间隔（10s–1h）
    timeoutMs: 8000        # 单个厂商接口超时
    providers:             # 写了就是整份替换；页面上的「添加」也是写到这儿
      - id: opencode-go
        preset: opencode-go
        apiKeyEnv: OPENCODE_GO_API_KEY
      - id: grok
        preset: xai-billing
        record: llm-pi-ai/xai
      - id: commandcode
        preset: commandcode
        apiKeyEnv: COMMANDCODE_API_KEY
      - id: deepseek
        preset: deepseek-api
        apiKeyEnv: DEEPSEEK_API_KEY
      - id: bailian
        preset: bailian
        apiKeyEnv: DASHSCOPE_API_KEY
      - id: my-oc                  # 换网关：baseURL 替换预设的默认根路径
        preset: opencode-go
        baseURL: https://opencode.ai/inference/go
    showChip: true         # 把 composer 右侧那枚 chip 打开（默认只有下方窄条）
    alertAt: 90            # 最紧窗口到这个百分比 → ⚠ 接近上限
    alertCriticalAt: 97    # 再到这个 → ⚠ 已达上限（红色）
    balanceFloor: 5        # 余额卡低于这个数（同币种单位）也算告警
    prices:                # 覆盖/补充 build/prices.js 的目录价（USD / 百万 token）
      "opencode-go/deepseek-v4.1-flash": { input: 0.15, output: 0.6, cacheRead: 0.003 }
```

## 七、HTTP 面（前端与 Host 之间）

都是同源 JSON，写在 `build/index.js` 的 `ROUTES`：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/quota/state` | 快照：卡片 + 用量 + 预设清单（额度缓存 `refreshMs`） |
| POST | `/quota/refresh` | 强制重读额度 |
| POST | `/quota/key` | `{id, key}` → 写凭据库 |
| POST | `/quota/clear` | `{id}` → key 就 unset，oauth 就删记录 |
| POST | `/quota/test` | `{id}` → 真打一次厂商接口，回 `{ok, detail}`（页面上的「测试」按钮） |
| POST | `/quota/providers` | `{preset, id, label?, baseURL?, apiKeyEnv?}` → 追加到 patch |
| POST | `/quota/providers/remove` | `{id}` → 从 patch 移除（至少留一个）；带 `route` 的预设顺带删掉 `llm-pi-ai` 里那条模型路由 |
| POST | `/quota/login/start` | 领设备码，返回 `userCode` / 授权链接 |
| GET | `/quota/login/status?id=` | `pending` / `success` / `failed` / `cancelled` |
| POST | `/quota/login/cancel` | 取消一次登录 |

**同源规则**：只拦「别的站点的页面」。桌面渲染进程向自己的 Host 发请求时**既不带 `Origin` 也不带
`Sec-Fetch-Site`**，所以没有 `Origin` 就当作本机客户端放行；带了 `Origin` 的，只有 loopback
（`127.0.0.1` / `localhost` / `[::1]`，任意端口）、`Sec-Fetch-Site: same-origin|none`、或与 `Host`
一致才放行，其余回 403 并把 `origin / host / site` 写进响应 —— 页面直接显示，这类问题下次能自己
说出原因（上一版就是被“写操作必须有 Origin”挡掉了自己的「保存」「移除」）。

**安全边界（别忽略）**：这些路由由 Host 的 `webServer` 直接注册，**不经过 DSH 页面那层 token 校验**
（`GET /` 要 token，`GET /quota/state` 不要）。它们只回额度数字、套餐名、token 计数和
「凭据是否配置 / 来自哪一层」，从不回 token 或 key 明文；写操作受上面的同源规则约束。
本机任意进程都能读到这些数字 —— 在「本机进程本来就能读 `~/.dsh/.credentials.yaml`」的前提下，
这不算新增暴露面。

## 八、验证

```powershell
cd plugins\dsh-quota

node test\providers.test.mjs                  # 四个 reader 的纯逻辑（38 项）
$env:QUOTA_LIVE='1'; node test\providers.test.mjs   # 再打一次真接口（本机凭据）
node test\host.test.mjs                       # Host：路由、凭据、续期、登录、供应商、用量、同源（78 项）
node test\client.test.mjs                     # Client：注册、取数、渲染、用量、成本、告警、窄条、存 key、登录、加供应商（60 项）

node tools\grok-login.test.mjs                # grok-login 的 YAML 写入回归（读本机凭据文件）
```

装好之后真进程上也能直接看：

```powershell
curl.exe -s http://127.0.0.1:62756/quota/state          # 卡片 + usage + presets
curl.exe -s -o NUL -w '%{http_code}' -X POST -H 'content-type: application/json' `
  -H 'origin: http://127.0.0.1:62756' --data '{}' http://127.0.0.1:62756/quota/refresh
```

本机实测（2026-10-20 那次装完时）：

```
opencode-go  rolling 2%  weekly 19%  monthly 33%
grok         weekly 100%（本周额度用尽）  GrokBuild 92 / Cursor 5 / GrokBot 3
commandcode  5h 0%  weekly 12%  当月 $69.93 / $70.00  plan=GOAT  10-22 到期不续
```

**没验到的**：真实浏览器里的像素级观感（没有浏览器控制）。client bundle 的行为用最小 hooks
运行时跑通了，slot 注册与文档里的名字一致。

## 九、回滚

- `plugin_manager remove_bundle  target = @local/dsh-quota`，或删掉 profile patch 里那一行；
- Grok 登录写的是 `llm-pi-ai/xai`，删掉它等于退出登录，不影响其它记录；
- `~/.dsh/.quota-usage.json` 可以随便删，删掉只是用量清零。

## 十、目录

```
package.json          dsh.bundle.patch + dsh.client + exports/files
cordis.patch.yml      insert: dsh-quota
icon.svg              自绘的仪表盘图标
locale/{en,zh}.json   meta.title / meta.description
build/providers.js    四个 reader + fetch（纯函数）
build/usage.js        用量折叠 / 汇总 / 花费折算 / 落盘（纯函数 + 一个小 store）
build/prices.js       目录价表（由 tools/gen-prices.mjs 生成，USD / 百万 token）
build/xai-oauth.js    设备码 / 续期 / grant 形状（fetch 注入）
build/index.js        Host：配置、快照、路由、登录、供应商、用量接线
build/client.js       Client：chip + 设置页（纯 JS，无构建步骤）
test/*.mjs            上面那三组测试 + live-probe
tools/*.mjs           与本机凭据打交道的命令行工具（不进 npm 包，见 package.json 的 files）
  grok-login.mjs        走设备码登录并把 grant 写进 ~/.dsh/.credentials.yaml
  grok-verify.mjs       验证那条凭据能不能直接当 xAI API 凭据用
  grok-login.test.mjs   grok-login 的 YAML 写入回归
  gen-prices.mjs        从 pi-ai 目录重生成 build/prices.js
  asar.mjs              从 DSH 的 app.asar 里 list / cat / extract 包源码
```

`tools/` 里的脚本要读 YAML，用的是仓库外 `_ref/yaml` 的本地副本；那份第三方代码不进仓库，
缺席时脚本会明确报错退出。
