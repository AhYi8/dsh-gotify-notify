/**
 * dsh-gotify-notify —— 宿主半。
 *
 * 监听会话轮次结束事件，向 Gotify 服务器推送一条通知。所有可调参数都通过
 * schemastery `Config` 暴露，且每个字段都带 `.volatile()`：只有 volatile 字段
 * 才会进入 DSH 的设置描述（`settings.describe()`），设置界面才能渲染并在
 * 当前 profile 的 `cordis.patch.yml` 中持久化它们。
 *
 * 凭据：口令存在 DSH 的凭据库里，配置文件里只留引用名（`passwordEnv`，默认
 * `GOTIFY_PASSWORD`）—— 与官方 `llm-deepseek` 适配器的 `apiKeyEnv` 是同一套做法，
 * 在模型设置页写 API Key 时用的就是这条路径。用户名不是机密，仍放在设置里。
 * 取不到凭据时推送失败，但只在日志里报错，绝不影响会话本身。
 */
import z from '@deepseek-ai/schemastery'

/** 通知里默认使用的 Gotify 应用名（不存在时自动创建）。 */
const APP_NAME = 'DSH'

/** 默认正文模板；`\n` 是本插件自己的换行占位符（设置表单是单行输入）。 */
const DEFAULT_MESSAGE = [
  '会话 {title} 第 {turn} 轮已结束',
  '结果：{reason}',
  '目录：{cwd}',
  '时间：{time}',
].join('\\n')

/** 默认「成功」标题模板。 */
const DEFAULT_TITLE_COMPLETED = 'DSH 任务完成'

/** 默认「非成功」标题模板。 */
const DEFAULT_TITLE_OTHER = 'DSH 轮次结束（{reason}）'

/**
 * `turn/end` 的结束原因全集（`event.data.reason.kind`）。
 * 取值来自 `@deepseek-ai/dsh-agent` 的 `TurnEndReasonMap`：`completed` /
 * `blocked` / `aborted` / `interrupted` / `error` / `max-tokens` / `forked`。
 * 该 map 是**可合并扩展**的（后端能加新取值），因此未知取值不臆造中文。
 */
export const REASON_KINDS = [
  'completed',
  'error',
  'blocked',
  'aborted',
  'interrupted',
  'max-tokens',
  'forked',
]

/** `notifyReasons` 的默认值：除 `forked`（内部行为，用户无感知）外全选。 */
export const DEFAULT_NOTIFY_REASONS = REASON_KINDS.filter((kind) => kind !== 'forked')
/** 结束原因到中文标签的映射；未收录的取值原样保留，避免凭空编造语义。 */
const REASON_LABELS = {
  completed: '成功',
  blocked: '被阻断',
  aborted: '已中止',
  interrupted: '已中断',
  error: '失败',
  'max-tokens': '超出长度上限',
  forked: '分支继承',
  unknown: '未知',
}

/** 测试通知路由；浏览器半通过同源 fetch 调用它。 */
const TEST_ROUTE = '/gotify-notify/test'

/** 默认 Gotify 服务器地址（仅作为开箱默认值，设置面板可随时改）。 */
export const DEFAULT_URL = 'https://gotify.21zys.com'

/** 口令凭据的默认引用名（同时是环境变量名，与历史行为一致）。 */
export const DEFAULT_PASSWORD_REF = 'GOTIFY_PASSWORD'

/**
 * 凭据引用名的文法，与官方 `@deepseek-ai/dsh-credentials` 的 `REF_PATTERN` 一致
 * （该包 `lib/index.js:13`）。官方 `isCredentialRefName` 的注释说得很明确：文法外的
 * 名字应当读作「未设置」，而不是抛错。
 */
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

export const name = 'dsh-gotify-notify'

