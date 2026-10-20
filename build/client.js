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
      win_weekly: '每周',
      win_monthly: '每月',
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
      added: '已添加',
      remove: '移除',
      removeFailed: '移除失败',
      needId: '先填 id',
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
      win_rolling: 'Rolling',
      win_weekly: 'Weekly',
      win_monthly: 'Monthly',
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
      added: 'Added',
      remove: 'Remove',
      removeFailed: 'Removing failed',
      needId: 'Enter an id first',
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
      position: 'relative', flex: '1', height: '6px', borderRadius: '999px',
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

    var button = {
      border: '1px solid ' + C.borderStrong, background: 'transparent', color: C.text,
      borderRadius: '8px', padding: '4px 10px', fontSize: '12px', lineHeight: '18px',
      cursor: 'pointer', whiteSpace: 'nowrap', fontFamily: 'inherit',
    }
    var buttonPrimary = Object.assign({}, button, { borderColor: C.brand, color: C.brand })
    var buttonQuiet = Object.assign({}, button, { borderColor: 'transparent', color: C.minor, padding: '2px 6px' })
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
      if (!data || data.enabled === false) return null
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
        var value = card.error ? '!' : worst ? percentOf(worst.used) + '%' : t('never')
        return h('span', {
          key: card.id,
          title: card.label + (detail ? '\n' + detail : ''),
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
          border: '1px solid ' + C.border, background: C.surface, borderRadius: '12px',
          padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '10px',
        },
      },
      h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' } },
        h('span', { style: { fontSize: '14px', fontWeight: '500', color: C.text } }, card.label),
        h('span', { style: { fontSize: '11px', color: C.minor } }, card.id),
        card.plan
          ? h('span', { style: { fontSize: '11px', color: C.brand, border: '1px solid ' + C.brand, borderRadius: '999px', padding: '0 6px' } }, t('plan') + ' · ' + card.plan)
          : null,
        h('span', { style: { flex: '1' } }),
        term ? h('span', { style: { fontSize: '11px', color: C.minor } }, term) : null,
        h('button', { type: 'button', style: buttonQuiet, title: t('remove'), onClick: props.onRemove }, t('remove'))),

      windows.length > 0
        ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
          windows.map(function (win) {
            var used = percentOf(win.used)
            return h('div', { key: win.key, style: { display: 'flex', alignItems: 'center', gap: '10px' } },
              h('span', { style: { fontSize: '12px', color: C.minor, width: '76px', flex: 'none' } }, windowLabel(t, win.key)),
              h(Bar, { used: used }),
              h('span', { style: { fontSize: '12px', color: C.text, width: '44px', textAlign: 'right', flex: 'none' } }, used + '%'),
              h('span', { style: { fontSize: '11px', color: C.minor, minWidth: '96px', textAlign: 'right', flex: 'none' } },
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

    /** 缓存命中率：缓存读取 /（缓存读取 + 新输入）。 */
    function hitRate(cacheRead, input) {
      var cached = Number(cacheRead) || 0
      var fresh = Number(input) || 0
      var total = cached + fresh
      return total > 0 ? Math.round((cached / total) * 100) : 0
    }

    var tile = { display: 'flex', flexDirection: 'column', gap: '2px', padding: '10px 14px', minWidth: '0' }

    function UsageTile(props) {
      return h('div', {
        style: Object.assign({}, tile, { borderLeft: props.first ? 'none' : '1px solid ' + C.border }),
      },
      h('div', { style: { fontSize: '19px', lineHeight: '24px', color: C.text, fontWeight: '500' } }, props.value),
      h('div', { style: { fontSize: '10px', letterSpacing: '.06em', color: C.minor, textTransform: 'uppercase' } }, props.label),
      props.note ? h('div', { style: { fontSize: '11px', color: C.minor } }, props.note) : null)
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
          h('h3', { style: { margin: 0, fontSize: '13px', fontWeight: '500', color: C.text } }, t('usageTitle')),
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
          note: t('uInput') + ' ' + compact(week.input) + ' · ' + t('uOutput') + ' ' + compact(week.output),
        }),
        h(UsageTile, { value: compact(week.cacheRead), label: t('uCache'), note: t('uHit') + ' ' + hitRate(week.cacheRead, week.input) + '%' }),
        h(UsageTile, { value: compact(week.reasoning), label: t('uReasoning'), note: t('uCountedOut') }),
        h(UsageTile, { value: compact(week.calls), label: t('uCalls'), note: t('uToday') + ' ' + compact(usage.today && usage.today.calls) })),

        peak > 0
          ? h('div', { style: { display: 'flex', alignItems: 'flex-end', gap: '4px', height: '34px', padding: '0 2px' } },
            (usage.days || []).map(function (day) {
              var value = (day.input || 0) + (day.output || 0)
              var height = Math.max(2, Math.round((value / peak) * 34))
              return h('div', {
                key: day.date,
                title: day.date + ' · ' + compact(value) + ' · ' + compact(day.calls),
                style: {
                  flex: '1', height: height + 'px', borderRadius: '2px 2px 0 0',
                  background: value > 0 ? C.brand : C.surface2,
                },
              })
            }))
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
              h('div', { style: { flex: '1', height: '4px', borderRadius: '999px', background: C.surface2, overflow: 'hidden', minWidth: '40px' } },
                h('div', {
                  style: {
                    width: (biggest > 0 ? Math.round((total / biggest) * 100) : 0) + '%',
                    height: '4px', background: C.brand, borderRadius: '999px',
                  },
                })),
              h('span', { style: { fontSize: '11px', color: C.minor, minWidth: '148px', textAlign: 'right', flex: 'none' } },
                compact(line.input) + ' / ' + compact(line.output) + ' · ' + t('uHit') + ' ' + hitRate(line.cacheRead, line.input) + '%'),
              h('span', { style: { fontSize: '12px', color: C.text, width: '52px', textAlign: 'right', flex: 'none' } }, compact(total)))
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
          border: '1px solid ' + C.border, background: C.surface, borderRadius: '12px',
          padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '10px',
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
        }, busy ? t('adding') : t('addSubmit'))),
      error ? h('div', { style: { fontSize: '11px', color: C.error } }, error) : null)
    }

    // —— 设置页 ——
    function QuotaPage(props) {
      var t = props.t
      var state = useQuota()
      var data = state.data
      var cards = data ? data.providers : []
      var busy = state.status === 'refreshing'

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
          h('h2', { style: { margin: 0, fontSize: '16px', fontWeight: '500', color: C.text } }, t('title')),
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

        h('p', { style: { margin: 0, fontSize: '12px', lineHeight: '19px', color: C.minor } }, t('intro')),

        h(UsageSection, { t: t, usage: data && data.usage }),

        state.error
          ? h('p', { style: { margin: 0, fontSize: '12px', color: C.error } },
            state.error + (state.data ? ' · ' + t('stale') : ''))
          : null,

        data && data.enabled === false
          ? h('p', { style: { margin: 0, fontSize: '12px', color: C.minor } }, t('disabled'))
          : null,

        data && data.enabled !== false && cards.length === 0
          ? h('p', { style: { margin: 0, fontSize: '12px', color: C.minor } }, t('empty'))
          : null,

        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
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
              onSignIn: function () { onSignIn(card) },
              onSignOut: function () { onSignOut(card) },
              onCancelLogin: function () { onCancelLogin(card) },
              onRemove: function () { onRemove(card) },
              login: logins[card.id] || card.login,
              notice: notices[card.id],
            })
          })),

        h(AddProvider, {
          t: t,
          presets: data && data.presets,
          onChanged: function () { void store.refresh() },
        }))
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

      ctx.effect(function () {
        return ctx.slots.inject('conversation.input.right', function () {
          return ctx.slots.register(
            { name: 'conversation.input.right', id: 'quota-chip', order: 40, label: function () { return t('chipLabel') } },
            ChipEntry,
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
