/**
 * dsh-gotify-notify —— 浏览器半（已构建产物，供 DSH 的模块表直接挂载）。
 *
 * 在插件管理页里为 `dsh-gotify-notify#gotify-notify` 这一行注册一张配置卡：
 * 表单字段来自宿主半 `Config` 中所有 `.volatile()` 字段，写入经
 * `ctx.configForms.get(ns)` → `scope.mutate(ops, revision)` 落到当前 profile 的
 * `cordis.patch.yml`。表单按官方的「暂存草稿 + 保存」模型实现
 * （`SettingsFormModel`）。
 *
 * **口令不进配置文件**：它是表单里唯一的凭据控件，写入经
 * `ctx.remote.credentials.set(ref, value)` 落到 DSH 的凭据库，配置里只留引用名
 * （`passwordEnv`）；是否已配置由 `describe()` 回读判定，值永不回传。这与官方
 * 「网页搜索」设置页（`@deepseek-ai/dsh-client-ui-settings-web-search`）处理 API Key
 * 的方式一致，也是模型设置页写 API Key 用的同一条路径。
 *
 * 另外提供一个「发送测试通知」按钮，走宿主注册的同源 HTTP 路由
 * `/gotify-notify/test`。
 */
window.__ModuleLoader__.load({
  id: 'dsh-gotify-notify',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const P = require('@deepseek-ai/dsh-client-ui-primitives')

    /** 本页字典命名空间。 */
    const NS = 'settings.gotifyNotify'

    /** 缺失字段文案。 */
    const MISSING = '（未配置）'

    /** 本包名：既是 Loader 模块 id，也是 `plugins.row.config` 键的前半段。 */
    const PKG = 'dsh-gotify-notify'

    /** 该行配置表单最可能被登记的命名空间，按可能性排序。 */
    const CANDIDATE_NAMESPACES = ['gotify-notify', 'dsh-gotify-notify']

    /** 宿主半注册的测试通知路由。 */
    const TEST_ROUTE = '/gotify-notify/test'

    /**
     * 触发原因全集与标签，必须与宿主半的 `REASON_KINDS` / `REASON_LABELS` 一致。
     * 顺序即面板上的展示顺序。
     */
    const REASONS = [
      { kind: 'completed', label: '成功' },
      { kind: 'error', label: '失败' },
      { kind: 'blocked', label: '被阻断' },
      { kind: 'aborted', label: '已中止' },
      { kind: 'interrupted', label: '已中断' },
      { kind: 'max-tokens', label: '超出长度上限' },
      { kind: 'forked', label: '分支继承' },
    ]

    /** `notifyReasons` 缺省时的默认勾选集合：除 `forked` 外全选（与宿主半一致）。 */
    const DEFAULT_NOTIFY_REASONS = REASONS.map((row) => row.kind).filter((kind) => kind !== 'forked')

    /** 口令凭据的默认引用名；必须与宿主半的 `DEFAULT_PASSWORD_REF` 一致。 */
    const DEFAULT_PASSWORD_REF = 'GOTIFY_PASSWORD'

    /**
     * 凭据引用名的文法，与宿主半的 `REF_PATTERN` 一致。
     * 宿主凭据域的 `describe` 对文法外的名字会**整批**拒绝，所以这里必须先过一遍。
     */
    const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

    /**
     * 引用名是否可用。
     * @param value - 待判定的名字。
     * @returns 是否合法。
     */
    function isRefName(value) {
      return typeof value === 'string' && REF_PATTERN.test(value)
    }

    const zh = {
      title: 'Gotify 通知',
      description: 'DSH 会话轮次结束时，向 Gotify 服务器推送一条通知。',
      url: 'Gotify 服务器地址',
      urlHint: '例如 https://gotify.example.com；末尾斜杠会被忽略。',
      user: '用户名',
      userHint: '留空则读取启动环境变量 GOTIFY_USER。',
      password: '口令',
      passwordHint: '值直接存入 DSH 凭据库，不写进配置文件；不回显，留空表示保持现状。',
      passwordSet: '凭据库中已配置',
      passwordUnset: '凭据库中未配置',
      passwordUnwritable: '该引用由启动环境提供，凭据库无法覆盖。',
      passwordEnv: '口令的凭据引用名',
      passwordEnvHint: '口令在凭据库中的名字（同时是环境变量名），默认 GOTIFY_PASSWORD。',
      titleCompleted: '成功时的标题',
      titleCompletedHint: '占位符：{reason}（中文，如「成功」）、{reasonRaw}（原始标识，如 completed）、{error}（失败原因，仅出错时有内容）、{title}、{turn}、{id}、{cwd}、{time}。',
      titleOther: '其他结果的标题',
      titleOtherHint: '未完成/失败时使用；占位符同上。',
      message: '正文模板',
      messageHint: '占位符同标题。表单是单行输入：写 \\n（反斜杠加 n）表示换行。',
      notifyReasons: '触发通知的结束原因',
      notifyReasonsHint: '勾选哪些轮次结果才推送；一个都不勾等于关闭通知。',
      priorityCompleted: '成功时的优先级',
      priorityError: '非成功时的优先级',
      priorityHint: '0–10 的整数，越大越显眼。',
      minTurn: '最低轮次门槛',
      minTurnHint: '轮次低于该值不推送（0 = 每轮都推）；快速小问答不打扰。',
      invalidMinTurn: '请填 0 或正整数。',
      includeSubagents: '子 Agent 轮次也通知',
      edit: '编辑',
      overridden: '已覆盖',
      reset: '恢复默认',
      invalidNumber: '请填 0–10 的整数。',
      unavailable: '该插件当前未加载，暂时无法配置。',
      readOnly: '本部署的设置为只读。',
      save: '保存',
      saving: '保存中…',
      saveFailed: '本部署没有接受这些值，已保留供你修改。',
      saveNow: '有未保存的修改，点此保存。',
      test: '发送测试通知',
      testing: '发送中…',
      testOk: '已发送测试通知。',
      testFailed: '测试失败：',
      testNoUrl: '请先填写 Gotify 服务器地址。',
    }

    /**
     * 读取配置表单的当前值（值层已含 bundle patch 与用户覆盖）。
     * @param scope - 配置表单。
     * @param field - 字段名。
     * @returns 当前值，未配置时为 undefined。
     */
    function readValue(scope, field) {
      const snapshot = scope.getSnapshot()
      return snapshot?.value?.[field]
    }

    /**
     * 带范围的数值字段：空草稿清空字段，越界或非数字的草稿阻止保存。
     * （官方的 `settingsNumberField` 不认范围，宿主会拒绝越界值。）
     * @param field - 命名空间内的字段名。
     * @param min - 允许的最小值（含）。
     * @param max - 允许的最大值（含）。
     * @returns 字段的转换规格。
     */
    function boundedNumberField(field, min, max) {
      return {
        field,
        format: value => (typeof value === 'number' ? String(value) : ''),
        parse: text => {
          const trimmed = text.trim()
          if (trimmed === '') return { kind: 'clear' }
          const parsed = Number(trimmed)
          if (!Number.isFinite(parsed)) return undefined
          if (!Number.isInteger(parsed) || parsed < min || parsed > max) return undefined
          return { kind: 'set', value: parsed }
        },
      }
    }

    /**
     * 选择真正被宿主服务的那一个命名空间。
     *
     * 设置页的命名空间 = profile 条目 id（本包的行 id 是 `gotify-notify`），
     * 但不同 DSH 版本推导出的条目 id 可能不同，因此按候选顺序探测：
     * 先看 describe 镜像里出现了谁，再退回到「能取到表单」的第一个候选。
     * @param ctx - 浏览器插件上下文。
     * @returns 命名空间与它的表单。
     */
    function resolveNamespace(ctx) {
      let served = []
      try {
        served = ctx.configForms.describe().getSnapshot()?.view?.namespaces?.map(row => row.ns) ?? []
      } catch {
        served = []
      }
      const ordered = [
        ...CANDIDATE_NAMESPACES.filter(id => served.includes(id)),
        ...CANDIDATE_NAMESPACES,
      ]
      for (const id of ordered) {
        try {
          const scope = ctx.configForms.get(id)
          if (scope?.getSnapshot !== undefined) return { id, scope }
        } catch {
          // 该候选没有被宿主服务，试下一个。
        }
      }
      return { id: CANDIDATE_NAMESPACES[0], scope: ctx.configForms.get(CANDIDATE_NAMESPACES[0]) }
    }

    /**
     * 一张配置卡的控制器：暂存编辑、保存、以及开关的立即写入。
     * @param owner - 浏览器插件上下文（用于读写 DSH 凭据域）。
     * @param namespace - 该卡绑定的设置命名空间。
     * @param scope - 该命名空间的配置表单。
     */
    class CardController {
      /** 原因勾选的写回链：串行化读-改-写，避免连点丢更新。 */
      #toggleChain = Promise.resolve(false)

      constructor(owner, namespace, scope) {
        this.owner = owner
        this.namespace = namespace
        this.scope = scope
        /** 本页正在看的凭据引用，以及宿主对它报出的状态。 */
        this.credential = { ref: DEFAULT_PASSWORD_REF, configured: false, writable: true }
        const fields = [
          P.settingsTextField('url'),
          P.settingsTextField('user'),
          P.settingsTextField('passwordEnv'),
          P.settingsTextField('titleCompleted'),
          P.settingsTextField('titleOther'),
          P.settingsTextField('message'),
          boundedNumberField('priorityCompleted', 0, 10),
          boundedNumberField('priorityError', 0, 10),
          boundedNumberField('minTurn', 0, Number.MAX_SAFE_INTEGER),
        ]
        this.form = new P.SettingsFormModel(
          {
            getSnapshot: () => scope.getSnapshot(),
            subscribe: (listener) => scope.subscribe(listener),
            mutate: async (ops, revision) => {
              const landed = await scope.mutate(ops, revision)
              if (landed) this.publish()
              return landed
            },
          },
          fields,
          [{ field: 'password', write: (text) => this.#writeSecret(text) }],
        )
        this.store = this.form.bind(() => this.projection())
        // 引用名本身是配置字段，改它就要重新问一次凭据域。
        this.unsubscribeScope = scope.subscribe(() => {
          void this.#readCredential()
        })
        void this.#readCredential()
      }

      /** 表单外壳 + 每个控件的草稿状态 + 两个开关的当前值 + 凭据状态。 */
      projection() {
        return {
          ...this.form.shell(),
          url: this.form.field('url'),
          user: this.form.field('user'),
          passwordEnv: this.form.field('passwordEnv'),
          password: this.form.field('password'),
          titleCompleted: this.form.field('titleCompleted'),
          titleOther: this.form.field('titleOther'),
          message: this.form.field('message'),
          priorityCompleted: this.form.field('priorityCompleted'),
          priorityError: this.form.field('priorityError'),
          minTurn: this.form.field('minTurn'),
          notifyReasons: this.#reasons(),
          includeSubagents: this.#flag('includeSubagents'),
          passwordConfigured: this.credential.configured,
          passwordWritable: this.credential.writable,
          passwordRef: this.credential.ref,
        }
      }

      /**
       * 写口令：**不写配置文件**，直接进 DSH 凭据库。
       *
       * 与官方网页搜索设置页同一路径 —— `remote.credentials.set(ref, value)`
       * 没有返回值，成功与否由随后的 `describe()` 回读判定。空值不写：宿主那边
       * `value` 有 `min(1)` 约束，清空凭据要用 `unset`，不该由「留空保存」触发。
       * @param text - 草稿里的口令。
       * @returns 宿主是否确认该引用已配置。
       */
      async #writeSecret(text) {
        const ref = this.credential.ref
        const value = String(text).trim()
        if (value === '' || !isRefName(ref)) return false
        try {
          await this.owner.remote.credentials.set(ref, value)
        } catch {
          return false
        }
        await this.#readCredential()
        return this.credential.configured
      }

      /**
       * 问凭据域：`passwordEnv` 当前指向的引用是否已配置。
       *
       * 应答与它所描述的引用一起保存 —— `passwordEnv` 可能在请求与应答之间被
       * 改动，两次读取也可能乱序返回，所以只有仍然对应当前引用时才发布。
       */
      async #readCredential() {
        const ref = this.#refFromScope()
        if (ref !== this.credential.ref) {
          this.credential = { ref, configured: false, writable: true }
          this.publish()
        }
        let response
        try {
          response = await this.owner.remote.credentials.describe([ref])
        } catch {
          return
        }
        if (response?.ok !== true || ref !== this.#refFromScope()) return
        const view = response.value?.[ref]
        const next = {
          ref,
          configured: view?.configured === true,
          writable: view?.writable !== false,
        }
        if (next.configured === this.credential.configured && next.writable === this.credential.writable) return
        this.credential = next
        this.publish()
      }

      /**
       * 宿主报告本页所看的引用发生了变化（同一个名字也可能在模型页被写），重读。
       * @param ref - 宿主报告的引用名。
       */
      refreshCredential(ref) {
        if (ref !== this.credential.ref) return
        void this.#readCredential()
      }

      /** `passwordEnv` 当前声明的引用名；留空或不合文法时用默认值。 */
      #refFromScope() {
        const declared = readValue(this.scope, 'passwordEnv')
        return isRefName(declared) ? declared : DEFAULT_PASSWORD_REF
      }

      /** 读取一个布尔开关。 */
      #flag(field) {
        return readValue(this.scope, field) === true
      }

      /** 读 `notifyReasons` 当前集合：非数组（含缺省）回落默认全集，过滤无效项。 */
      #reasonList() {
        const raw = readValue(this.scope, 'notifyReasons')
        if (!Array.isArray(raw)) return DEFAULT_NOTIFY_REASONS.slice()
        return raw.filter(kind => typeof kind === 'string' && kind !== '')
      }

      /** 勾选态投影：全集 × 当前集合（未知取值没有复选框，但会保留在配置里）。 */
      #reasons() {
        const selected = new Set(this.#reasonList())
        return REASONS.map(({ kind, label }) => ({ kind, label, checked: selected.has(kind) }))
      }

      /**
       * 勾/取消一个触发原因：整组写回 `notifyReasons`。
       *
       * 已知项按全集顺序输出；配置里手工写入的**未知取值**（DSH 后端未来新增的
       * 原因）追加在尾部原样保留 —— 宿主半承诺「勾了就能推」，面板不能替用户
       * 悄悄删掉它们。写回串行化成一条链，快速连点不会读旧快照互相覆盖；mutate
       * 带上 revision，与表单保存走同一套乐观并发控制。
       * @param kind - 原因标识。
       * @param checked - 是否勾选。
       */
      toggleReason(kind, checked) {
        this.#toggleChain = this.#toggleChain.then(async () => {
          if (this.scope.getSnapshot()?.writable !== true) return false
          const raw = this.#reasonList()
          const known = new Set(REASONS.map(row => row.kind))
          const current = new Set(raw)
          if (checked) current.add(kind)
          else current.delete(kind)
          const next = [
            ...REASONS.map(row => row.kind).filter(k => current.has(k)),
            ...raw.filter(k => !known.has(k) && k !== kind),
          ]
          const landed = await this.scope.mutate(
            [{ op: 'set', path: ['notifyReasons'], value: next }],
            this.scope.getSnapshot()?.revision,
          )
          if (landed) this.publish()
          return landed
        })
        return this.#toggleChain
      }

      /** 立即写入一个布尔开关。 */
      async setFlag(field, value) {
        if (this.scope.getSnapshot()?.writable !== true) return false
        const landed = await this.scope.mutate([{ op: 'set', path: [field], value }])
        if (landed) this.publish()
        return landed
      }

      /** 重画（开关或密码状态变化后调用）。 */
      publish() {
        this.store.set(this.projection())
      }

      /** 该注入给卡片的内容。 */
      inject() {
        return {
          hooks: { gotifyNotifyCard: this.store },
          ...this.form.actions(),
          setFlag: (field, value) => Promise.resolve(this.setFlag(field, value)),
          toggleReason: (kind, checked) => Promise.resolve(this.toggleReason(kind, checked)),
        }
      }

      /** 释放订阅。 */
      dispose() {
        this.unsubscribeScope?.()
        this.form.dispose()
      }
    }

    /**
     * 「发送测试通知」按钮：调用宿主注册的同源路由。
     * @param props - 卡片注入面（用 `state.url.text` 判断 url 是否已配置）。
     */
    function TestNotification(props) {
      const { t, state } = props
      const [local, setLocal] = React.useState({ phase: 'idle', detail: '' })

      const run = async () => {
        if (String(state.url.text).trim() === '') {
          setLocal({ phase: 'failed', detail: t('testNoUrl') })
          return
        }
        setLocal({ phase: 'running', detail: '' })
        try {
          const response = await fetch(TEST_ROUTE, {
            method: 'POST',
            headers: { accept: 'application/json' },
          })
          const body = await response.json().catch(() => undefined)
          if (body?.ok === true) {
            setLocal({ phase: 'done', detail: t('testOk') })
            return
          }
          setLocal({ phase: 'failed', detail: String(body?.error ?? `HTTP ${response.status}`) })
        } catch (error) {
          setLocal({ phase: 'failed', detail: error instanceof Error ? error.message : String(error) })
        }
      }

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 } },
        h(
          P.Button,
          {
            type: 'button',
            variant: 'outline',
            size: 'md',
            disabled: local.phase === 'running',
            onClick: () => void run(),
          },
          local.phase === 'running' ? t('testing') : t('test'),
        ),
        local.detail === ''
          ? null
          : h(
            'p',
            {
              role: 'status',
              style: {
                margin: 0,
                fontSize: 12,
                lineHeight: '18px',
                color: local.phase === 'failed' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-secondary)',
              },
            },
            local.phase === 'failed' ? `${t('testFailed')}${local.detail}` : local.detail,
          ),
      )
    }

    /**
     * 配置卡本体：插件管理页在 `summary` 视图要一行说明，在 `page` 视图要表单。
     * @param props - 槽位注入的快照、动作、文案。
     */
    function GotifyNotifyCard(props) {
      const { t } = props
      const state = props.useGotifyNotifyCard(snapshot => snapshot)
      if (props.view === 'summary') return t('description')
      const disabled = !state.writable
      const common = {
        overriddenLabel: t('overridden'),
        resetLabel: t('reset'),
        invalidLabel: t('invalidNumber'),
        disabled,
      }
      const valueField = (id, field, label, hint, extra) => h(P.SettingsValueField, {
        id: `plugin-config-gotify-${id}`,
        label,
        hint,
        ...common,
        ...extra,
        ...state[field],
        text: state[field].text,
        onEdit: text => props.edit(field, text),
        onReset: () => props.resetField(field),
      })
      const checkbox = (id, field, label) => h(P.Checkbox, {
        key: id,
        checked: state[field] === true,
        disabled,
        label,
        onChange: next => void props.setFlag(field, next === true),
      })
      return h(
        P.SettingsForm,
        {
          labels: {
            unavailable: t('unavailable'),
            readOnly: t('readOnly'),
            save: t('save'),
            saving: t('saving'),
            saveFailed: t('saveFailed'),
          },
          state,
          onSave: props.save,
          onDiscard: props.discard,
        },
        valueField('url', 'url', t('url'), t('urlHint')),
        valueField('user', 'user', t('user'), t('userHint')),
        valueField('password-env', 'passwordEnv', t('passwordEnv'), t('passwordEnvHint')),
        h(P.SettingsSecretField, {
          id: 'plugin-config-gotify-password',
          label: t('password'),
          hint: disabled
            ? t('readOnly')
            : (state.passwordWritable === true ? t('passwordHint') : t('passwordUnwritable')),
          disabled: disabled || state.passwordWritable !== true,
          text: state.password.text,
          configured: state.passwordConfigured === true,
          stateLabel: state.passwordConfigured === true ? t('passwordSet') : t('passwordUnset'),
          onEdit: text => props.edit('password', text),
        }),
        valueField('title-completed', 'titleCompleted', t('titleCompleted'), t('titleCompletedHint')),
        valueField('title-other', 'titleOther', t('titleOther'), t('titleOtherHint')),
        valueField('message', 'message', t('message'), t('messageHint')),
        valueField('priority-completed', 'priorityCompleted', t('priorityCompleted'), t('priorityHint'), { numeric: true }),
        valueField('priority-error', 'priorityError', t('priorityError'), t('priorityHint'), { numeric: true }),
        valueField('min-turn', 'minTurn', t('minTurn'), t('minTurnHint'), { numeric: true, invalidLabel: t('invalidMinTurn') }),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 } },
          h('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-primary)' } }, t('notifyReasons')),
          h(
            'div',
            { style: { display: 'flex', flexWrap: 'wrap', gap: 12 } },
            state.notifyReasons.map(({ kind, label, checked }) => h(P.Checkbox, {
              key: kind,
              checked,
              disabled,
              label: `${label}（${kind}）`,
              onChange: next => void props.toggleReason(kind, next === true),
            })),
          ),
          h('p', { style: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, t('notifyReasonsHint')),
        ),
        checkbox('subagents', 'includeSubagents', t('includeSubagents')),
        h(TestNotification, { t, state }),
      )
    }

    return {
      // `remote.credentials` 是凭据域的浏览器门户，与官方网页搜索设置页一致：
      // 它缺席时整张卡片不挂载，也好过让用户以为写进去的口令真的存下了。
      inject: ['slots', 'locale', 'remote', 'remote.credentials', 'configForms'],

      /**
       * 挂载宿主半在设置页里的配置卡。
       * @param ctx - 浏览器插件上下文。
       */
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { zh }), 'dsh-gotify-notify: 字典')

        const { id, scope } = resolveNamespace(ctx)
        const controller = new CardController(ctx, id, scope)
        ctx.effect(() => () => controller.dispose(), 'dsh-gotify-notify: 表单订阅')
        ctx.effect(
          () => ctx.remote.$on('credentials/reference-updated', ref => controller.refreshCredential(ref)),
          'dsh-gotify-notify: 凭据变更订阅',
        )

        const rowKey = `${PKG}#gotify-notify`
        ctx.effect(
          () => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
            name: 'plugins.row.config',
            key: rowKey,
            locale: NS,
            inject: () => controller.inject(),
          }, GotifyNotifyCard)),
          `dsh-gotify-notify: 配置卡（${id}）`,
        )
      },
    }
  },
})