/**
 * 插件配置。全部字段 `.volatile()` —— 设置界面只能编辑 volatile 字段。
 *
 * `title` / `message` 模板支持的占位符：`{id}` `{title}` `{turn}` `{reason}`
 * `{reasonRaw}` `{error}` `{cwd}` `{time}`；`{reason}` 是中文标签、`{reasonRaw}` 是
 * 原始标识、`{error}` 只在出错时有内容；未知占位符原样保留。两个模板里把 `\n`
 * 写成两个字符即可插入换行（表单是单行输入）。
 *
 * `passwordEnv` 是**凭据引用名**（`role('credential-ref')`，与官方 `apiKeyEnv` 同名
 * 约定）：它的值本身不是口令，只是告诉宿主「口令存在凭据库的哪个名字下」。
 *
 * 触发条件：`notifyReasons` 是勾选的结束原因集合（空集合 = 全部不推，属用户的
 * 显式选择）；`minTurn` 是轮次门槛，低于它的轮次不推（快速小问答不打扰）；
 * 优先级按结果分档 —— `completed` 用 `priorityCompleted`，其余原因用
 * `priorityError`。
 */
export const Config = z.object({
  url: z.string().default(DEFAULT_URL).volatile(),
  token: z.string().role('secret').default('').volatile(),
  user: z.string().default('').volatile(),
  passwordEnv: z.string().role('credential-ref').default(DEFAULT_PASSWORD_REF).volatile(),
  titleCompleted: z.string().default(DEFAULT_TITLE_COMPLETED).volatile(),
  titleOther: z.string().default(DEFAULT_TITLE_OTHER).volatile(),
  message: z.string().default(DEFAULT_MESSAGE).volatile(),
  notifyReasons: z.array(z.string()).default(DEFAULT_NOTIFY_REASONS).volatile(),
  priorityCompleted: z.number().step(1).min(0).max(10).default(3).volatile(),
  priorityError: z.number().step(1).min(0).max(10).default(8).volatile(),
  minTurn: z.number().step(1).min(0).default(0).volatile(),
  includeSubagents: z.boolean().default(false).volatile(),
})

/* ------------------------------------------------------------------ 配置求值 */

/** 读取一个配置字段的当前值：volatile 字段是取值器，普通字段是字面量。 */
function live(config, field) {
  const value = config?.[field]
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    return value.get()
  }
  return value
}

/** 读取一个字符串配置字段，去掉首尾空白。 */
function str(config, field) {
  const value = live(config, field)
  return typeof value === 'string' ? value.trim() : ''
}

/** 读取一个布尔配置字段。 */
function bool(config, field) {
  const value = live(config, field)
  return typeof value === 'boolean' ? value : false
}

/** 读取一个整数配置字段，越界或非整数时回落到默认值。 */
function int(config, field, fallback, min, max) {
  const value = live(config, field)
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallback
  if (value < min || value > max) return fallback
  return value
}

/**
 * 读取 `notifyReasons`：过滤成字符串集合。非数组（旧配置迁移 / 手写漏键）时
 * 回落默认全集；空数组是用户的显式选择（一个都不推），原样保留。
 * @param config - 插件配置。
 * @returns 勾选的原因标识数组。
 */
function notifyReasons(config) {
  const value = live(config, 'notifyReasons')
  if (!Array.isArray(value)) return DEFAULT_NOTIFY_REASONS
  return value.filter((kind) => typeof kind === 'string' && kind !== '')
}

/**
 * 求值当前生效的配置。
 * @param config - 插件配置（可能来自 profile patch，也可能来自设置面板）。
 * @returns 归一化后的配置；url 非法时抛错（由调用方决定是否吞掉）。
 */
export function resolveConfig(config) {
  const url = str(config, 'url').replace(/\/+$/, '')
  if (!/^https?:\/\//.test(url)) {
    throw new Error('gotify-notify: 配置缺少合法的 url（Gotify 服务器地址）')
  }
  return {
    url,
    token: str(config, 'token'),
    user: str(config, 'user'),
    passwordEnv: isCredentialRefName(str(config, 'passwordEnv'))
      ? str(config, 'passwordEnv')
      : DEFAULT_PASSWORD_REF,
    titleCompleted: str(config, 'titleCompleted') || DEFAULT_TITLE_COMPLETED,
    titleOther: str(config, 'titleOther') || DEFAULT_TITLE_OTHER,
    message: str(config, 'message') || DEFAULT_MESSAGE,
    notifyReasons: notifyReasons(config),
    priorityCompleted: int(config, 'priorityCompleted', 3, 0, 10),
    priorityError: int(config, 'priorityError', 8, 0, 10),
    minTurn: int(config, 'minTurn', 0, 0, Number.MAX_SAFE_INTEGER),
    includeSubagents: bool(config, 'includeSubagents'),
  }
}

