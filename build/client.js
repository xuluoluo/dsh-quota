// The browser half of @local/dsh-quota. Plain JavaScript on purpose: the Host
// serves this file as-is, so there is no build step between this text and the
// page. It draws two things — a compact allowance chip beside the composer's
// model selector, and the Quota page in Settings, where a provider's key can
// be stored and Grok's sign-in can be approved.
window.__ModuleLoader__.load({
  id: '@local/dsh-quota',
  factory(require) {
    var module = { exports: {} }
    var React = require('react')
    var h = React.createElement

    var LOCALE_NS = 'settings.quota'
    var ROUTES = {
      state: '/quota/state',
      refresh: '/quota/refresh',
      key: '/quota/key',
      clear: '/quota/clear',
      test: '/quota/test',
      suggest: '/quota/suggest',
      models: '/quota/models',
      predict: '/quota/predict',
      providers: '/quota/providers',
      providersRemove: '/quota/providers/remove',
      loginStart: '/quota/login/start',
      loginStatus: '/quota/login/status',
      loginCancel: '/quota/login/cancel',
    }
    var REQUEST_TIMEOUT_MS = 30000
    var LOGIN_POLL_MS = 2500

    // —— 文案 ——
    var zh = {
      title: '额度',
      chipLabel: '剩余额度',
      chipTitle: '各 provider 的已用额度（点一下刷新）',
      refresh: '刷新',
      refreshing: '刷新中…',
      updated: '更新于 ',
      disabled: '额度页已在设置里关闭（enabled: false）',
      empty: '没有配置要盯的 provider',
      stale: '显示的是上一次的结果',
      missingCredential: '缺凭据',
      missingHint: '在下面保存 API key，或先登录这个 provider。',
      resetsIn: '重置 ',
      resetSoon: '即将重置',
      never: '—',
      plan: '套餐',
      balance: '余额',
      untilAuto: '续费于 ',
      untilOff: '到期于 ',
      untilPlain: '有效期至 ',
      keyTitle: 'API key',
      keyStored: '已存入 DSH 凭据库',
      keyEnv: '来自环境变量',
      keyProject: '来自项目 .env',
      keyUser: '来自 ~/.dsh/.env',
      keyCli: '使用 Command Code CLI 的登录',
      keyMissing: '未设置',
      keyPlaceholder: '粘贴 API key（只写进 DSH 凭据库）',
      save: '保存',
      saving: '保存中…',
      clear: '清除',
      savingFailed: '保存失败',
      getKey: '去取 key',
      oauthTitle: '登录',
      oauthSignedIn: '已登录',
      oauthSignedOut: '未登录',
      oauthExpires: '过期 ',
      signIn: '登录 Grok',
      signInAgain: '重新登录',
      signOut: '退出登录',
      waiting: '等你在浏览器里确认…',
      openPage: '打开授权页',
      orEnterCode: '或手动输入这个代码',
      cancel: '取消',
      intro: '每个数字都来自厂商自己的接口：OpenCode Go 的滚动 / 每周 / 每月三个窗口，Grok 订阅的本期额度，Command Code 的 5 小时 / 每周窗口加当月 credits。密钥只写进 DSH 凭据库，插件不留副本；Grok 登录写的就是 DSH 自己那条凭据记录，所以这里登录完，DSH 里也能直接用 Grok。',
      win_rolling: '滚动窗口',
      win_fiveHour: '5 小时',
      win_weekly: '一周',
      win_monthly: '一个月',
      win_hourly: '每小时',
      win_daily: '每日',
      win_seasonal: '季度',
      win_fiveHour: '5 小时',
      win_onDemand: '按需',
      win_credits: '当月额度',
      win_period: '本期',
      // 用量
      usageTitle: '用量',
      usageRange: '近 7 天',
      uToday: '今天',
      uTokens: 'TOKEN',
      uInput: '输入',
      uOutput: '输出',
      uCache: '缓存读取',
      uHit: '命中率',
      uReasoning: '推理',
      uCalls: '次调用',
      uCountedOut: '计入输出',
      uModels: '模型',
      uEmpty: '还没有用量记录：插件会从下一次模型调用开始统计',
      uFrom: '统计自每次调用返回的 usage',
      // 供应商
      addTitle: '添加供应商',
      addHint: '写进 profile 的 cordis.patch.yml，重启也还在；同一个预设可以加多个（不同网关 / 不同 key）。',
      addPreset: '预设',
      addId: 'id（唯一，字母数字与横线）',
      addLabel: '显示名（可选）',
      addBase: '网关地址（可选）',
      addKeyEnv: '凭据引用（可选，如 MY_KEY）',
      addSubmit: '添加',
      adding: '添加中…',
      providersUnit: '个供应商',
      added: '已添加',
      remove: '移除',
      removeFailed: '移除失败',
      needId: '先填 id',
      noQuota: '这家没有公开的额度接口：这张卡只负责把 key 存进 DSH 凭据库，token 用量看上面的「用量」。',
      testKey: '测试',
      testing: '测试中…',
      testOk: '连接正常',
      testFailed: '连不上',
      alertWarn: '接近上限',
      alertCritical: '已达上限',
      costEstimate: '按目录价估算',
      todayCost: '今日',
      stripTitle: '额度与今日花费（点一下刷新）',
      tabQuota: '额度',
      tabUsage: '用量',
      tabPredict: '输入预测',
      promptReset: '恢复默认',
      promptDefaultHint: '留空就用内置的那份（下面显示的就是它）。',
      uDays: '近 7 天（柱高 = 当天 token）',
      uPeak: '峰值',
      weekdays: '日,一,二,三,四,五,六',
      predictTitle: '输入预测',
      predictHint: '每轮回答结束后，在空输入框里用灰字提示你的下一句。按 Tab 或 → 填入，不会自动发送。',
      predictEnable: '启用输入预测',
      predictModel: '用哪个模型预测',
      predictSession: '跟随当前会话的模型',
      predictPrompt: '提示词（留空用内置的）',
      predictSave: '保存',
      predictSaved: '已保存',
      predictFee: '预测也是一次真实的模型调用，会计入上面的用量。',
    }

    var en = {
      title: 'Quota',
      chipLabel: 'Remaining quota',
      chipTitle: 'Allowance used per provider (click to refresh)',
      refresh: 'Refresh',
      refreshing: 'Refreshing…',
      updated: 'Updated ',
      disabled: 'This page is turned off in settings (enabled: false)',
      empty: 'No provider is being watched',
      stale: 'showing the previous result',
      missingCredential: 'No credential',
      missingHint: 'Store an API key below, or sign in to this provider.',
      resetsIn: 'resets ',
      resetSoon: 'resetting soon',
      never: '—',
      plan: 'Plan',
      balance: 'Balance',
      untilAuto: 'renews ',
      untilOff: 'expires ',
      untilPlain: 'until ',
      keyTitle: 'API key',
      keyStored: 'Stored in the DSH credential store',
      keyEnv: 'From the environment',
      keyProject: 'From the project .env',
      keyUser: 'From ~/.dsh/.env',
      keyCli: 'Using the Command Code CLI sign-in',
      keyMissing: 'Not set',
      keyPlaceholder: 'Paste an API key (written to the DSH credential store)',
      save: 'Save',
      saving: 'Saving…',
      clear: 'Clear',
      savingFailed: 'Saving failed',
      getKey: 'Get a key',
      oauthTitle: 'Sign-in',
      oauthSignedIn: 'Signed in',
      oauthSignedOut: 'Not signed in',
      oauthExpires: 'expires ',
      signIn: 'Sign in to Grok',
      signInAgain: 'Sign in again',
      signOut: 'Sign out',
      waiting: 'Waiting for the browser…',
      openPage: 'Open the approval page',
      orEnterCode: 'or enter this code by hand',
      cancel: 'Cancel',
      intro: 'Every number comes from the vendor\'s own endpoint: the OpenCode Go rolling, weekly and monthly windows, the Grok subscription period, and Command Code\'s five-hour and weekly windows plus the month\'s credits. Keys are written to the DSH credential store only; this plugin keeps no copy. Grok\'s sign-in writes the credential record DSH itself reads, so approving here also makes Grok usable in DSH.',
      win_rolling: 'rolling',
      win_fiveHour: '5-hour',
      win_weekly: 'week',
      win_monthly: 'month',
      win_hourly: 'Hourly',
      win_daily: 'Daily',
      win_seasonal: 'Seasonal',
      win_fiveHour: '5 hours',
      win_onDemand: 'On-demand',
      win_credits: 'Month credits',
      win_period: 'Period',
      usageTitle: 'Usage',
      usageRange: 'last 7 days',
      uToday: 'Today',
      uTokens: 'TOKENS',
      uInput: 'in',
      uOutput: 'out',
      uCache: 'cache read',
      uHit: 'hit rate',
      uReasoning: 'reasoning',
      uCalls: 'calls',
      uCountedOut: 'counted in output',
      uModels: 'Models',
      uEmpty: 'No usage yet: counting starts at the next model call',
      uFrom: 'from the usage each call reports',
      addTitle: 'Add a provider',
      addHint: 'Written into the profile cordis.patch.yml, so it survives a restart. One preset can be added more than once (another gateway, another key).',
      addPreset: 'Preset',
      addId: 'id (unique; letters, digits, dashes)',
      addLabel: 'Label (optional)',
      addBase: 'Gateway URL (optional)',
      addKeyEnv: 'Credential reference (optional, e.g. MY_KEY)',
      addSubmit: 'Add',
      adding: 'Adding…',
      providersUnit: 'providers',
      added: 'Added',
      remove: 'Remove',
      removeFailed: 'Removing failed',
      needId: 'Enter an id first',
      noQuota: 'No public allowance endpoint: this card only stores the key in the DSH credential store. Token usage is under Usage above.',
      testKey: 'Test',
      testing: 'Testing…',
      testOk: 'reachable',
      testFailed: 'unreachable',
      alertWarn: 'near limit',
      alertCritical: 'at limit',
      costEstimate: 'estimate from list prices',
      todayCost: 'today',
      stripTitle: 'Allowance and today cost (click to refresh)',
      tabQuota: 'Allowance',
      tabUsage: 'Usage',
      tabPredict: 'Prediction',
      promptReset: 'Use default',
      promptDefaultHint: 'Leave it empty to use the built-in prompt (shown below).',
      uDays: 'last 7 days (bar height = tokens)',
      uPeak: 'peak',
      weekdays: 'S,M,T,W,T,F,S',
      predictTitle: 'Input prediction',
      predictHint: 'After each reply, a gray prediction of your next message appears in the empty composer. Tab or → fills it in; it never sends.',
      predictEnable: 'Enable input prediction',
      predictModel: 'Model used to predict',
      predictSession: 'Follow the session model',
      predictPrompt: 'Prompt (empty uses the built-in one)',
      predictSave: 'Save',
      predictSaved: 'Saved',
      predictFee: 'A prediction is a real model call, so it counts in the usage above.',
    }

    // —— 主题令牌：只用 DSH 自己公布的别名 ——
    var C = {
      text: 'var(--dsw-alias-label-primary)',
      minor: 'var(--dsw-alias-label-secondary)',
      border: 'var(--dsw-alias-border-l1)',
      borderStrong: 'var(--dsw-alias-border-l2)',
      surface: 'var(--dsw-alias-bg-layer-1)',
      surface2: 'var(--dsw-alias-bg-layer-2)',
      success: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
      brand: 'var(--dsw-alias-brand-primary)',
    }

    function toneOf(used) {
      if (typeof used !== 'number') return 'idle'
      if (used >= 95) return 'error'
      if (used >= 75) return 'warn'
      return 'success'
    }
    function colorOf(tone) {
      return tone === 'error' ? C.error : tone === 'warn' ? C.warn : tone === 'success' ? C.success : C.idle
    }
    function percentOf(value) {
      var number = Number(value)
      return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : 0
    }

    var WINDOW_KEYS = {
      rolling: 'win_rolling',
      'five-hour': 'win_fiveHour',
      weekly: 'win_weekly',
      monthly: 'win_monthly',
      hourly: 'win_hourly',
      daily: 'win_daily',
      seasonal: 'win_seasonal',
      'five-hour': 'win_fiveHour',
      'on-demand': 'win_onDemand',
      credits: 'win_credits',
      period: 'win_period',
    }
    function windowLabel(t, key) {
      return t(WINDOW_KEYS[String(key)] || 'win_period')
    }

    // —— 取数 ——
    function request(path, options, signal) {
      var controller = new AbortController()
      var timer = setTimeout(function () { controller.abort() }, REQUEST_TIMEOUT_MS)
      if (signal) signal.addEventListener('abort', function () { controller.abort() }, { once: true })
      var url = new URL(String(path).replace(/^\//, ''), document.baseURI)
      return fetch(url, {
        credentials: 'same-origin',
        signal: controller.signal,
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        ...options,
      }).then(function (response) {
        return response.json().catch(function () { return {} }).then(function (body) {
          if (!response.ok) {
            var said = typeof body.error === 'string' ? body.error : 'HTTP ' + response.status
            var detail = body.origin ? ' · origin=' + body.origin + ' host=' + body.host + ' site=' + body.site : ''
            throw new Error(said + detail)
          }
          return body
        })
      }).finally(function () { clearTimeout(timer) })
    }

    function postJson(path, body) {
      return request(path, { method: 'POST', body: JSON.stringify(body || {}) })
    }

    function parseState(data) {
      if (!data || typeof data !== 'object') throw new Error('the Host sent no snapshot')
      var providers = Array.isArray(data.providers) ? data.providers : []
      return {
        enabled: data.enabled !== false,
        fetchedAt: typeof data.fetchedAt === 'string' ? data.fetchedAt : null,
        refreshMs: typeof data.refreshMs === 'number' && data.refreshMs >= 10000 ? data.refreshMs : 60000,
        usage: data.usage && typeof data.usage === 'object' ? data.usage : null,
        usageFile: typeof data.usageFile === 'string' ? data.usageFile : '',
        showChip: data.showChip === true,
        predict: data.predict && typeof data.predict === 'object'
          ? {
            enabled: data.predict.enabled === true,
            provider: typeof data.predict.provider === 'string' ? data.predict.provider : '',
            model: typeof data.predict.model === 'string' ? data.predict.model : '',
            systemPrompt: typeof data.predict.systemPrompt === 'string' ? data.predict.systemPrompt : '',
            debounceMs: Number(data.predict.debounceMs) > 0 ? Number(data.predict.debounceMs) : 700,
          }
          : { enabled: false, provider: '', model: '', systemPrompt: '', debounceMs: 700 },
        defaultPrompt: typeof data.defaultPrompt === 'string' ? data.defaultPrompt : '',
        presets: Array.isArray(data.presets) ? data.presets.filter(function (preset) {
          return preset && typeof preset === 'object' && typeof preset.id === 'string'
        }) : [],
        providers: providers.filter(function (card) { return card && typeof card === 'object' && typeof card.id === 'string' }),
      }
    }

    /** 一份共享快照：chip 与设置页读同一份，按 refreshMs 自动续。 */
    function createStore() {
      var state = { status: 'idle', data: null, error: null }
      var listeners = new Set()
      var timer = null
      var inflight = null

      function emit() { listeners.forEach(function (fn) { fn(state) }) }
      function set(next) { state = next; emit() }

      function schedule(ms) {
        if (timer) clearTimeout(timer)
        timer = setTimeout(function () {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') { schedule(ms); return }
          void load(false)
        }, Math.max(15000, ms || 60000))
      }

      function load(force) {
        if (inflight) return inflight
        set({ status: state.data ? 'refreshing' : 'loading', data: state.data, error: null })
        inflight = (force ? postJson(ROUTES.refresh) : request(ROUTES.state))
          .then(function (raw) {
            var next = parseState(raw)
            set({ status: 'ready', data: next, error: null })
            schedule(next.refreshMs)
            return next
          })
          .catch(function (error) {
            set({ status: 'error', data: state.data, error: error instanceof Error ? error.message : String(error) })
            schedule(60000)
            return state.data
          })
          .finally(function () { inflight = null })
        return inflight
      }

      function subscribe(fn) {
        listeners.add(fn)
        if (state.status === 'idle') void load(false)
        return function () { listeners.delete(fn) }
      }

      return {
        subscribe: subscribe,
        get: function () { return state },
        refresh: function () { return load(true) },
      }
    }

    var store = createStore()

    function useQuota() {
      var pair = React.useState(store.get())
      React.useEffect(function () {
        return store.subscribe(function (next) { pair[1](next) })
      }, [])
      return pair[0]
    }

    /** 柱状图下面那一排星期：日期按本地时区解释，别用 UTC 跨天。 */
    function weekdayOf(t, date) {
      var at = Date.parse(date + 'T00:00:00')
      if (isNaN(at)) return ''
      var list = String(t('weekdays') || '').split(',')
      return list[new Date(at).getDay()] || ''
    }

    function formatTime(iso) {
      if (!iso) return ''
      var date = new Date(iso)
      if (isNaN(date.getTime())) return ''
      var pad = function (n) { return String(n).padStart(2, '0') }
      return (date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
    }

    function relativeReset(iso, t) {
      if (!iso) return ''
      var at = Date.parse(iso)
      if (isNaN(at)) return ''
      var minutes = Math.round((at - Date.now()) / 60000)
      if (minutes <= 0) return t('resetSoon')
      var days = Math.floor(minutes / 1440)
      var hours = Math.floor((minutes % 1440) / 60)
      var rest = minutes % 60
      if (days > 0) return days + 'd ' + hours + 'h'
      if (hours > 0) return hours + 'h ' + rest + 'm'
      return rest + 'm'
    }

    // —— 小组件 ——
    var barTrack = {
      position: 'relative', flex: '1', height: '7px', borderRadius: '999px',
      background: C.surface2, overflow: 'hidden', minWidth: '60px',
    }

    function Bar(props) {
      var used = percentOf(props.used)
      return h('div', { style: barTrack },
        h('div', {
          style: {
            position: 'absolute', top: '0', bottom: '0', left: '0', width: used + '%',
            background: colorOf(toneOf(used)), borderRadius: '999px',
          },
        }))
    }

    // 数字统一等宽，表格才对齐得起来
    var num = { fontVariantNumeric: 'tabular-nums' }
    var button = {
      border: '1px solid ' + C.borderStrong, background: C.surface, color: C.text,
      borderRadius: '8px', padding: '5px 12px', fontSize: '12px', lineHeight: '18px',
      cursor: 'pointer', whiteSpace: 'nowrap', fontFamily: 'inherit',
    }
    var buttonPrimary = Object.assign({}, button, { borderColor: C.brand, color: C.brand, background: C.surface2, fontWeight: '500' })
    var buttonQuiet = Object.assign({}, button, { borderColor: 'transparent', background: 'transparent', color: C.minor, padding: '2px 6px' })
    var disabledStyle = { opacity: 0.55, cursor: 'default' }
    var dotBase = {
      width: '6px', height: '6px', borderRadius: '50%', flex: 'none', display: 'inline-block',
    }

    function externalLink(url, label) {
      if (!url) return null
      return h('a', {
        href: url, target: '_blank', rel: 'noreferrer noopener',
        style: { color: C.brand, fontSize: '12px', textDecoration: 'none', whiteSpace: 'nowrap' },
      }, label)
    }

    // —— chip：composer 工具条右侧 ——
    function QuotaChip(props) {
      var t = props.t
      var state = useQuota()
      var data = state.data
      // 窄条与 chip 是同一份数字，默认只留窄条（配置 showChip: true 才回来）。
      if (!data || data.enabled === false || data.showChip !== true) return null
      var cards = data.providers
      if (cards.length === 0) return null

      var title = t('chipTitle')
      if (data.fetchedAt) title += '\n' + t('updated') + formatTime(data.fetchedAt)

      return h('div', {
        'data-dsh-quota': 'chip',
        title: title,
        onClick: function () { void store.refresh() },
        style: {
          display: 'inline-flex', alignItems: 'center', gap: '6px',
          cursor: 'pointer', userSelect: 'none', padding: '0 2px',
        },
      }, cards.map(function (card) {
        var worst = card.worst && typeof card.worst.used === 'number' ? card.worst : null
        var tone = card.error ? 'error' : toneOf(worst ? worst.used : undefined)
        var detail = card.error
          ? card.error
          : (card.windows || []).map(function (win) {
            return windowLabel(t, win.key) + ' ' + percentOf(win.used) + '%' +
              (win.resetsAt ? ' · ' + t('resetsIn') + relativeReset(win.resetsAt, t) : '')
          }).join('\n')
        var value = card.error ? '!' : worst ? percentOf(worst.used) + '%' : (card.balance || t('never'))
        return h('span', {
          key: card.id,
          title: cardTooltip(t, card),
          style: {
            display: 'inline-flex', alignItems: 'center', gap: '5px',
            padding: '1px 7px', borderRadius: '999px', border: '1px solid ' + C.border,
            fontSize: '11px', lineHeight: '16px', color: C.minor, whiteSpace: 'nowrap',
          },
        },
        h('span', { style: Object.assign({}, dotBase, { background: colorOf(tone) }) }),
        h('span', null, card.label),
        h('span', { style: { color: card.error ? C.error : C.text } }, value))
      }))
    }

    // —— 常驻窄条：挂在输入框下方，不用打开设置 ——
    function QuotaStrip(props) {
      var t = props.t
      var state = useQuota()
      var data = state.data
      if (!data || data.enabled === false) return null
      var cards = data.providers
      if (cards.length === 0) return null
      var cost = moneyCost(data.usage && data.usage.todayCost)
      var title = t('stripTitle')
      if (data.fetchedAt) title += '\n' + t('updated') + formatTime(data.fetchedAt)

      return h('div', {
        'data-dsh-quota': 'strip',
        title: title,
        onClick: function () { void store.refresh() },
        style: {
          display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap',
          padding: '3px 2px 0', fontSize: '11px', color: C.minor,
          cursor: 'pointer', userSelect: 'none',
        },
      },
      cards.map(function (card) {
        var worst = card.worst && typeof card.worst.used === 'number' ? card.worst : null
        var tone = card.alert === 'critical'
          ? 'error'
          : card.alert === 'warn' ? 'warn' : card.error ? 'error' : toneOf(worst ? worst.used : undefined)
        var value = card.error ? '!' : worst ? percentOf(worst.used) + '%' : (card.balance || t('never'))
        return h('span', {
          key: card.id,
          title: cardTooltip(t, card),
          style: { display: 'inline-flex', alignItems: 'center', gap: '4px' },
        },
        h('span', { style: Object.assign({}, dotBase, { background: colorOf(tone) }) }),
        h('span', null, card.label),
        h('span', { style: Object.assign({ color: card.alert || card.error ? colorOf(tone) : C.text, fontWeight: card.alert ? '600' : '400' }, num) }, (card.alert ? '⚠ ' : '') + value))
      }),
      cost ? h('span', { style: { marginLeft: 'auto' } }, t('todayCost') + ' ≈' + cost) : null)
    }

    /** 悬停时看的全量额度：每家每个窗口一行，带剩余与重置倒计时。 */
    function cardTooltip(t, card) {
      var lines = [card.label]
      var windows = Array.isArray(card.windows) ? card.windows : []
      windows.forEach(function (win) {
        var used = percentOf(win.used)
        var reset = win.resetsAt ? relativeReset(win.resetsAt, t) : ''
        var tail = win.display || (reset === '' ? '' : reset === t('resetSoon') ? reset : t('resetsIn') + reset)
        lines.push(windowLabel(t, win.key) + ' · ' + used + '%' + (tail ? ' · ' + tail : ''))
      })
      if (card.plan) lines.push(t('plan') + ' · ' + card.plan)
      if (card.balance) lines.push(t('balance') + ' · ' + card.balance)
      if (card.note) lines.push(card.note)
      if (card.error) lines.push(card.error)
      if (card.quota === false) lines.push(t('noQuota'))
      return lines.join('\n')
    }
    // —— 输入预测：空输入框里的灰字 ——
    /**
     * 灰字贴在光标后面。位置来自选区：容器（这个 overlay 槽）通常在 composer
     * 内部，所以把光标的视口坐标减去容器的坐标就是相对位置。
     */
    function caretBox(container, ghost) {
      if (!container || typeof window === 'undefined' || typeof window.getSelection !== 'function') return null
      var selection = window.getSelection()
      if (!selection || selection.rangeCount === 0) return null
      var range = selection.getRangeAt(0)
      var rect = typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : null
      if (!rect || (rect.width === 0 && rect.height === 0)) return null
      var base = container.getBoundingClientRect()
      var editor = container.parentElement ? container.parentElement.querySelector('[contenteditable="true"]') : null
      var style = editor && typeof window.getComputedStyle === 'function' ? window.getComputedStyle(editor) : null
      return {
        left: rect.right - base.left,
        top: rect.top - base.top,
        font: style ? style.font : 'inherit',
        lineHeight: style ? style.lineHeight : '20px',
        color: style ? style.color : 'inherit',
      }
    }

    function PromptGhost(props) {
      var state = useQuota()
      var data = state.data
      var predict = data && data.predict
      var enabled = Boolean(predict && predict.enabled)
      var debounceMs = predict && Number(predict.debounceMs) > 0 ? Number(predict.debounceMs) : 700

      // 这三个 hook 由槽提供；缺席时退化成「什么都看不到」，不会打断渲染。
      var useInput = typeof props.useInput === 'function' ? props.useInput : function () { return function () {} }
      var useSession = typeof props.useSession === 'function' ? props.useSession : function () { return function () {} }
      var input = useInput(function (snapshot) { return snapshot })
      var session = useSession(function (snapshot) { return snapshot })
      var draft = input && typeof input.draft === 'string' ? input.draft : ''
      var running = Boolean(session && session.running === true)
      var sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''

      var shownState = React.useState(null)
      var ghost = shownState[0]
      var setGhost = shownState[1]
      var boxState = React.useState(null)
      var box = boxState[0]
      var setBox = boxState[1]
      var root = React.useRef(null)
      var inflight = React.useRef(null)

      React.useEffect(function () {
        if (inflight.current) inflight.current.abort()
        if (!enabled || sessionId === '' || running || draft.trim() !== '') {
          setGhost(null)
          return undefined
        }
        var timer = window.setTimeout(function () {
          var abort = new AbortController()
          inflight.current = abort
          fetch(new URL(ROUTES.suggest.replace(/^\//, ''), document.baseURI), {
            method: 'POST',
            credentials: 'same-origin',
            signal: abort.signal,
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: sessionId }),
          })
            .then(function (response) { return response.json().catch(function () { return {} }) })
            .then(function (body) {
              if (abort.signal.aborted) return
              if (body && typeof body.suggestion === 'string' && body.suggestion !== '') setGhost({ text: body.suggestion })
            })
            .catch(function () {})
        }, debounceMs)
        return function () { window.clearTimeout(timer) }
      }, [enabled, sessionId, running, draft, debounceMs])

      React.useEffect(function () {
        if (!ghost) { setBox(null); return undefined }
        function measure() { setBox(caretBox(root.current, ghost)) }
        measure()
        var timer = window.setInterval(measure, 400)
        window.addEventListener('resize', measure)
        return function () {
          window.clearInterval(timer)
          window.removeEventListener('resize', measure)
        }
      }, [ghost])

      // 键位只挂一次：用 ref 读当前预测，避免每次都重新绑定。
      var ghostRef = React.useRef(null)
      ghostRef.current = ghost

      var accept = function () {
        var current = ghostRef.current
        if (!current) return false
        var actions = props.inputActions
        if (!actions || typeof actions.insertText !== 'function') return false
        var span = typeof actions.captureInsertion === 'function' ? actions.captureInsertion() : undefined
        setGhost(null)
        return actions.insertText(current.text, span) !== false
      }

      React.useEffect(function () {
        if (!enabled) return undefined
        function onKeyDown(event) {
          if (event.isComposing || !ghostRef.current) return
          if ((event.key === 'Tab' || event.key === 'ArrowRight') && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
            if (accept()) {
              event.preventDefault()
              event.stopPropagation()
            }
            return
          }
          if (event.key === 'Escape') setGhost(null)
        }
        window.addEventListener('keydown', onKeyDown, true)
        return function () { window.removeEventListener('keydown', onKeyDown, true) }
      }, [enabled])

      if (!ghost) return null
      return h('div', {
        'data-dsh-quota': 'ghost',
        style: { position: 'absolute', inset: '0', pointerEvents: 'none', overflow: 'hidden' },
      },
      box
        ? h('span', {
          style: {
            position: 'absolute',
            left: box.left + 'px',
            top: box.top + 'px',
            font: box.font,
            lineHeight: box.lineHeight,
            color: box.color,
            opacity: 0.4,
            whiteSpace: 'pre',
            pointerEvents: 'none',
            maxWidth: '70%',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          },
        }, ghost.text)
        : null)
    }

    // —— 凭据区 ——
    function credentialState(t, credential) {
      if (!credential || !credential.configured) return t('keyMissing')
      if (credential.source === 'cli') return t('keyCli')
      if (credential.source === 'record') return t('oauthSignedIn')
      if (credential.source === 'env') return t('keyEnv')
      if (credential.source === 'project-env') return t('keyProject')
      if (credential.source === 'user-env') return t('keyUser')
      return t('keyStored')
    }

    function CredentialRow(props) {
      var t = props.t
      var card = props.card
      var credential = card.credential || {}
      var busy = Boolean(props.busy)
      var draft = props.draft || ''
      var state = credentialState(t, credential)
      var detail = credential.account ? ' · ' + credential.account : ''
      if (credential.expiresAt) detail += ' · ' + t('oauthExpires') + formatTime(credential.expiresAt)

      var status = h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: C.minor, flex: '1', minWidth: '160px', flexWrap: 'wrap' } },
        h('span', { style: Object.assign({}, dotBase, { background: credential.configured ? C.success : C.idle }) }),
        h('span', { style: { color: credential.configured ? C.text : C.minor } }, state + detail))

      if (credential.auth === 'oauth') {
        return h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
          status,
          h('button', {
            type: 'button',
            style: Object.assign({}, buttonPrimary, busy ? disabledStyle : {}),
            disabled: busy,
            onClick: props.onSignIn,
          }, credential.configured ? t('signInAgain') : t('signIn')),
          credential.configured
            ? h('button', { type: 'button', style: buttonQuiet, disabled: busy, onClick: props.onSignOut }, t('signOut'))
            : null)
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } },
          status,
          credential.hint
            ? h('code', { style: { fontFamily: 'ui-monospace, monospace', fontSize: '11px', color: C.minor } }, credential.hint)
            : null,
          h('span', { style: { flex: '1' } }),
          externalLink(props.keysUrl, t('getKey'))),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          h('input', {
            type: 'password',
            value: draft,
            placeholder: t('keyPlaceholder'),
            autoComplete: 'off',
            spellCheck: false,
            onChange: function (event) { props.onDraft(event.target.value) },
            onKeyDown: function (event) { if (event.key === 'Enter') props.onSave() },
            style: {
              flex: '1', minWidth: '120px', border: '1px solid ' + C.border, background: C.surface2,
              color: C.text, borderRadius: '8px', padding: '5px 8px', fontSize: '12px',
              fontFamily: 'inherit', outline: 'none',
            },
          }),
          h('button', {
            type: 'button',
            style: Object.assign({}, buttonPrimary, busy || draft.trim() === '' ? disabledStyle : {}),
            disabled: busy || draft.trim() === '',
            onClick: props.onSave,
          }, busy ? t('saving') : t('save')),
          credential.configured
            ? h('button', { type: 'button', style: buttonQuiet, disabled: busy, onClick: props.onTest }, busy ? t('testing') : t('testKey'))
            : null,
          credential.configured && credential.writable !== false
            ? h('button', { type: 'button', style: buttonQuiet, disabled: busy, onClick: props.onClear }, t('clear'))
            : null))
    }

    function LoginPanel(props) {
      var t = props.t
      var attempt = props.attempt
      if (!attempt || attempt.status !== 'pending') return null
      return h('div', {
        style: {
          border: '1px solid ' + C.border, background: C.surface2, borderRadius: '10px',
          padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '6px',
        },
      },
      h('div', { style: { fontSize: '12px', color: C.text } }, t('waiting')),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
        h('code', {
          style: {
            fontFamily: 'ui-monospace, monospace', fontSize: '14px', letterSpacing: '1px',
            color: C.text, background: C.surface, border: '1px solid ' + C.border,
            borderRadius: '8px', padding: '3px 8px',
          },
        }, attempt.userCode || ''),
        externalLink(attempt.verificationUriComplete || attempt.verificationUri, t('openPage')),
        h('span', { style: { fontSize: '11px', color: C.minor } }, t('orEnterCode')),
        h('span', { style: { flex: '1' } }),
        h('button', { type: 'button', style: buttonQuiet, onClick: props.onCancel }, t('cancel'))))
    }

    function Card(props) {
      var t = props.t
      var card = props.card
      var windows = Array.isArray(card.windows) ? card.windows : []
      var term = ''
      if (card.until) {
        var lead = card.renew === 'off' ? t('untilOff') : card.renew === 'auto' ? t('untilAuto') : t('untilPlain')
        term = lead + formatTime(card.until)
      }

      return h('div', {
        style: {
          border: '1px solid ' + C.border, background: C.surface, borderRadius: '14px',
          padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '12px',
        },
      },
      h('div', { title: cardTooltip(t, card), style: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' } },
        h('span', { style: { fontSize: '13.5px', fontWeight: '600', color: C.text, letterSpacing: '-.01em' } }, card.label),
        h('span', {
          style: {
            fontSize: '10px', color: C.minor, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            background: C.surface2, borderRadius: '4px', padding: '1px 5px',
          },
        }, card.id),
        card.plan
          ? h('span', { style: { fontSize: '11px', color: C.brand, border: '1px solid ' + C.brand, borderRadius: '999px', padding: '0 6px' } }, t('plan') + ' · ' + card.plan)
          : null,
        card.alert
          ? h('span', {
            style: {
              fontSize: '11px', borderRadius: '999px', padding: '0 6px',
              border: '1px solid ' + (card.alert === 'critical' ? C.error : C.warn),
              color: card.alert === 'critical' ? C.error : C.warn,
            },
          }, '⚠ ' + (card.alert === 'critical' ? t('alertCritical') : t('alertWarn')))
          : null,
        h('span', { style: { flex: '1' } }),
        term ? h('span', { style: { fontSize: '11px', color: C.minor } }, term) : null,
        h('button', { type: 'button', style: buttonQuiet, title: t('remove'), onClick: props.onRemove }, t('remove'))),

      windows.length > 0
        ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
          windows.map(function (win) {
            var used = percentOf(win.used)
            return h('div', { key: win.key, style: { display: 'flex', alignItems: 'center', gap: '10px' } },
              h('span', { style: { fontSize: '12px', color: C.minor, width: '88px', flex: 'none' } }, windowLabel(t, win.key)),
              h(Bar, { used: used }),
              h('span', { style: Object.assign({ fontSize: '12px', color: C.text, width: '46px', textAlign: 'right', flex: 'none' }, num) }, used + '%'),
              h('span', { style: Object.assign({ fontSize: '11px', color: C.minor, minWidth: '104px', textAlign: 'right', flex: 'none' }, num) },
                win.display || (win.resetsAt ? t('resetsIn') + relativeReset(win.resetsAt, t) : '')))
          }))
        : null,

      Array.isArray(card.parts) && card.parts.length > 0
        ? h('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap' } },
          card.parts.map(function (part) {
            return h('span', { key: part.name, style: { fontSize: '11px', color: C.minor } },
              part.name + ' ' + percentOf(part.used) + '%')
          }))
        : null,

      card.balance
        ? h('div', { style: { fontSize: '12px', color: C.text } }, t('balance') + ' · ' + card.balance)
        : null,

      card.note
        ? h('div', { style: { fontSize: '11px', color: C.minor } }, card.note)
        : null,

      card.quota === false
        ? h('div', { style: { fontSize: '11px', color: C.minor, lineHeight: '17px' } }, t('noQuota'))
        : null,

      card.error
        ? h('div', { style: { fontSize: '12px', color: C.error, lineHeight: '18px' } },
          (card.missing ? t('missingCredential') + ' — ' + t('missingHint') + ' ' : '') + card.error)
        : null,

      h('div', { style: { borderTop: '1px solid ' + C.border, paddingTop: '10px', display: 'flex', flexDirection: 'column', gap: '8px' } },
        h('div', { style: { fontSize: '11px', color: C.minor, textTransform: 'uppercase', letterSpacing: '.04em' } },
          card.credential && card.credential.auth === 'oauth' ? t('oauthTitle') : t('keyTitle')),
        h(CredentialRow, {
          t: t,
          card: card,
          busy: props.busy,
          draft: props.draft,
          keysUrl: card.keysUrl,
          onDraft: props.onDraft,
          onSave: props.onSave,
          onClear: props.onClear,
          onSignIn: props.onSignIn,
          onSignOut: props.onSignOut,
          onTest: props.onTest,
        }),
        h(LoginPanel, { t: t, attempt: props.login, onCancel: props.onCancelLogin })),

      props.notice
        ? h('div', { style: { fontSize: '11px', color: props.notice.error ? C.error : C.success } }, props.notice.text)
        : null)
    }

    // —— 用量 ——
    function compact(value) {
      var number = Number(value) || 0
      if (number >= 1e6) return (number / 1e6).toFixed(1).replace(/\.0$/, '') + 'M'
      if (number >= 1e3) return (number / 1e3).toFixed(1).replace(/\.0$/, '') + 'K'
      return String(Math.round(number))
    }

    /** 金额：不到一分钱也说出来，否则会被读成「免费」。 */
    function moneyCost(value) {
      var number = Number(value)
      if (!Number.isFinite(number) || number <= 0) return ''
      if (number < 0.005) return '<$0.01'
      return '$' + number.toFixed(number < 0.1 ? 3 : 2)
    }

    /** 缓存命中率：缓存读取 /（缓存读取 + 新输入）。 */
    function hitRate(cacheRead, input) {
      var cached = Number(cacheRead) || 0
      var fresh = Number(input) || 0
      var total = cached + fresh
      return total > 0 ? Math.round((cached / total) * 100) : 0
    }

    var tile = { display: 'flex', flexDirection: 'column', gap: '3px', padding: '12px 16px', minWidth: '0' }

    function UsageTile(props) {
      return h('div', {
        style: Object.assign({}, tile, { borderLeft: props.first ? 'none' : '1px solid ' + C.border }),
      },
      h('div', { style: Object.assign({ fontSize: '22px', lineHeight: '26px', color: C.text, fontWeight: '600', letterSpacing: '-.01em' }, num) }, props.value),
      h('div', { style: { fontSize: '10px', letterSpacing: '.08em', color: C.minor, textTransform: 'uppercase' } }, props.label),
      props.note ? h('div', { style: { fontSize: '11px', color: C.minor, lineHeight: '15px' } }, props.note) : null)
    }

    function UsageSection(props) {
      var t = props.t
      var usage = props.usage
      if (!usage || !usage.window) return null
      var week = usage.window
      var tokens = (week.input || 0) + (week.output || 0)
      var biggest = 0
      var peak = 0
      ;(usage.models || []).forEach(function (line) { biggest = Math.max(biggest, (line.input || 0) + (line.output || 0)) })
      ;(usage.days || []).forEach(function (day) { peak = Math.max(peak, (day.input || 0) + (day.output || 0)) })

      return h('section', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' } },
          h('h3', { style: { margin: 0, fontSize: '13px', fontWeight: '600', color: C.text, letterSpacing: '-.01em' } }, t('usageTitle')),
          h('span', { style: { fontSize: '11px', color: C.minor } }, t('usageRange')),
          h('span', { style: { flex: '1' } }),
          h('span', { style: { fontSize: '11px', color: C.minor } }, t('uFrom'))),

        h('div', {
          style: {
            border: '1px solid ' + C.border, background: C.surface, borderRadius: '12px',
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', overflow: 'hidden',
          },
        },
        h(UsageTile, {
          first: true,
          value: compact(tokens),
          label: t('uTokens'),
          note: t('uInput') + ' ' + compact(week.input) + ' · ' + t('uOutput') + ' ' + compact(week.output) + (usage.cost ? ' · ≈' + moneyCost(usage.cost) : ''),
        }),
        h(UsageTile, { value: compact(week.cacheRead), label: t('uCache'), note: t('uHit') + ' ' + hitRate(week.cacheRead, week.input) + '%' }),
        h(UsageTile, { value: compact(week.reasoning), label: t('uReasoning'), note: t('uCountedOut') }),
        h(UsageTile, { value: compact(week.calls), label: t('uCalls'), note: t('uToday') + ' ' + compact(usage.today && usage.today.calls) })),

        peak > 0
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
            h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px' } },
              h('span', { style: { fontSize: '11px', color: C.minor } }, t('uDays')),
              h('span', { style: { flex: '1' } }),
              h('span', { style: Object.assign({ fontSize: '11px', color: C.minor }, num) }, t('uPeak') + ' ' + compact(peak))),
            h('div', { style: { display: 'flex', alignItems: 'flex-end', gap: '4px', height: '40px', borderBottom: '1px solid ' + C.border } },
              (usage.days || []).map(function (day, index) {
                var value = (day.input || 0) + (day.output || 0)
                var today = index === usage.days.length - 1
                var height = value > 0 ? Math.max(4, Math.round((value / peak) * 40)) : 0
                return h('div', {
                  key: day.date,
                  title: day.date + ' · ' + compact(value) + ' · ' + compact(day.calls),
                  style: { flex: '1', display: 'flex', justifyContent: 'center', alignItems: 'flex-end' },
                },
                h('div', {
                  style: {
                    width: '100%', maxWidth: '34px', height: height > 0 ? height + 'px' : '2px',
                    borderRadius: '3px 3px 0 0',
                    background: value > 0 ? C.brand : C.border,
                    opacity: value > 0 ? (today ? 0.6 : 0.25) : 1,
                  },
                }))
              })),
            h('div', { style: { display: 'flex', gap: '4px' } },
              (usage.days || []).map(function (day, index) {
                var today = index === usage.days.length - 1
                return h('div', {
                  key: day.date,
                  style: { flex: '1', textAlign: 'center', fontSize: '10px', color: today ? C.text : C.minor, fontWeight: today ? '600' : '400' },
                }, weekdayOf(t, day.date))
              })))
          : null,

        (usage.models || []).length > 0
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
            h('div', { style: { fontSize: '11px', color: C.minor, textTransform: 'uppercase', letterSpacing: '.04em' } }, t('uModels')),
            (usage.models || []).map(function (line) {
              var total = (line.input || 0) + (line.output || 0)
              return h('div', {
                key: line.provider + '/' + line.model,
                style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
              },
              h('span', {
                style: { fontSize: '12px', color: C.text, minWidth: '140px', flex: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
              }, line.model),
              h('span', { style: { fontSize: '11px', color: C.minor, width: '84px', flex: 'none' } }, line.provider),
              h('div', { style: { flex: '1', height: '5px', borderRadius: '999px', background: C.surface2, overflow: 'hidden', minWidth: '40px' } },
                h('div', {
                  style: {
                    width: (biggest > 0 ? Math.round((total / biggest) * 100) : 0) + '%',
                    height: '5px', background: C.brand, borderRadius: '999px', opacity: 0.35,
                  },
                })),
              h('span', { style: { fontSize: '11px', color: C.minor, minWidth: '148px', textAlign: 'right', flex: 'none' } },
                compact(line.input) + ' / ' + compact(line.output) + ' · ' + t('uHit') + ' ' + hitRate(line.cacheRead, line.input) + '%'),
              h('span', { style: { fontSize: '12px', color: C.text, minWidth: '86px', textAlign: 'right', flex: 'none' } }, compact(total) + (line.cost ? ' · ' + moneyCost(line.cost) : '')))
            }))
          : h('div', { style: { fontSize: '12px', color: C.minor } }, t('uEmpty')))
    }

    // —— 添加供应商 ——
    var field = {
      border: '1px solid ' + C.border, background: C.surface2, color: C.text,
      borderRadius: '8px', padding: '5px 8px', fontSize: '12px', fontFamily: 'inherit', outline: 'none',
    }

    function AddProvider(props) {
      var t = props.t
      var presets = Array.isArray(props.presets) ? props.presets : []
      var presetState = React.useState('')
      var draftState = React.useState({ id: '', label: '', baseURL: '', apiKeyEnv: '' })
      var busyState = React.useState(false)
      var errorState = React.useState('')
      var chosen = presetState[0]
      var draft = draftState[0]
      var busy = busyState[0]
      var error = errorState[0]
      var active = chosen || (presets[0] ? presets[0].id : '')

      function edit(key, value) {
        var next = Object.assign({}, draft)
        next[key] = value
        draftState[1](next)
      }

      function submit() {
        var id = (draft.id || '').trim()
        if (id === '') {
          errorState[1](t('needId'))
          return
        }
        busyState[1](true)
        errorState[1]('')
        postJson(ROUTES.providers, {
          preset: active,
          id: id,
          label: draft.label,
          baseURL: draft.baseURL,
          apiKeyEnv: draft.apiKeyEnv,
        })
          .then(function () {
            draftState[1]({ id: '', label: '', baseURL: '', apiKeyEnv: '' })
            errorState[1]('')
            if (props.onClose) props.onClose()
            props.onChanged()
          })
          .catch(function (failure) {
            errorState[1](failure instanceof Error ? failure.message : String(failure))
            // The edit reloads the Host plugin, so the response can be lost
            // after the write landed; refresh anyway and let the list speak.
            props.onChanged()
          })
          .finally(function () { busyState[1](false) })
      }

      return h('section', {
        style: {
          border: '1px solid ' + C.border, background: C.surface, borderRadius: '14px',
          padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '12px',
        },
      },
      h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px' } },
        h('h3', { style: { margin: 0, fontSize: '13px', fontWeight: '500', color: C.text } }, t('addTitle')),
        h('span', { style: { fontSize: '11px', color: C.minor } }, t('addHint'))),
      h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } },
        h('select', {
          value: active,
          onChange: function (event) { presetState[1](event.target.value) },
          style: Object.assign({}, field, { minWidth: '150px' }),
        }, presets.map(function (preset) {
          return h('option', { key: preset.id, value: preset.id }, preset.label)
        })),
        h('input', {
          value: draft.id,
          placeholder: t('addId'),
          onChange: function (event) { edit('id', event.target.value) },
          style: Object.assign({}, field, { width: '160px' }),
        }),
        h('input', {
          value: draft.label,
          placeholder: t('addLabel'),
          onChange: function (event) { edit('label', event.target.value) },
          style: Object.assign({}, field, { width: '140px' }),
        }),
        h('input', {
          value: draft.baseURL,
          placeholder: t('addBase'),
          onChange: function (event) { edit('baseURL', event.target.value) },
          style: Object.assign({}, field, { flex: '1', minWidth: '160px' }),
        }),
        h('input', {
          value: draft.apiKeyEnv,
          placeholder: t('addKeyEnv'),
          onChange: function (event) { edit('apiKeyEnv', event.target.value) },
          style: Object.assign({}, field, { width: '170px' }),
        }),
        h('button', {
          type: 'button',
          style: Object.assign({}, buttonPrimary, busy ? disabledStyle : {}),
          disabled: busy,
          onClick: submit,
        }, busy ? t('adding') : t('addSubmit')),
        h('button', {
          type: 'button',
          style: buttonQuiet,
          onClick: function () { if (props.onClose) props.onClose() },
        }, t('cancel'))),
      error ? h('div', { style: { fontSize: '11px', color: C.error } }, error) : null)
    }

    // —— 设置页 ——
    function QuotaPage(props) {
      var t = props.t
      var state = useQuota()
      var data = state.data
      var cards = data ? data.providers : []
      var busy = state.status === 'refreshing'
      var tabState = React.useState('quota')
      var tab = tabState[0]
      var setTab = tabState[1]

      var draftsState = React.useState({})
      var drafts = draftsState[0]
      var setDrafts = draftsState[1]
      var workingState = React.useState('')
      var working = workingState[0]
      var setWorking = workingState[1]
      var noticesState = React.useState({})
      var notices = noticesState[0]
      var setNotices = noticesState[1]
      var loginsState = React.useState({})
      var logins = loginsState[0]
      var setLogins = loginsState[1]
      var addingState = React.useState(false)
      var adding = addingState[0]
      var setAdding = addingState[1]

      function setDraft(id, value) {
        var next = Object.assign({}, drafts)
        next[id] = value
        setDrafts(next)
      }
      function setNotice(id, notice) {
        var next = Object.assign({}, notices)
        if (notice) next[id] = notice
        else delete next[id]
        setNotices(next)
      }
      function noticeError(id, error) {
        setNotice(id, { text: error instanceof Error ? error.message : String(error), error: true })
      }

      // 有登录在进行时每 2.5 秒问一次状态；成功就刷新快照。
      React.useEffect(function () {
        var pending = cards.filter(function (card) {
          var attempt = logins[card.id] || card.login
          return attempt && attempt.status === 'pending'
        })
        if (pending.length === 0) return undefined
        var timer = setTimeout(function () {
          pending.forEach(function (card) {
            request(ROUTES.loginStatus + '?id=' + encodeURIComponent(card.id)).then(function (attempt) {
              var next = Object.assign({}, logins)
              next[card.id] = attempt
              setLogins(next)
              if (attempt.status === 'success' || attempt.status === 'failed') {
                setNotice(card.id, attempt.error ? { text: attempt.error, error: true } : null)
                if (attempt.status === 'success') void store.refresh()
              }
            }).catch(function () {})
          })
        }, LOGIN_POLL_MS)
        return function () { clearTimeout(timer) }
      })

      function run(id, promise) {
        setWorking(id)
        return promise
          .then(function () { return store.refresh() })
          .catch(function (error) { noticeError(id, error) })
          .finally(function () { setWorking('') })
      }

      function onSave(card) {
        var value = (drafts[card.id] || '').trim()
        if (value === '') return
        setWorking(card.id)
        postJson(ROUTES.key, { id: card.id, key: value })
          .then(function () {
            setDraft(card.id, '')
            setNotice(card.id, null)
            return store.refresh()
          })
          .catch(function (error) { noticeError(card.id, error) })
          .finally(function () { setWorking('') })
      }
      function onTest(card) {
        setWorking(card.id)
        setNotice(card.id, null)
        postJson(ROUTES.test, { id: card.id })
          .then(function (result) {
            var said = result.ok ? t('testOk') : t('testFailed')
            setNotice(card.id, { text: said + (result.detail ? ' · ' + result.detail : ''), error: !result.ok })
          })
          .catch(function (error) { noticeError(card.id, error) })
          .finally(function () { setWorking('') })
      }
      function onClear(card) {
        void run(card.id, postJson(ROUTES.clear, { id: card.id }))
      }
      function onRemove(card) {
        var next = Object.assign({}, logins)
        delete next[card.id]
        setLogins(next)
        void run(card.id, postJson(ROUTES.providersRemove, { id: card.id }))
      }
      function onSignIn(card) {
        setWorking(card.id)
        setNotice(card.id, null)
        postJson(ROUTES.loginStart, { id: card.id })
          .then(function (attempt) {
            var next = Object.assign({}, logins)
            next[card.id] = attempt
            setLogins(next)
          })
          .catch(function (error) { noticeError(card.id, error) })
          .finally(function () { setWorking('') })
      }
      function onSignOut(card) {
        var next = Object.assign({}, logins)
        delete next[card.id]
        setLogins(next)
        void run(card.id, postJson(ROUTES.clear, { id: card.id }))
      }
      function onCancelLogin(card) {
        var next = Object.assign({}, logins)
        next[card.id] = { status: 'cancelled' }
        setLogins(next)
        postJson(ROUTES.loginCancel, { id: card.id }).catch(function () {})
      }

      return h('section', { style: { display: 'flex', flexDirection: 'column', gap: '14px', maxWidth: '760px' } },
        h('header', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
          h('h2', { style: { margin: 0, fontSize: '16px', fontWeight: '600', color: C.text, letterSpacing: '-.015em' } }, t('title')),
          h('span', { style: { flex: '1' } }),
          data && data.fetchedAt
            ? h('span', { style: { fontSize: '11px', color: C.minor } }, t('updated') + formatTime(data.fetchedAt))
            : null,
          h('button', {
            type: 'button',
            style: Object.assign({}, button, busy ? disabledStyle : {}),
            disabled: busy,
            onClick: function () { void store.refresh() },
          }, busy ? t('refreshing') : t('refresh'))),

        h('p', { style: { margin: 0, fontSize: '12px', lineHeight: '19px', color: C.minor, maxWidth: '62ch' } }, t('intro')),

        h(Tabs, {
          tab: tab,
          onTab: setTab,
          items: [
            { id: 'quota', label: t('tabQuota') },
            { id: 'usage', label: t('tabUsage') },
            { id: 'predict', label: t('tabPredict') },
          ],
        }),

        tab === 'quota'
          ? [
            h('div', { key: 'bar', style: { display: 'flex', alignItems: 'center', gap: '8px' } },
              h('button', {
                type: 'button',
                style: Object.assign({}, buttonPrimary, adding ? { borderColor: C.borderStrong, color: C.minor } : {}),
                onClick: function () { setAdding(!adding) },
              }, adding ? t('cancel') : '+ ' + t('addTitle')),
              h('span', { style: { flex: '1' } }),
              h('span', { style: { fontSize: '11px', color: C.minor } },
                cards.length + ' ' + t('providersUnit'))),

            adding
              ? h(AddProvider, {
                key: 'add',
                t: t,
                presets: data && data.presets,
                onChanged: function () { void store.refresh() },
                onClose: function () { setAdding(false) },
              })
              : null,

            state.error
              ? h('p', { key: 'error', style: { margin: 0, fontSize: '12px', color: C.error } },
                state.error + (state.data ? ' · ' + t('stale') : ''))
              : null,

            data && data.enabled === false
              ? h('p', { key: 'off', style: { margin: 0, fontSize: '12px', color: C.minor } }, t('disabled'))
              : null,

            data && data.enabled !== false && cards.length === 0
              ? h('p', { key: 'empty', style: { margin: 0, fontSize: '12px', color: C.minor } }, t('empty'))
              : null,

            h('div', { key: 'cards', style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
              cards.map(function (card) {
                return h(Card, {
                  key: card.id,
                  t: t,
                  card: card,
                  busy: working === card.id,
                  draft: drafts[card.id] || '',
                  onDraft: function (value) { setDraft(card.id, value) },
                  onSave: function () { onSave(card) },
                  onClear: function () { onClear(card) },
                  onTest: function () { onTest(card) },
                  onSignIn: function () { onSignIn(card) },
                  onSignOut: function () { onSignOut(card) },
                  onCancelLogin: function () { onCancelLogin(card) },
                  onRemove: function () { onRemove(card) },
                  login: logins[card.id] || card.login,
                  notice: notices[card.id],
                })
              })),
          ]
          : null,

        tab === 'usage' ? h(UsageSection, { t: t, usage: data && data.usage }) : null,

        tab === 'predict'
          ? h(PredictSettings, { t: t, predict: data && data.predict, defaultPrompt: data && data.defaultPrompt })
          : null,
      )
    }

    // —— 分栏：额度 / 用量 / 输入预测 ——
    function Tabs(props) {
      return h('div', {
        style: {
          display: 'inline-flex', gap: '2px', padding: '3px', borderRadius: '10px',
          background: C.surface2, border: '1px solid ' + C.border, alignSelf: 'flex-start',
        },
      },
      props.items.map(function (item) {
        var active = props.tab === item.id
        return h('button', {
          key: item.id,
          type: 'button',
          onClick: function () { props.onTab(item.id) },
          style: {
            border: 'none', borderRadius: '7px', padding: '5px 14px', fontSize: '12px',
            cursor: 'pointer', fontFamily: 'inherit', fontWeight: active ? '600' : '400',
            background: active ? C.surface : 'transparent',
            color: active ? C.text : C.minor,
            boxShadow: active ? '0 1px 2px rgba(0,0,0,.08)' : 'none',
          },
        }, item.label)
      }))
    }

    // —— 输入预测的设置 ——
    function PredictSettings(props) {
      var t = props.t
      var predict = props.predict || {}
      var editState = React.useState({
        enabled: predict.enabled === true,
        provider: predict.provider || '',
        model: predict.model || '',
        systemPrompt: predict.systemPrompt || '',
      })
      var edit = editState[0]
      var setEdit = editState[1]
      var groupsState = React.useState([])
      var groups = groupsState[0]
      var setGroups = groupsState[1]
      var busyState = React.useState('')
      var busy = busyState[0]
      var setBusy = busyState[1]

      React.useEffect(function () {
        setEdit({
          enabled: predict.enabled === true,
          provider: predict.provider || '',
          model: predict.model || '',
          systemPrompt: predict.systemPrompt || '',
        })
      }, [predict.enabled, predict.provider, predict.model, predict.systemPrompt])

      React.useEffect(function () {
        if (!edit.enabled || groups.length > 0) return undefined
        var abort = new AbortController()
        fetch(new URL(ROUTES.models.replace(/^\//, ''), document.baseURI), {
          credentials: 'same-origin',
          signal: abort.signal,
          headers: { accept: 'application/json' },
        })
          .then(function (response) { return response.json().catch(function () { return {} }) })
          .then(function (body) { if (body && Array.isArray(body.groups)) setGroups(body.groups) })
          .catch(function () {})
        return function () { abort.abort() }
      }, [edit.enabled, groups.length])

      function save(patch) {
        setBusy('save')
        var body = patch || {
          enabled: edit.enabled,
          provider: edit.provider,
          model: edit.model,
          systemPrompt: edit.systemPrompt,
        }
        fetch(new URL(ROUTES.predict.replace(/^\//, ''), document.baseURI), {
          method: 'POST',
          credentials: 'same-origin',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
          .then(function (response) { return response.json().catch(function () { return {} }) })
          .then(function () { void store.refresh() })
          .catch(function () {})
          .finally(function () { setBusy('') })
      }

      var options = [{ value: '', label: t('predictSession') }]
      for (var g = 0; g < groups.length; g += 1) {
        for (var m = 0; m < groups[g].models.length; m += 1) {
          var model = groups[g].models[m]
          options.push({ value: groups[g].provider + '|' + model.id, label: groups[g].name + ' · ' + model.name })
        }
      }
      var selected = edit.provider && edit.model ? edit.provider + '|' + edit.model : ''
      var inputStyle = {
        height: '30px', borderRadius: '6px', border: '1px solid ' + C.border,
        background: C.surface, color: C.text, fontSize: '12px', padding: '0 6px',
      }

      return h('div', { style: { borderTop: '1px solid ' + C.border, paddingTop: '12px', display: 'flex', flexDirection: 'column', gap: '8px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          h('strong', { style: { fontSize: '13px', fontWeight: '600', color: C.text, letterSpacing: '-.01em' } }, t('predictTitle')),
          h('span', { style: { flex: '1' } }),
          h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: C.text } },
            h('input', {
              type: 'checkbox',
              checked: edit.enabled,
              onChange: function (event) {
                var enabled = Boolean(event.target && event.target.checked)
                setEdit(Object.assign({}, edit, { enabled: enabled }))
                save({ enabled: enabled })
              },
            }),
            t('predictEnable'))),

        h('p', { style: { margin: 0, fontSize: '11px', lineHeight: '17px', color: C.minor } }, t('predictHint')),

        edit.enabled
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
            h('label', { style: { fontSize: '11px', color: C.minor } }, t('predictModel')),
            h('select', {
              value: selected,
              style: inputStyle,
              onChange: function (event) {
                var parts = String(event.target.value).split('|')
                var patch = { provider: parts[0] || '', model: parts[1] || '' }
                setEdit(Object.assign({}, edit, patch))
                save(patch)
              },
            }, options.map(function (option) {
              return h('option', { key: option.value, value: option.value }, option.label)
            })),
            h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px' } },
              h('label', { style: { fontSize: '11px', color: C.minor } }, t('predictPrompt')),
              h('span', { style: { flex: '1' } }),
              h('button', {
                type: 'button',
                style: buttonQuiet,
                onClick: function () {
                  setEdit(Object.assign({}, edit, { systemPrompt: '' }))
                  save({ systemPrompt: '' })
                },
              }, t('promptReset'))),
            h('div', { style: { fontSize: '11px', color: C.minor } }, t('promptDefaultHint')),
            h('textarea', {
              // 空字符串表示「用内置的」：这里直接把内置那份显示出来，省得看不见。
              value: edit.systemPrompt === '' ? (props.defaultPrompt || '') : edit.systemPrompt,
              rows: 5,
              onChange: function (event) {
                setEdit(Object.assign({}, edit, { systemPrompt: String(event.target && event.target.value) }))
              },
              style: {
                width: '100%', boxSizing: 'border-box', borderRadius: '6px', border: '1px solid ' + C.border,
                background: C.surface, color: C.text, fontSize: '12px', lineHeight: '18px', padding: '6px 8px',
                resize: 'vertical', fontFamily: 'inherit',
              },
            }),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
              h('button', {
                type: 'button',
                style: Object.assign({}, button, busy ? disabledStyle : {}),
                disabled: Boolean(busy),
                onClick: function () { save() },
              }, busy ? t('predictSaved') : t('predictSave')),
              h('span', { style: { fontSize: '11px', color: C.minor } }, t('predictFee'))))
          : null)
    }

    // —— 注册 ——
    var inject = ['slots', 'locale']

    function apply(ctx) {
      var t = ctx.locale.bind(LOCALE_NS)
      ctx.effect(function () { return ctx.locale.register(LOCALE_NS, { zh: zh, en: en }) })

      var ChipEntry = function (props) {
        return h(QuotaChip, Object.assign({}, props, { t: t }))
      }
      var PageEntry = function (props) {
        return h(QuotaPage, Object.assign({}, props, { t: t }))
      }
      var StripEntry = function (props) {
        return h(QuotaStrip, Object.assign({}, props, { t: t }))
      }
      var GhostEntry = function (props) {
        return h(PromptGhost, Object.assign({}, props, { t: t }))
      }

      ctx.effect(function () {
        return ctx.slots.inject('conversation.input.right', function () {
          return ctx.slots.register(
            { name: 'conversation.input.right', id: 'quota-chip', order: 40, label: function () { return t('chipLabel') } },
            ChipEntry,
          )
        })
      })

      ctx.effect(function () {
        return ctx.slots.inject('conversation.composer.dock', function () {
          return ctx.slots.register(
            { name: 'conversation.composer.dock', id: 'quota-strip', order: 60, label: function () { return t('stripTitle') } },
            StripEntry,
          )
        })
      })

      ctx.effect(function () {
        return ctx.slots.inject('conversation.input.overlay', function () {
          return ctx.slots.register(
            { name: 'conversation.input.overlay', id: 'quota-ghost', order: 40 },
            GhostEntry,
          )
        })
      })

      ctx.effect(function () {
        return ctx.slots.inject('settings.section', function () {
          return ctx.slots.register(
            { name: 'settings.section', id: 'quota', order: 26, label: function () { return t('title') } },
            PageEntry,
          )
        })
      })
    }

    module.exports = { apply: apply, inject: inject }
    return module.exports
  },
})
