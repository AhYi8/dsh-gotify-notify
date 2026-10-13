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

    /** 本包名：既是 Loader 模块 id，也是 `plugins.row.config` 键的前半段。 */
    const PKG = 'dsh-gotify-notify'

    /** 该行配置表单最可能被登记的命名空间，按可能性排序。
     *
     * 不采用官方的 `whileServed()`：它面向「替他人拥有的命名空间注册表单」，而本卡注册
     * 的就是自己的命名空间，`configForms.describe` 探测加 `get()` 自愈已经够用；引入它
     * 只会多一层无法用非交互手段验证的注册语义。
     */
    const CANDIDATE_NAMESPACES = ['gotify-notify', 'dsh-gotify-notify']

    /** 宿主半注册的测试通知路由。 */
    const TEST_ROUTE = '/gotify-notify/test'

    /**
     * 测试通知的兜底超时。宿主路由内部最多串 3 次 Gotify 请求（各自 10 秒超时），
     * 所以 60 秒足以覆盖最坏情况；它的作用只是避免桌面壳不回包时，按钮永久停在
     * 「发送中…」。
     */
    const TEST_NOTIFY_TIMEOUT_MS = 60_000

    /**
     * 触发原因全集，必须与宿主半的 `REASON_KINDS` 一致，顺序即面板上的展示顺序。
     * 标签不进常量表：它随界面语言变化，由字典按 `reasonKey()` 提供（中文标签与
     * 宿主半的 `REASON_LABELS` 一致）。
     */
    const REASONS = ['completed', 'error', 'blocked', 'aborted', 'interrupted', 'max-tokens', 'forked']

    /** `notifyReasons` 缺省时的默认勾选集合：除 `forked` 外全选（与宿主半一致）。 */
    const DEFAULT_NOTIFY_REASONS = REASONS.filter((kind) => kind !== 'forked')

    /**
     * 原因标识对应的字典键：`completed` → `reasonCompleted`，`max-tokens` → `reasonMaxTokens`。
     * 后端将来新增的原因没有字典条目时，`t()` 会原样显示键名，不会编造标签。
     * @param kind - 原因标识。
     * @returns 字典键。
     */
    function reasonKey(kind) {
      return `reason${kind.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join('')}`
    }

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
      // 官方四张卡片字典都定义 `title`，官方外壳经注册项的 `label: () => t('title')` 读它；
      // 本卡只注册 `plugins.row.config`（行页标题来自包元信息 locale/*.json），当前没有读取点，
      // 但它是官方约定键，保留以免将来补 `plugins.item` 注册时界面直接画出键名。
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
      notifyQuestion: '需要用户决定时也通知',
      notifyQuestionHint: '模型弹出选择框/输入框等你做决定时也推送（独立于轮次结束通知，默认关）。',
      titleQuestion: '等待决定时的标题',
      titleQuestionHint: '弹出选择框/输入框时使用；占位符同上，{reason} 渲染为「等待用户输入」。',
      questionMessage: '等待决定时的正文',
      questionMessageHint: '占位符同标题。表单是单行输入：写 \\n（反斜杠加 n）表示换行。',
      priorityQuestion: '等待决定时的优先级',
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
      overridden: '已覆盖',
      reset: '恢复默认',
      invalidNumber: '请填 0–10 的整数。',
      unavailable: '该插件当前未加载，暂时无法配置。',
      readOnly: '本部署的设置为只读。',
      save: '保存',
      saving: '保存中…',
      saveFailed: '本部署没有接受这些值，已保留供你修改。',
      test: '发送测试通知',
      testing: '发送中…',
      testOk: '已发送测试通知。',
      testFailed: '测试失败：',
      testNoUrl: '请先填写 Gotify 服务器地址。',
      testUnsaved: '请先保存修改：测试通知用的是已保存的配置。',
      testTimeout: '等待服务器响应超时，请检查 Gotify 服务器是否可达。',
      reasonCompleted: '成功',
      reasonError: '失败',
      reasonBlocked: '被阻断',
      reasonAborted: '已中止',
      reasonInterrupted: '已中断',
      reasonMaxTokens: '超出长度上限',
      reasonForked: '分支继承',
    }

    /**
     * 英文界面用的同名词典。
     *
     * 必须与 `zh` 键集完全一致 —— 本插件在英文界面上没有其它回落来源：
     * `locale.register` 只登记本命名空间，缺键时 `t()` 会把键名原样画到界面上。
     */
    const en = {
      title: 'Gotify notifications',
      description: 'Pushes a notification to your Gotify server when a DSH session turn ends.',
      url: 'Gotify server URL',
      urlHint: 'For example https://gotify.example.com; a trailing slash is ignored.',
      user: 'User name',
      userHint: 'Leave empty to read the GOTIFY_USER environment variable at startup.',
      password: 'Password',
      passwordHint: 'Stored in the DSH credential store, never in the config file; not echoed back, and an empty value keeps the current one.',
      passwordSet: 'Configured in the credential store',
      passwordUnset: 'Not configured in the credential store',
      passwordUnwritable: 'This reference comes from the startup environment and cannot be overwritten.',
      passwordEnv: 'Credential reference for the password',
      passwordEnvHint: 'Name of the password in the credential store (also the environment variable name); defaults to GOTIFY_PASSWORD.',
      titleCompleted: 'Title on success',
      titleCompletedHint: 'Placeholders: {reason} (localized label), {reasonRaw} (raw id such as completed), {error} (failure reason, only when there is one), {title}, {turn}, {id}, {cwd}, {time}.',
      titleOther: 'Title on other outcomes',
      titleOtherHint: 'Used when the turn did not complete successfully; same placeholders as above.',
      notifyQuestion: 'Notify when the model needs your decision',
      notifyQuestionHint: 'Also push when the model opens a choice or input box and waits for you (independent of turn-end notifications; off by default).',
      titleQuestion: 'Title when waiting for your decision',
      titleQuestionHint: 'Used for the choice or input box; same placeholders, with {reason} rendered as the waiting-for-input label.',
      questionMessage: 'Body when waiting for your decision',
      questionMessageHint: 'Same placeholders as the title. The input is a single line: write \\n (backslash + n) for a newline.',
      priorityQuestion: 'Priority when waiting for your decision',
      message: 'Body template',
      messageHint: 'Same placeholders as the title. The input is a single line: write \\n (backslash + n) for a newline.',
      notifyReasons: 'Turn outcomes that trigger a notification',
      notifyReasonsHint: 'Only the checked outcomes are pushed; checking none turns notifications off.',
      priorityCompleted: 'Priority on success',
      priorityError: 'Priority on other outcomes',
      priorityHint: 'An integer from 0 to 10; higher is more prominent.',
      minTurn: 'Minimum turn',
      minTurnHint: 'Turns below this value are not pushed (0 = every turn); keeps quick questions quiet.',
      invalidMinTurn: 'Enter 0 or a positive integer.',
      includeSubagents: 'Notify for subagent turns too',
      overridden: 'Overridden',
      reset: 'Reset',
      invalidNumber: 'Enter an integer from 0 to 10.',
      unavailable: 'This plugin is not loaded right now, so it cannot be configured.',
      readOnly: 'Settings are read-only in this deployment.',
      save: 'Save',
      saving: 'Saving…',
      saveFailed: 'This deployment did not accept these values; they are kept for you to fix.',
      test: 'Send a test notification',
      testing: 'Sending…',
      testOk: 'Test notification sent.',
      testFailed: 'Test failed: ',
      testNoUrl: 'Fill in the Gotify server URL first.',
      testUnsaved: 'Save your changes first: the test uses the saved configuration.',
      testTimeout: 'Timed out waiting for the server. Check that the Gotify server is reachable.',
      reasonCompleted: 'Success',
      reasonError: 'Failed',
      reasonBlocked: 'Blocked',
      reasonAborted: 'Aborted',
      reasonInterrupted: 'Interrupted',
      reasonMaxTokens: 'Over token limit',
      reasonForked: 'Forked',
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
     * @returns 命名空间与它的表单；一个候选都取不到表单时 `scope` 为 undefined。
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
      // 兜底探测同样要容错：`get` 抛错时若让它冒出去，插槽回调会整体中断，
      // 用户看到的是「卡片凭空消失」。交给调用方按下线处理。
      try {
        return { id: CANDIDATE_NAMESPACES[0], scope: ctx.configForms.get(CANDIDATE_NAMESPACES[0]) }
      } catch {
        return { id: CANDIDATE_NAMESPACES[0], scope: undefined }
      }
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
          P.settingsTextField('titleQuestion'),
          P.settingsTextField('questionMessage'),
          boundedNumberField('priorityCompleted', 0, 10),
          boundedNumberField('priorityError', 0, 10),
          boundedNumberField('priorityQuestion', 0, 10),
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
          titleQuestion: this.form.field('titleQuestion'),
          message: this.form.field('message'),
          questionMessage: this.form.field('questionMessage'),
          priorityCompleted: this.form.field('priorityCompleted'),
          priorityError: this.form.field('priorityError'),
          priorityQuestion: this.form.field('priorityQuestion'),
          minTurn: this.form.field('minTurn'),
          notifyReasons: this.#reasons(),
          notifyQuestion: this.#flag('notifyQuestion'),
          includeSubagents: this.#flag('includeSubagents'),
          passwordConfigured: this.credential.configured,
          passwordWritable: this.credential.writable,
          passwordRef: this.credential.ref,
          // 「发送测试通知」打到的是**已保存**的配置（宿主路由读配置读值），
          // 所以按钮要拿保存值判断前置条件，不能拿草稿判断。
          urlSaved: typeof readValue(this.scope, 'url') === 'string' ? readValue(this.scope, 'url') : '',
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
        // 现读引用名，不信缓存的投影：同一次保存里 `passwordEnv` 可能刚被改过
        // （官方 `SettingsFormModel.save()` 先写配置操作、再跑 secret 的 run），
        // 口令必须落到改完之后的名字下。
        const ref = this.#refFromScope()
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
        return REASONS.map(kind => ({ kind, checked: selected.has(kind) }))
      }

      /**
       * 勾/取消一个触发原因：整组写回 `notifyReasons`。
       *
       * 已知项按全集顺序输出；配置里手工写入的**未知取值**（DSH 后端未来新增的
       * 原因）追加在尾部原样保留 —— 宿主半承诺「勾了就能推」，面板不能替用户
       * 悄悄删掉它们。写回串行化成一条链，快速连点不会读旧快照互相覆盖。
       * @param kind - 原因标识。
       * @param checked - 是否勾选。
       */
      toggleReason(kind, checked) {
        // 链一旦变成 rejected，之后每次 `.then()` 都会直接跳过回调，勾选功能会
        // 永久失效；`#write` 自己吞掉写入异常，这里再兜一层，保证链始终可续。
        this.#toggleChain = this.#toggleChain
          .then(async () => {
            const raw = this.#reasonList()
            const known = new Set(REASONS)
            const current = new Set(raw)
            if (checked) current.add(kind)
            else current.delete(kind)
            const next = [
              ...REASONS.filter(item => current.has(item)),
              ...raw.filter(item => !known.has(item) && item !== kind),
            ]
            return await this.#write([{ op: 'set', path: ['notifyReasons'], value: next }])
          })
          .catch(() => false)
        return this.#toggleChain
      }

      /**
       * 立即写入一组配置操作（开关与原因勾选共用）。
       *
       * 写前现读 revision，与表单保存走同一套乐观并发控制；被拒绝或抛错都只
       * 返回 false —— 立即写入没有失败回调，异常冒到槽位里只会变成一条未处理
       * 拒绝，界面反而看不出发生过什么。
       * @param ops - 配置操作列表。
       * @returns 宿主是否接受了这次写入。
       */
      async #write(ops) {
        if (this.scope.getSnapshot()?.writable !== true) return false
        let landed = false
        try {
          landed = await this.scope.mutate(ops, this.scope.getSnapshot()?.revision)
        } catch {
          return false
        }
        if (landed) this.publish()
        return landed
      }

      /** 立即写入一个布尔开关。 */
      async setFlag(field, value) {
        return await this.#write([{ op: 'set', path: [field], value }])
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
     * @param props - 卡片注入面（用 `state.dirty` 与已经保存的 url 判断前置条件）。
     */
    function TestNotification(props) {
      const { t, state } = props
      const [local, setLocal] = React.useState({ phase: 'idle', detail: '' })

      const run = async () => {
        // 前置条件不满足时用 blocked：这类提示是「先做别的事」，不该套上
        // 「测试失败：」前缀。
        if (state.dirty === true) {
          setLocal({ phase: 'blocked', detail: t('testUnsaved') })
          return
        }
        if (String(state.urlSaved).trim() === '') {
          setLocal({ phase: 'blocked', detail: t('testNoUrl') })
          return
        }
        setLocal({ phase: 'running', detail: '' })
        try {
          const response = await fetch(TEST_ROUTE, {
            method: 'POST',
            headers: { accept: 'application/json' },
            signal: AbortSignal.timeout(TEST_NOTIFY_TIMEOUT_MS),
          })
          const body = await response.json().catch(() => undefined)
          if (body?.ok === true) {
            setLocal({ phase: 'done', detail: t('testOk') })
            return
          }
          setLocal({ phase: 'failed', detail: String(body?.error ?? `HTTP ${response.status}`) })
        } catch (error) {
          // 超时中止（AbortSignal.timeout 以 TimeoutError 结束）时给出可读提示，
          // 而不是把 DOMException 的英文原文丢给用户。不写 `instanceof Error`：
          // 浏览器的 DOMException 并不继承 Error。
          if (error?.name === 'TimeoutError') {
            setLocal({ phase: 'failed', detail: t('testTimeout') })
            return
          }
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
        valueField('title-question', 'titleQuestion', t('titleQuestion'), t('titleQuestionHint')),
        valueField('question-message', 'questionMessage', t('questionMessage'), t('questionMessageHint')),
        valueField('priority-completed', 'priorityCompleted', t('priorityCompleted'), t('priorityHint'), { numeric: true }),
        valueField('priority-error', 'priorityError', t('priorityError'), t('priorityHint'), { numeric: true }),
        valueField('priority-question', 'priorityQuestion', t('priorityQuestion'), t('priorityHint'), { numeric: true }),
        valueField('min-turn', 'minTurn', t('minTurn'), t('minTurnHint'), { numeric: true, invalidLabel: t('invalidMinTurn') }),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 } },
          h('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-primary)' } }, t('notifyReasons')),
          h(
            'div',
            { style: { display: 'flex', flexWrap: 'wrap', gap: 12 } },
            state.notifyReasons.map(({ kind, checked }) => h(P.Checkbox, {
              key: kind,
              checked,
              disabled,
              label: `${t(reasonKey(kind))}（${kind}）`,
              onChange: next => void props.toggleReason(kind, next === true),
            })),
          ),
          h('p', { style: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, t('notifyReasonsHint')),
        ),
        checkbox('notify-question', 'notifyQuestion', t('notifyQuestion')),
        h('p', { style: { margin: '-6px 0 0', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, t('notifyQuestionHint')),
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
        // 中英两套字典都必须登记：本命名空间没有其它回落来源，缺一套时该语言的
        // 界面会把字典键名原样显示出来（英文界面即属此列）。
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-gotify-notify: 字典')

        const { id, scope } = resolveNamespace(ctx)
        // 一个候选都取不到表单：不注册卡片，避免构造出永远不可用的空壳控制器。
        if (scope === undefined) return
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