/**
 * 引用名是否符合凭据文法。
 * @param value - 待判定的名字。
 * @returns 是否合法。
 */
export function isCredentialRefName(value) {
  return typeof value === 'string' && REF_PATTERN.test(value)
}

/**
 * 启动环境快照。
 *
 * 官方实现 `launchEnvironmentOf(ctx)` 来自 `@deepseek-ai/dsh-launch-environment`，
 * 第三方插件解析不到那个包（profile 的 `node_modules/@deepseek-ai` 下只有
 * `cosmokit` 与 `schemastery`），所以这里内联它的等价逻辑：宿主注入的
 * `launchEnvironment` 服务优先，缺席时只留进程环境一层。
 * @param ctx - 插件上下文。
 * @returns 提供 `get(name) → { value, source } | undefined` 的快照对象。
 */
export function launchEnvironmentOf(ctx) {
  const snapshot = ctx?.get?.('launchEnvironment')
  if (snapshot !== undefined && typeof snapshot.get === 'function') return snapshot
  const folded = new Map()
  for (const [name, value] of Object.entries(process.env)) {
    folded.set(process.platform === 'win32' ? name.toUpperCase() : name, value)
  }
  return {
    get(name) {
      const value = folded.get(process.platform === 'win32' ? name.toUpperCase() : name)
      return value === undefined ? undefined : { value, source: 'process' }
    },
  }
}

/**
 * 读启动环境里的一个变量。
 * @param environment - `launchEnvironmentOf()` 的返回值。
 * @param name - 变量名。
 * @returns 去掉首尾空白的值；取不到或为空时返回空串。
 */
function environmentValue(environment, name) {
  try {
    const hit = environment?.get?.(name)
    return typeof hit?.value === 'string' ? hit.value.trim() : ''
  } catch {
    return ''
  }
}

/**
 * 按引用名从凭据服务取口令。
 *
 * 凭据服务缺席（profile 没组合它）时只读启动环境 —— 这正是官方
 * `llm-deepseek` 适配器的 `else` 分支：**软探测**，绝不把 `credentials` 写进
 * `inject`，服务不在也不会拖垮本插件。
 * @param ref - 凭据引用名（同时是环境变量名）。
 * @param ctx - 插件上下文。
 * @param environment - 启动环境快照。
 * @returns 口令文本，取不到时空串。
 */
async function storedPassword(ref, ctx, environment) {
  if (!isCredentialRefName(ref)) return environmentValue(environment, ref)
  const credentials = ctx?.get?.('credentials')
  if (credentials === undefined || typeof credentials.resolve !== 'function') {
    return environmentValue(environment, ref)
  }
  try {
    // 引用在运行时只是被 brand 过的字符串，官方 resolve() 不校验品牌，可直接传原名。
    const hit = await credentials.resolve(ref)
    return typeof hit?.value === 'string' ? hit.value.trim() : ''
  } catch {
    // 服务拒绝解析（例如被只读来源遮蔽）时退回启动环境，与「服务缺席」同一处理。
    return environmentValue(environment, ref)
  }
}

/**
 * 求值 Gotify 登录凭据。
 *
 * 取值顺序与官方适配器一致 —— 凭据服务优先，服务给不出值时读启动环境：
 * 1. 凭据服务按 `passwordEnv` 解析（该服务自己的顺序是「继承环境 > 托管文档」，
 *    所以环境变量通常也从这一条读出）；
 * 2. 服务缺席、拒绝解析、或未命中该引用时，读启动环境里与 `passwordEnv` 同名的变量。
 *
 * 用户名不是机密，取面板 `user`，留空则取启动环境 `GOTIFY_USER`。
 * @param config - 归一化后的配置。
 * @param ctx - 插件上下文（可为空，此时只读进程环境）。
 * @returns 用户名/密码对，或 null（由调用方决定报错文案）。
 */
