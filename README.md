# dsh-quota —— 把 opencode-go / Grok / Command Code 的额度摊到界面上

DSH 的模型选择器只告诉你「用哪个模型」，不告诉你「这个 provider 这个月还剩多少」。
这个插件补的正是这一块：参考 [yetone/magpie](https://github.com/yetone/magpie) 的
`internal/provider`（`quotas.go`、`key_allowance.go`、`commandcode_plan.go`、`opencode_endpoints.go`）
的做法，直接问三家厂商自己的额度接口，把结果画成

1. **composer 右侧的额度 chip** —— 每个 provider 一枚小药丸，颜色按「最坏的那个窗口」退化，点一下强制刷新；
2. **设置 → 额度**（`settings.section` 里的 `quota` 页）—— 每个窗口一条进度条 + 重置倒计时，
   外加这个 provider 的凭据状态与操作：存 API key、登录 Grok、退出登录。

## 一、数字从哪来

| provider | 接口 | 读什么 |
|---|---|---|
| OpenCode Go | `GET https://opencode.ai/zen/go/v1/usage` | `usage.rolling / weekly / monthly` 的 `percent` 与 `resetsAt` |
| Grok（SuperGrok / X Premium） | `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits` | `config.creditUsagePercent`、`currentPeriod`、`productUsage`（GrokBuild / Cursor / GrokBot 分项）、`prepaidBalance`、有 cap 时的 `onDemand*` |
| Command Code | `GET https://api.commandcode.ai/alpha/billing/credits`<br>`GET https://api.commandcode.ai/alpha/billing/subscriptions` | `windowLimits.fiveHour / weekly` 的 `used/cap/resetAt`；`credits.monthlyCredits + purchasedCredits + freeCredits` 当月余额；订阅给出套餐名（Go / Pro / GOAT / Max / Ultra）、到期与是否续费 |

Command Code 的 `billing/credits` 不告诉你套餐，而当月额度的分母是套餐给的（GOAT = $70/月），
所以第二支接口按需只读一次、缓存 10 分钟（magpie 也是这么做的），读不到就退回「只显示余额」。

这几个端点在**这台机器上真实跑通过**，不是照着文档猜的形状 —— `test/live-probe.mjs` 可以随时复看。

## 二、凭据：登录，或者存 key

插件自己**不落任何秘密**，两条路都走 DSH 的凭据缝（`ctx.credentials`）：

### Grok：设备码登录（会真的把 DSH 接通）

点「登录 Grok」→ Host 用 pi-ai 同一个 client_id（`b1a00492-…`）、同一套 scope 去
`auth.x.ai/oauth2/device/code` 领设备码 → 页面显示 `user code` 和带 code 的授权链接 →
你在浏览器里确认 → Host 轮询 `/oauth2/token` → 拿到 grant 后写进

```
~/.dsh/.credentials.yaml → records["llm-pi-ai/xai"]
{ kind: grant, payload: { type: oauth, access, refresh, expires } }
```

也就是 `dsh-llm-pi-ai` 自己读的那条记录 —— 所以**在这里登录完，DSH 里选 Grok 模型就能直接对话**，
不只是能看额度。token 快过期（< 5 分钟）时读额度会先用 refresh_token 续一次并回写，
续不动就让卡片说「登录过期，重新登录」。「退出登录」删掉这条记录。

### OpenCode Go / Command Code：API key

在对应卡片里粘贴 key → `POST /quota/key` → `ctx.credentials.set("OPENCODE_GO_API_KEY" | "COMMANDCODE_API_KEY", …)`。
和 Models 页写的是同一个存储（`refs` 段），因此优先级也一样：**凭据库 > 环境变量 > 项目 .env > ~/.dsh/.env**。
卡片上会写清楚当前值来自哪一层，`清除` 只删凭据库里的那份。

Command Code 还多一条：没存 key 时自动读 CLI 自己的登录 `~/.commandcode/auth.json`（`apiKey` + `userName`），
卡片显示「使用 Command Code CLI 的登录 · 你的用户名」。这条只读，所以不给「清除」按钮。

## 三、安装

已经在 `desktop` profile 里装好了（`@local/dsh-quota`，`application: applied`）。重装/更新：

```
plugin_manager install_bundle  target = D:\Documents\deepseek-harness\default-workspace\plugins\dsh-quota
```

生效规则：**客户端 JS 每次页面加载都重新读盘**，所以改 `build/client.js` 后刷新页面即可；
**Host 侧（`build/index.js` / `providers.js` / `xai-oauth.js`）换了代码要重启 DSH**，
才会换到新一代模块（profile 里是指向本目录的软链，重启即读新文件）。

## 四、配置（都是可选的）

`cordis.patch.yml` 里的这一行默认没有 config，用内置的三个目标。要改就加：

```yaml
- id: dsh-quota
  name: '@local/dsh-quota'
  config:
    enabled: true          # false = 整页停用（chip 也消失）
    refreshMs: 60000       # 快照缓存与自动刷新间隔（10s–1h）
    timeoutMs: 8000        # 单个厂商接口超时
    providers:             # 写了就是整份替换，不是追加
      - id: opencode-go
        preset: opencode-go
        apiKeyEnv: OPENCODE_GO_API_KEY
      - id: grok
        preset: xai-billing
        record: llm-pi-ai/xai
      - id: commandcode
        preset: commandcode
        apiKeyEnv: COMMANDCODE_API_KEY
      # 换网关：baseURL 会替换 preset 的默认根路径
      - id: my-oc
        preset: opencode-go
        baseURL: https://opencode.ai/inference/go
```

`preset` 决定「问哪个接口、怎么读 JSON、怎么认证」（`key` / `oauth`），
`id` 是卡片标识与 Command Code 套餐缓存的键。

## 五、HTTP 面（前端与 Host 之间）

都是同源 JSON，写在 `build/index.js` 的 `ROUTES`：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/quota/state` | 快照（缓存 `refreshMs`） |
| POST | `/quota/refresh` | 强制重读 |
| POST | `/quota/key` | `{id, key}` → 写凭据库 |
| POST | `/quota/clear` | `{id}` → key 就 unset，oauth 就删记录 |
| POST | `/quota/login/start` | 领设备码，返回 `userCode` / 授权链接 |
| GET | `/quota/login/status?id=` | `pending` / `success` / `failed` / `cancelled` |
| POST | `/quota/login/cancel` | 取消一次登录 |

**安全边界（别忽略）**：这些路由由 Host 的 `webServer` 直接注册在应用同名 origin 上，
**不经过 DSH 页面那层 token 校验**（`GET /` 需要 token，`GET /quota/state` 不需要）。
它们只回额度数字、套餐名和「凭据是否配置 / 来自哪一层」，从不回 token 或 key 明文；
所有写操作要求 `Origin` 与本机 host 一致（缺 Origin 直接 403），因此外部网页无法借浏览器改写凭据。
但本机的任意进程都能读到这些数字 —— 在「任何本地进程本来就能读 `~/.dsh/.credentials.yaml`」的前提下，
这不算新增暴露面；想更严，可以在路由里加一层自己的共享密钥。

## 六、验证

```powershell
cd plugins\dsh-quota

node test/providers.test.mjs                  # 三个 reader 的纯逻辑（31 项）
$env:QUOTA_LIVE='1'; node test/providers.test.mjs   # 再打一次真接口（本机凭据）
node test/host.test.mjs                       # Host：路由、凭据、续期、设备码登录（39 项）
node test/client.test.mjs                     # Client：注册、取数、渲染、存 key、登录面板（31 项）
```

装好之后，真进程上也能直接看：

```powershell
curl.exe -s http://127.0.0.1:62756/quota/state          # 三张卡 + 真数字
curl.exe -s -o NUL -w '%{http_code}' -X POST -H 'content-type: application/json' `
  -H 'origin: http://127.0.0.1:62756' --data '{}' http://127.0.0.1:62756/quota/refresh
```

本机实测（2026-10-20）：

```
opencode-go  rolling 2%  weekly 19%  monthly 33%
grok         weekly 100%（本周额度用尽，6:32Z 重置）  GrokBuild 92 / Cursor 5 / GrokBot 3
commandcode  5h 0%  weekly 12%  当月 $69.93 / $70.00  plan=GOAT  10-22 到期不续
```

**没验到的**：页面在真实浏览器里的像素级观感（没有浏览器控制）。client bundle 的行为用最小 hooks 运行时跑通了，
slot 注册与文档里的名字一致；刷新页面后应当能在 composer 右侧看到 chip、在设置里看到「额度」页。

## 七、回滚

- `plugin_manager remove_bundle  target = @local/dsh-quota`，或把 profile `cordis.patch.yml` 里那行删掉；
- Grok 登录写的是 `llm-pi-ai/xai`，删掉它等于退出登录，不影响其它记录；
- `plugins/dsh-quota/` 整个目录可以留着，不影响运行。

## 八、目录

```
package.json          dsh.bundle.patch + dsh.client + exports/files
cordis.patch.yml      insert: dsh-quota
icon.svg              自绘的仪表盘图标
locale/{en,zh}.json   meta.title / meta.description（插件列表里显示）
build/providers.js    三个 reader + fetch（纯函数，可单独跑）
build/xai-oauth.js    设备码 / 续期 / grant 形状（fetch 注入，可单独测）
build/index.js        Host：配置、快照、路由、登录管理
build/client.js       Client：chip + 设置页（纯 JS，无构建步骤）
test/*.mjs            上面那三组测试 + live-probe
```