export async function resolveCredentials(config, ctx) {
  const environment = launchEnvironmentOf(ctx)
  const user = config.user !== '' ? config.user : environmentValue(environment, 'GOTIFY_USER')
  if (user === '') return null
  const stored = await storedPassword(config.passwordEnv, ctx, environment)
  const password = stored !== '' ? stored : environmentValue(environment, config.passwordEnv)
  if (password === '') return null
  return { user, password }
}

/**
 * 既没有凭据也没有 token 时的提示文案。
 * @param config - 归一化后的配置。
 * @returns 面向用户的错误说明。
 */
export function missingCredentialMessage(config) {
  return `gotify-notify: 没有可用的凭据 —— 请在设置面板填写用户名，并把口令存入凭据 "${config.passwordEnv}"（或设置同名启动环境变量），也可以直接配置推送 token`
}

/* -------------------------------------------------------------- 模板与渲染 */

/**
 * 把 `turn/end` 的结束原因翻成中文标签。
 * 未收录的取值（`TurnEndReasonMap` 可被后端扩展）原样返回，避免凭空编造语义。
 * @param kind - 原因标识，来自 `event.data.reason.kind`。
 * @returns 中文标签，或原标识；标识缺失时返回「未知」。
 */
export function reasonLabel(kind) {
  if (typeof kind !== 'string' || kind === '') return REASON_LABELS.unknown
  return Object.hasOwn(REASON_LABELS, kind) ? REASON_LABELS[kind] : kind
}

/**
 * 判定一次 `turn/end` 是否应当推送：结束原因在勾选集合里，且轮次达到门槛。
 * 轮次缺失（`turn` 不是数字）时不拦 —— 宁可多推，也不让缺字段吞掉失败通知；
 * 非整数数字轮次（如 2.5）同样视为不可靠的元数据而放行。
 * `config.notifyReasons` 非数组（未经 `resolveConfig` 的裸调用）时回落默认全集，
 * 与 `resolveConfig`、浏览器半 `#reasonList()` 三处口径一致。
 * @param reasonKind - 结束原因标识（`event.data.reason.kind`）。
 * @param turn - 本轮轮次（`event.data.turn`），可能缺失。
 * @param config - 归一化后的配置（`resolveConfig()` 的返回值）。
 * @returns 是否触发通知。
 */
export function shouldNotify(reasonKind, turn, config) {
  const selected = Array.isArray(config?.notifyReasons) ? config.notifyReasons : DEFAULT_NOTIFY_REASONS
  if (!selected.includes(reasonKind)) return false
  if (typeof turn === 'number' && Number.isInteger(turn) && turn < (config.minTurn ?? 0)) return false
  return true
}

/**
 * 按结束原因取推送优先级：`completed` 用成功档，其余（含未知取值）用异常档。
 * 未知取值偏向异常档 —— 新增的结束原因多半值得被看见。
 * @param reasonKind - 结束原因标识。
 * @param config - 归一化后的配置。
 * @returns 0–10 的整数优先级。
 */
export function priorityFor(reasonKind, config) {
  return reasonKind === 'completed' ? config.priorityCompleted : config.priorityError
}

/**
 * 从 `turn/end` 的结束原因里取可读的失败说明。
 *
 * `error` 结束时，`reason.error` 是 `@deepseek-ai/dsh-llm` 的 failure 快照
 * （`{ message, code, status?, … }`，其中 `message` 与 `code` 保证非空）；其余结束
 * 原因没有这一项，返回空串 —— 让模板里的 `{error}` 渲染成空，而不是留着字面量。
 * @param reason - `event.data.reason`。
 * @returns 失败说明，或空串。
 */
export function reasonError(reason) {
  const failure = reason?.error
  if (typeof failure === 'string') return failure.trim()
  if (failure === null || typeof failure !== 'object') return ''
  const message = typeof failure.message === 'string' ? failure.message.trim() : ''
  if (message !== '') return message
  return typeof failure.code === 'string' ? failure.code.trim() : ''
}

/**
 * 渲染模板：把 `{key}` 换成变量值，未识别的占位符原样保留。
 * 模板里写两个字符 `\` + `n` 会被还原成真正的换行。
 * @param template - 模板文本。
 * @param vars - 变量表。
 * @returns 渲染结果。
 */
export function render(template, vars) {
  const text = String(template).replace(/\\n/g, '\n')
  return text.replace(/\{(\w+)\}/g, (whole, key) =>
    Object.hasOwn(vars, key) ? String(vars[key]) : whole)
}

/** 会话短 id：去掉 `session-` 前缀后取前 8 个字符。 */
function shortId(session) {
  const raw = typeof session?.id === 'string' ? session.id : ''
  return raw.replace(/^session-/, '').slice(0, 8) || 'unknown'
}

/**
 * 取会话的事件日志。新版 `Session` 只暴露 `snapshotEvents()` 方法，没有 `events`
 * 属性；这里同时兼容老式/回放对象上的 `events` 数组。
 * @param session - 会话对象。
 * @returns 事件数组（取不到时为空数组）。
 */
function sessionEvents(session) {
  if (typeof session?.snapshotEvents === 'function') {
    const events = session.snapshotEvents()
    if (Array.isArray(events)) return events
  }
  return Array.isArray(session?.events) ? session.events : []
}

/**
 * 从事件日志里折叠出最近一次已接受的会话标题。
 * @param events - 事件数组。
 * @returns 标题文本，没有标题事件时为 undefined。
 */
function foldTitle(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'session/title' && typeof event.data?.title === 'string' && event.data.title !== '') {
      return event.data.title
    }
  }
  return undefined
}

/**
 * 事件日志里第一条人类用户消息的正文，用于标题事件尚未落盘时兜底。
 * @param events - 事件数组。
 * @returns 正文文本，没有合格消息时为 undefined。
 */
function firstUserText(events) {
  for (const event of events) {
    if (event?.type !== 'user/message' || event.data?.source?.kind !== 'user') continue
    const blocks = Array.isArray(event.data.content) ? event.data.content : []
    const text = blocks
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
    if (text.trim() !== '') return text
  }
  return undefined
}

/**
 * 把一段正文压成一行短标题：合并空白、最多 8 个词、最多 40 个字符（按码点截断）。
 * @param text - 原始正文。
 * @returns 压缩后的短标题。
 */
function condense(text) {
  const words = String(text).replace(/\s+/g, ' ').trim().split(' ').slice(0, 8).join(' ')
  const points = Array.from(words)
  return points.length > 40 ? `${points.slice(0, 40).join('')}…` : words
}

/**
 * 通过官方会话标题服务读标题：与侧边栏显示的是同一个值。
 * `ctx.sessionTitle` 可能不存在或读取失败，两种取法都试一遍。
 * @param session - 会话对象。
 * @param ctx - 插件上下文。
 * @returns 标题文本，取不到时为 undefined。
 */
function titleFromService(session, ctx) {
  const sources = [() => ctx?.sessionTitle, () => ctx?.get?.('sessionTitle')]
  for (const source of sources) {
    try {
      const snapshot = source()?.get?.(session)
      const title = typeof snapshot === 'string' ? snapshot : snapshot?.title
      if (typeof title === 'string' && title !== '') return title
    } catch {
      // 换下一种取法；服务缺失不应影响通知推送。
    }
  }
  return undefined
}

/**
 * 会话标题。依次尝试：官方 `sessionTitle` 服务 → 自己折叠 `session/title` 事件 →
 * 第一条人类用户消息的开头 → 会话短 id。
 * 注意：`Session` 没有 `events` 属性（只有 `snapshotEvents()`），早期实现直接读
 * `session.events` 会永远落到短 id，通知里就出现一串 uuid 似的东西。
 * @param session - 会话对象。
 * @param ctx - 插件上下文，用于取 `sessionTitle` 服务（可为空）。
 * @returns 标题文本。
 */
export function latestTitle(session, ctx) {
  const served = titleFromService(session, ctx)
  if (served !== undefined) return served
  const events = sessionEvents(session)
  const folded = foldTitle(events)
  if (folded !== undefined) return folded
  const text = firstUserText(events)
  if (text !== undefined) return condense(text)
  return shortId(session)
}

/** 工作目录的目录名；缺省时回落「未知目录」（与历史版本输出一致）。 */
function cwdBasename(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return '未知目录'
  return cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || cwd
}

/* ------------------------------------------------------------------ Gotify */

/**
 * 与一台 Gotify 服务器通讯的小客户端：按需取 token，然后推消息。
 * token 缓存在实例上；取 token 失败时清空缓存，下一次重试。
 */
export class GotifyClient {
  /** @param logger - 用于记录失败的日志器（可为空）。 */
  constructor(logger) {
    this.logger = logger
    this.tokenPromise = undefined
  }

  /**
   * 取（并缓存）推送用的 token：设置里直接给了 token 就用它，否则用
   * Basic 认证列出 `/application` 找名为 `DSH` 的应用并复用其 token，
   * 没有同名应用时创建一个。
   */
  async obtainToken(config, credentials) {
    if (config.token !== '') return config.token
    if (this.tokenPromise === undefined) {
      this.tokenPromise = this.#createToken(config, credentials).catch((error) => {
        this.tokenPromise = undefined
        throw error
      })
    }
    return await this.tokenPromise
  }

  async #createToken(config, credentials) {
    if (credentials === undefined) {
      throw new Error('gotify-notify: 未配置推送 token，也没有可用的用户名/密码')
    }
    const headers = {
      authorization: `Basic ${Buffer.from(`${credentials.user}:${credentials.password}`).toString('base64')}`,
      accept: 'application/json',
      'accept-encoding': 'identity',
    }
    const listed = await fetch(`${config.url}/application`, { headers })
    if (!listed.ok) {
      throw new Error(`gotify-notify: 读取应用列表失败（HTTP ${listed.status}）`)
    }
    const applications = await listed.json()
    const existing = Array.isArray(applications)
      ? applications.find((item) => item?.name === APP_NAME)
      : undefined
    if (existing !== undefined && typeof existing.token === 'string') return existing.token
    const created = await fetch(`${config.url}/application`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ name: APP_NAME, description: 'DSH 会话轮次结束通知' }),
    })
    if (!created.ok) {
      throw new Error(`gotify-notify: 创建应用失败（HTTP ${created.status}）`)
    }
    const application = await created.json()
    if (typeof application?.token !== 'string' || application.token === '') {
      throw new Error('gotify-notify: 应用响应里没有 token')
    }
    return application.token
  }

  /** 推送一条消息；返回 Gotify 的响应摘要，失败时抛错。 */
  async push(config, credentials, payload) {
    const token = await this.obtainToken(config, credentials)
    const response = await fetch(`${config.url}/message?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        accept: 'application/json',
        'accept-encoding': 'identity',
      },
      body: JSON.stringify(payload),
    })
    if (!response.ok) {
      throw new Error(`gotify-notify: 推送失败（HTTP ${response.status}）`)
    }
    return { status: response.status }
  }

  /** 记录一次失败，不抛出。 */
  report(error) {
    const detail = error instanceof Error ? error.message : String(error)
    if (this.logger === undefined) return
    this.logger.error(`推送失败：${detail}`)
  }
}

/* ------------------------------------------------------------------ 插件 */

/**
 * 推送一次通知；所有错误都只记日志，绝不影响会话。
 * @param client - Gotify 客户端（错误由它统一记录）。
 * @param rawConfig - 原始插件配置。
 * @param payload - 可选，显式覆盖标题/正文（测试通知用）。
 * @param ctx - 可选，插件上下文；凭据服务从这里软探测。
 * @returns 是否成功送出。
 */
export async function notify(client, rawConfig, payload, ctx) {
  try {
    const config = resolveConfig(rawConfig)
    const credentials = await resolveCredentials(config, ctx)
    if (credentials === null && config.token === '') {
      throw new Error(missingCredentialMessage(config))
    }
    await client.push(config, credentials ?? undefined, payload ?? {
      title: config.titleCompleted,
      message: config.message,
      priority: config.priorityCompleted,
    })
    return true
  } catch (error) {
    client.report(error)
    return false
  }
}

/**
 * 宿主半入口。
 * @param ctx - cordis 宿主上下文。
 * @param config - 已解析的插件配置。
 */
export function apply(ctx, config) {
  const logger = ctx.logger?.('gotify-notify') ?? ctx.logger
  const client = new GotifyClient(logger)

  ctx.on('session/event', (session, event) => {
    // 先做最廉价的类型过滤：绝大多数事件不是 turn/end。
    if (event?.type !== 'turn/end') return
    const header = session?.header ?? {}
    // 子 Agent 会话不通知：origin 标记或存在父会话都视为子 Agent。
    if (!bool(config, 'includeSubagents') && (header.origin === 'subagent' || header.parentSession !== undefined)) return
    // 结束原因：判定只用原始标识，模板里 `{reason}` 用中文标签、`{reasonRaw}` 用标识。
    const reasonKind = event.data?.reason?.kind ?? 'unknown'
    const turn = event.data?.turn
    let resolved
    try {
      resolved = resolveConfig(config)
    } catch (error) {
      client.report(error)
      return
    }
    if (!shouldNotify(reasonKind, turn, resolved)) return
    const target = reasonKind === 'completed' ? resolved.titleCompleted : resolved.titleOther
    const vars = {
      id: shortId(session),
      title: latestTitle(session, ctx),
      turn: turn ?? '',
      reason: reasonLabel(reasonKind),
      reasonRaw: reasonKind,
      error: reasonError(event.data?.reason),
      cwd: cwdBasename(header.cwd),
      time: new Date().toLocaleString('zh-CN'),
    }
    void notify(client, config, {
      title: render(target, vars),
      message: render(resolved.message, vars),
      priority: priorityFor(reasonKind, resolved),
    }, ctx)
  })

  // 「发送测试通知」按钮的宿主通道：浏览器半的 fetch 与页面同源，这里再用回环围栏复核一次。
  ctx.inject?.(['webServer'], (scope) => {
    scope.effect(
      () => scope.webServer.register({
        kind: 'exact',
        path: TEST_ROUTE,
        handler: async (req, res) => {
          if (!sameOriginRequest(req)) {
            writeJson(res, 403, { error: '不受信任的来源' })
            return
          }
          if (req.method !== 'POST') {
            writeJson(res, 405, { error: '不支持的请求方法' })
            return
          }
          try {
            const resolved = resolveConfig(config)
            const credentials = await resolveCredentials(resolved, ctx)
            if (credentials === null && resolved.token === '') {
              throw new Error(missingCredentialMessage(resolved))
            }
            const sent = await client.push(resolved, credentials ?? undefined, {
              title: render(resolved.titleCompleted, {
                id: 'test',
                title: '测试通知',
                turn: '1',
                reason: 'completed',
                cwd: '',
                time: new Date().toLocaleString('zh-CN'),
              }),
              message: '这是一条来自 DSH 设置页的测试通知。',
              priority: resolved.priorityCompleted,
            })
            writeJson(res, 200, { ok: true, status: sent.status })
          } catch (error) {
            writeJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        },
      }),
      'dsh-gotify-notify: test route',
    )
  })
}

/** IPv4 127/8 判定。 */
function isIPv4Loopback(v4) {
  const parts = v4.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** socket 远端地址是否属于回环范围（127/8、::1、IPv4 映射）。 */
function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address === '') return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice('::ffff:'.length))
  return isIPv4Loopback(normalized)
}

/** 主机名是否指向回环权威（localhost、[::1]、127/8）。 */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIPv4Loopback(hostname)
}

/**
 * 校验测试通知请求确实来自本机 Web GUI。
 *
 * 权威边界是「回环 socket + 回环 Host」。注意 DSH 桌面壳把 GUI 页面
 * （dsh-app://app/）发出的请求转发给宿主时会删掉 origin 与 sec-fetch-site，
 * 所以**没有任何浏览器标记的请求也必须放行**，否则桌面端必然 403。
 * 跨站标记一律拒绝；带了 Origin 时必须与 Host 同权威。
 * 语义与官方 dsh-web-shared 的 isLoopbackRequest 一致。
 */
export function sameOriginRequest(req) {
  if (!isLoopbackAddress(req?.socket?.remoteAddress)) return false
  const host = req?.headers?.host
  if (typeof host !== 'string' || host === '') return false
  let hostUrl
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** 写一个 JSON 响应。 */
function writeJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}
