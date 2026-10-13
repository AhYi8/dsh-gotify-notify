/**
 * 非交互自检：加载宿主半模块，验证 Config 能被 schemastery 解析、
 * volatile 字段齐备、模板渲染与凭据求值符合预期。
 *
 * 依赖宿主 hoist 的 `@deepseek-ai/schemastery`。开发目录里没有它时，
 * 先在包目录建一次目录联接再运行：
 *   New-Item -ItemType Junction -Path node_modules\@deepseek-ai\schemastery `
 *     -Target "$env:DSH_PROFILE_DIR\node_modules\@deepseek-ai\schemastery"
 *
 * 用法：node selfcheck.mjs
 */
import assert from 'node:assert/strict'
import {
  Config,
  DEFAULT_NOTIFY_REASONS,
  DEFAULT_PASSWORD_REF,
  DEFAULT_URL,
  GotifyClient,
  REASON_KINDS,
  isCredentialRefName,
  latestTitle,
  launchEnvironmentOf,
  missingCredentialMessage,
  priorityFor,
  QUESTION_TOOLS,
  reasonError,
  reasonLabel,
  render,
  resolveConfig,
  resolveCredentials,
  sameOriginRequest,
  shouldNotify,
  shouldNotifyQuestion,
} from './lib/index.js'

/**
 * 用默认值构造一份「已解析」的配置对象（模拟 cordis 传给 apply 的 config）。
 *
 * 刻意**不**提供五个模板字段：`resolveConfig` 会回落到 schema 里的默认模板，
 * 于是渲染断言吃到的就是真实默认值。早先在这里抄了一份模板副本，schema 改了
 * 正文（补「目录/时间」两行）而副本没跟上，断言仍然全绿。
 */
function resolved(overrides = {}) {
  const values = {
    url: '',
    token: '',
    user: '',
    passwordEnv: '',
    notifyReasons: DEFAULT_NOTIFY_REASONS.slice(),
    priorityCompleted: 3,
    priorityError: 8,
    priorityQuestion: 8,
    minTurn: 0,
    notifyQuestion: false,
    includeSubagents: false,
    ...overrides,
  }
  const view = {}
  for (const key of Object.keys(values)) view[key] = { get: () => values[key] }
  return view
}

/** 一份只有 `get` 的插件上下文，用来假冒宿主的 `credentials` 与 `launchEnvironment`。 */
function contextFor({ credentials, environment } = {}) {
  return {
    get(name) {
      if (name === 'credentials') return credentials
      if (name === 'launchEnvironment') return environment
      return undefined
    },
  }
}

/** 假冒的启动环境快照（官方 `createLaunchEnvironmentSnapshot` 的最小子集）。 */
function environmentOf(values) {
  return {
    get: (name) => (Object.hasOwn(values, name) ? { value: values[name], source: 'process' } : undefined),
  }
}

/** 假冒的凭据服务：`resolve` 读、`describe` 报状态、`set` 写（迁移测试要断言写入）。 */
function vaultOf(values) {
  const store = new Map(Object.entries(values))
  return {
    store,
    resolve: async ref => (store.has(ref) ? { value: store.get(ref), source: 'managed' } : undefined),
    describe: async ref => ({ configured: store.has(ref), writable: true }),
    set: async (ref, value) => {
      store.set(ref, value)
    },
  }
}

// 1) Config 是一份 schemastery schema，且每个字段都可序列化。
const json = Config.toJSON()
assert.ok(json !== undefined, 'Config.toJSON() 应有输出')
const schemaJson = JSON.stringify([
  json.uid,
  json.refs,
])
assert.ok(schemaJson.includes('volatile'), '序列化结果里应保留 volatile 元信息')

// 2) 全部字段都是 volatile（否则设置界面看不到它们）。
const fields = ['url', 'token', 'user', 'passwordEnv', 'titleCompleted', 'titleOther', 'titleQuestion', 'message', 'questionMessage', 'notifyReasons', 'priorityCompleted', 'priorityError', 'priorityQuestion', 'minTurn', 'notifyQuestion', 'includeSubagents']
assert.deepEqual(Object.keys(Config.dict).sort(), [...fields].sort(), 'volatile 字段清单必须覆盖 Config 的全部字段（新增字段不能漏）')
for (const field of fields) {
  assert.ok(Config.dict[field] !== undefined, `Config 缺少字段 ${field}`)
  assert.equal(Config.dict[field].meta.volatile, true, `字段 ${field} 不是 volatile`)
}

// 2.1) 自检里的默认值副本必须与 schema 默认值逐项一致：两层各改一处也能被抓住。
for (const field of ['priorityCompleted', 'priorityError', 'priorityQuestion', 'minTurn', 'notifyQuestion', 'includeSubagents', 'notifyReasons']) {
  assert.deepEqual(resolved()[field].get(), Config.dict[field].meta.default, `自检里的 ${field} 默认值副本与 schema 不一致`)
}
// 字符串字段反过来：自检故意给空串（走 resolveConfig 自己的回落与报错路径）。
for (const field of ['url', 'token', 'user', 'passwordEnv']) {
  assert.equal(resolved()[field].get(), '', `自检里的 ${field} 应是空串兜底值`)
}
// 五个模板字段：自检里**不该**有副本，否则 schema 改了正文也测不出来。
for (const field of ['titleCompleted', 'titleOther', 'titleQuestion', 'message', 'questionMessage']) {
  assert.equal(resolved()[field], undefined, `自检不应为 ${field} 抄默认值副本（应让 resolveConfig 回落到 schema 默认值）`)
}

// 3) url 校验与归一化。
assert.equal(resolved().url.get(), '', '自检兜底值本身是空串（区别于 schema 默认）')
assert.equal(Config.dict.url.meta.default, DEFAULT_URL, 'Config 的 url 默认值应是内置地址')
assert.equal(DEFAULT_URL, 'https://gotify.21zys.com')
assert.throws(() => resolveConfig(resolved()), /缺少合法的 url/)
assert.throws(() => resolveConfig(resolved({ url: 'ftp://gotify.example.com' })), /缺少合法的 url/)
const cfg = resolveConfig(resolved({ url: 'https://gotify.21zys.com/' }))
assert.equal(cfg.url, 'https://gotify.21zys.com')
assert.equal(cfg.priorityCompleted, 3)
assert.equal(cfg.priorityError, 8)
assert.equal(cfg.minTurn, 0)

// 4) 凭据优先级：凭据服务 > 启动环境 > null。
//    凭据服务是**软探测**（官方 llm-deepseek 适配器同款）：`ctx.get('credentials')`
//    取不到时自动回落启动环境，绝不因为 profile 没组合该服务而失败。
assert.equal(cfg.passwordEnv, DEFAULT_PASSWORD_REF, '未声明 passwordEnv 时应收敛到默认引用名')
assert.equal(
  resolveConfig(resolved({ url: 'https://gotify.21zys.com', passwordEnv: 'not-a-ref' })).passwordEnv,
  DEFAULT_PASSWORD_REF,
  '不合文法的引用名应收敛到默认值',
)
assert.deepEqual(
  await resolveCredentials(cfg, contextFor({
    credentials: vaultOf({ GOTIFY_PASSWORD: 'vaultpw' }),
    environment: environmentOf({ GOTIFY_USER: 'env' }),
  })),
  { user: 'env', password: 'vaultpw' },
  '凭据服务命中时应优先取凭据库的口令，用户名取自启动环境',
)
assert.deepEqual(
  await resolveCredentials(cfg, contextFor({
    environment: environmentOf({ GOTIFY_USER: 'env', GOTIFY_PASSWORD: 'envpw' }),
  })),
  { user: 'env', password: 'envpw' },
  '未组合凭据服务时应回落到启动环境',
)
assert.deepEqual(
  await resolveCredentials(cfg, contextFor({
    credentials: { resolve: async () => { throw new Error('被只读来源遮蔽') } },
    environment: environmentOf({ GOTIFY_USER: 'env', GOTIFY_PASSWORD: 'envpw' }),
  })),
  { user: 'env', password: 'envpw' },
  '凭据服务拒绝解析时应退回启动环境',
)
let resolveCalls = 0
let lastRef = ''
assert.deepEqual(
  await resolveCredentials(cfg, contextFor({
    credentials: { resolve: async (ref) => { resolveCalls += 1; lastRef = ref; return undefined } },
    environment: environmentOf({ GOTIFY_USER: 'env', GOTIFY_PASSWORD: 'envpw' }),
  })),
  { user: 'env', password: 'envpw' },
  '凭据服务在场但未命中时仍应回落到启动环境',
)
assert.equal(resolveCalls, 1, '有凭据服务时应当查询一次')
assert.equal(lastRef, DEFAULT_PASSWORD_REF, '查询用的应当是归一后的引用名')
assert.equal(await resolveCredentials(cfg, contextFor({ environment: environmentOf({}) })), null)
assert.equal(
  await resolveCredentials(resolveConfig(resolved({ url: 'https://gotify.21zys.com', user: 'u' })), contextFor({ environment: environmentOf({}) })),
  null,
  '只有用户名、哪都没有口令时应返回 null（由调用方给出提示）',
)
assert.ok(
  missingCredentialMessage(cfg).includes(DEFAULT_PASSWORD_REF),
  '凭据缺失的提示里应当点名引用名',
)

// 4b) 凭据引用名的文法（与官方 `@deepseek-ai/dsh-credentials` 的 REF_PATTERN 一致）。
assert.equal(isCredentialRefName('GOTIFY_PASSWORD'), true)
assert.equal(isCredentialRefName('_x1'), true)
assert.equal(isCredentialRefName('gotify-password'), false, '连字符不在文法内')
assert.equal(isCredentialRefName('1ABC'), false, '数字不能开头')
assert.equal(isCredentialRefName(''), false)
assert.equal(isCredentialRefName(undefined), false)

// 4c) 启动环境：ctx 里没有该服务时回落进程环境（官方 launchEnvironmentOf 的同构行为）。
assert.equal(typeof launchEnvironmentOf({}).get('PATH')?.value, 'string')
const injected = { get: () => ({ value: 'injected', source: 'user-env' }) }
assert.equal(
  launchEnvironmentOf(contextFor({ environment: injected })).get('ANY')?.value,
  'injected',
  'ctx 里有 launchEnvironment 时应直接用它，而不是回落到进程环境',
)

// 5) 模板渲染：占位符替换、未知占位符保留、`\n` 还原换行。
const vars = { id: 'abc12345', title: '演示会话', turn: 3, reason: 'completed', cwd: 'desktop', time: '2026/1/1 00:00:00' }
assert.equal(render('DSH 轮次结束（{reason}）', vars), 'DSH 轮次结束（completed）')
assert.equal(render('{title} {unknown}', vars), '演示会话 {unknown}')
assert.equal(render('a\\nb', vars), 'a\nb')

// 6) 默认正文模板经 resolveConfig 后仍是「两字符 \n」，渲染后才成换行。
const multi = render(cfg.message, vars)
assert.ok(multi.includes('\n'), '默认正文应渲染出真正的换行')
assert.ok(multi.includes('演示会话'), '默认正文应含会话标题')

// 7) 测试路由的信任围栏：回环 socket + 回环 Host 是权威边界。
// 注意不能把 host 直接写成默认参数——传 undefined 会触发默认值，
// 那样「缺 Host」这一条就测不到了，所以用 noHost 开关显式省略该键。
function mockReq(options = {}) {
  const headers = {}
  if (options.noHost !== true) headers.host = options.host ?? '127.0.0.1:19387'
  if (options.origin !== undefined) headers.origin = options.origin
  if (options.site !== undefined) headers['sec-fetch-site'] = options.site
  return { socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' }, headers }
}

// 放行侧。
assert.equal(sameOriginRequest(mockReq()), true, '无浏览器标记的回环请求应放行（桌面壳会删掉这些头）')
assert.equal(sameOriginRequest(mockReq({ site: 'same-origin' })), true, '同站标记应放行')
assert.equal(sameOriginRequest(mockReq({ origin: 'http://127.0.0.1:19387' })), true, '同权威 Origin 应放行')
assert.equal(sameOriginRequest(mockReq({ host: 'localhost:19387' })), true, 'localhost 权威应放行')
assert.equal(sameOriginRequest(mockReq({ host: '[::1]:19387', remoteAddress: '::1' })), true, 'IPv6 回环应放行')
assert.equal(sameOriginRequest(mockReq({ remoteAddress: '::ffff:127.0.0.1' })), true, 'IPv4 映射回环应放行')
// 拒绝侧。
assert.equal(sameOriginRequest(mockReq({ site: 'cross-site' })), false, '跨站标记应拒绝')
assert.equal(sameOriginRequest(mockReq({ origin: 'http://evil.example.com' })), false, '异权威 Origin 应拒绝')
assert.equal(sameOriginRequest(mockReq({ origin: 'null' })), false, '不透明 Origin 应拒绝')
assert.equal(sameOriginRequest(mockReq({ remoteAddress: '192.168.1.5' })), false, '非回环 socket 应拒绝')
assert.equal(sameOriginRequest(mockReq({ host: 'evil.example.com:19387' })), false, '非回环 Host 应拒绝')
assert.equal(sameOriginRequest(mockReq({ host: '10.0.0.1:19387' })), false, '私网 Host 应拒绝')
assert.equal(sameOriginRequest(mockReq({ host: '127.0.0.1:notaport' })), false, '非法 Host 应拒绝')
assert.equal(sameOriginRequest(mockReq({ noHost: true })), false, '缺 Host 应拒绝')
// 桩件默认 remoteAddress 是回环地址，所以「缺 Host 应拒绝」只有在 host 键真的缺席时才成立；
// 这一条防的是桩件将来改坏后上一条「因为错误的原因」通过。
assert.equal(mockReq({ noHost: true }).headers.host, undefined, 'noHost 桩件确实不带 host 键')

// 8) 会话标题：官方服务 → 事件折叠 → 首条用户消息 → 短 id。
// 关键回归点：真实 `Session` 没有 `events` 属性，只有 `snapshotEvents()`。
function mockSession(events, id = 'session-abcdef123456') {
  return { id, header: {}, snapshotEvents: () => events }
}
const titleEvent = (title) => ({ type: 'session/title', seq: 1, data: { title } })
const userEvent = (text) => ({ type: 'user/message', seq: 2, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })

assert.equal(
  latestTitle(mockSession([titleEvent('事件里的标题')]), { sessionTitle: { get: () => ({ title: '服务标题' }) } }),
  '服务标题',
  '优先用 sessionTitle 服务（快照对象）',
)
assert.equal(
  latestTitle(mockSession([titleEvent('事件里的标题')]), { sessionTitle: { get: () => '字符串标题' } }),
  '字符串标题',
  '服务直接返回字符串也认',
)
assert.equal(
  latestTitle(mockSession([titleEvent('事件里的标题')]), { sessionTitle: { get: () => { throw new Error('boom') } } }),
  '事件里的标题',
  '服务读取抛错时回落事件折叠',
)
assert.equal(
  latestTitle(mockSession([titleEvent('事件里的标题')]), { get: (name) => (name === 'sessionTitle' ? { get: () => ({ title: 'ctx.get 标题' }) } : undefined) }),
  'ctx.get 标题',
  'ctx.get("sessionTitle") 也是可用取法',
)
assert.equal(latestTitle(mockSession([titleEvent('事件里的标题')]), undefined), '事件里的标题', '没有 ctx 时照样能折叠')
assert.equal(latestTitle(mockSession([titleEvent('旧标题'), titleEvent('新标题')])), '新标题', '折叠取最近一次标题事件')
assert.equal(latestTitle(mockSession([titleEvent('')])), 'abcdef12', '空标题事件不算数，回落短 id')
assert.equal(latestTitle({ id: 'session-abcdef123456', events: [titleEvent('老式标题')] }), '老式标题', '兼容老式 events 数组')
assert.equal(latestTitle(mockSession([userEvent('帮我把 gotify 通知改成显示会话名，谢谢')])), '帮我把 gotify 通知改成显示会话名，谢谢', '标题事件未落盘时用首条用户消息兜底')
assert.equal(latestTitle(mockSession([userEvent('一\n二\n三')])), '一 二 三', '正文换行压成空格')
assert.equal(latestTitle(mockSession([userEvent('一 二 三 四 五 六 七 八 九 十')])), '一 二 三 四 五 六 七 八', '最多 8 个词')
assert.equal(latestTitle(mockSession([userEvent('甲'.repeat(50))])), `${'甲'.repeat(40)}…`, '超过 40 个字符按码点截断')
assert.equal(
  latestTitle(mockSession([{ type: 'user/message', data: { source: { kind: 'system' }, content: [{ type: 'text', text: 'x' }] } }])),
  'abcdef12',
  '非人类用户消息不作为标题来源',
)
assert.equal(latestTitle(mockSession([])), 'abcdef12', '无标题事件、无用户消息时回落短 id')
assert.equal(latestTitle(undefined), 'unknown', '会话对象缺失时不抛错')

// 9) 结束原因的中文映射：已知翻中文、未收录原样保留、缺失为「未知」。
assert.equal(reasonLabel('completed'), '成功')
assert.equal(reasonLabel('error'), '失败')
assert.equal(reasonLabel('aborted'), '已中止')
assert.equal(reasonLabel('interrupted'), '已中断')
assert.equal(reasonLabel('blocked'), '被阻断')
assert.equal(reasonLabel('max-tokens'), '超出长度上限')
assert.equal(reasonLabel('forked'), '分支继承')
assert.equal(reasonLabel('unknown'), '未知')
assert.equal(reasonLabel('brand-new-kind'), 'brand-new-kind', '未收录的取值原样返回，不编造中文')
assert.equal(reasonLabel(''), '未知', '空标识算缺失')
assert.equal(reasonLabel(undefined), '未知', '标识缺失时返回未知')
assert.equal(reasonLabel(42), '未知', '非字符串标识返回未知')
assert.equal(
  render('DSH 轮次结束（{reason}）', { reason: reasonLabel('aborted'), reasonRaw: 'aborted' }),
  'DSH 轮次结束（已中止）',
  '默认「非成功」标题渲染成中文原因',
)
assert.equal(
  render('{reason}/{reasonRaw}', { reason: reasonLabel('completed'), reasonRaw: 'completed' }),
  '成功/completed',
  '中文标签与原始标识可同时使用',
)

// 10) `{error}` 占位符：只从 `error` 结束的失败快照取说明，其余情况为空串。
assert.equal(reasonError({ kind: 'error', error: { message: '连接超时', code: 'TIMEOUT' } }), '连接超时', '取 failure.message')
assert.equal(reasonError({ kind: 'error', error: { message: '  空白  ', code: 'X' } }), '空白', '消息去首尾空白')
assert.equal(reasonError({ kind: 'error', error: { code: 'NO_MESSAGE' } }), 'NO_MESSAGE', '消息缺失时回落 code')
assert.equal(reasonError({ kind: 'error', error: { message: '', code: 'ONLY_CODE' } }), 'ONLY_CODE', '空消息时回落 code')
assert.equal(reasonError({ kind: 'error', error: '裸字符串错误' }), '裸字符串错误', '字符串形态也认')
assert.equal(reasonError({ kind: 'error' }), '', '没有 error 字段返回空串')
assert.equal(reasonError({ kind: 'error', error: { status: 500 } }), '', '既无 message 又无 code 时返回空串')
assert.equal(reasonError({ kind: 'error', error: null }), '', 'error 为 null 不抛错')
assert.equal(reasonError({ kind: 'completed' }), '', '成功结束没有错误说明')
assert.equal(reasonError({ kind: 'aborted', reason: { kind: 'user' } }), '', '中止不是错误，返回空串')
assert.equal(reasonError(undefined), '', '整块原因缺失时返回空串')
assert.equal(
  render('结果：{reason}\\n{error}', { reason: reasonLabel('error'), error: reasonError({ kind: 'error', error: { message: '模型返回 429', code: 'RATE_LIMIT' } }) }),
  '结果：失败\n模型返回 429',
  '默认正文追加 {error} 时可渲染出失败详情',
)
assert.equal(
  render('结果：{reason}\\n{error}', { reason: reasonLabel('completed'), error: reasonError({ kind: 'completed' }) }),
  '结果：成功\n',
  '成功时 {error} 渲染成空，不残留字面量',
)

// 11) 触发判定真值表：原因集合过滤 + 轮次门槛 + 分档优先级。
assert.deepEqual(
  REASON_KINDS,
  ['completed', 'error', 'blocked', 'aborted', 'interrupted', 'max-tokens', 'forked'],
  '原因全集应与 TurnEndReasonMap 一致',
)
const allCfg = resolveConfig(resolved({ url: 'https://gotify.21zys.com' }))
for (const kind of REASON_KINDS) {
  if (kind === 'forked') continue
  assert.equal(shouldNotify(kind, 1, allCfg), true, `默认集合应放行 ${kind}`)
}
assert.equal(shouldNotify('forked', 1, allCfg), false, 'forked 默认不推（内部行为）')
assert.equal(shouldNotify('brand-new-kind', 1, allCfg), false, '未勾选的未知取值不推')
assert.equal(
  shouldNotify('brand-new-kind', 1, resolveConfig(resolved({ url: 'https://gotify.21zys.com', notifyReasons: ['brand-new-kind'] }))),
  true,
  '勾选了未知取值也能推（后端新增原因不至于静默丢失）',
)
assert.equal(
  shouldNotify('completed', 1, resolveConfig(resolved({ url: 'https://gotify.21zys.com', notifyReasons: [] }))),
  false,
  '空集合是显式的「一个都不推」',
)
assert.equal(
  shouldNotify('completed', 1, resolveConfig(resolved({ url: 'https://gotify.21zys.com', notifyReasons: 'completed' }))),
  true,
  'notifyReasons 非数组（旧配置/手写漏键）时回落默认全集',
)
assert.equal(
  shouldNotify('completed', 1, resolveConfig(resolved({ url: 'https://gotify.21zys.com', notifyReasons: ['completed', 42, ''] }))),
  true,
  '集合里的非字符串项应被过滤而不是炸掉',
)
// 轮次门槛：低于门槛拦截、达到放行、缺失放行、非整数配置回落 0。
const turnCfg = resolveConfig(resolved({ url: 'https://gotify.21zys.com', minTurn: 3 }))
assert.equal(shouldNotify('completed', 2, turnCfg), false, '低于门槛的轮次不推')
assert.equal(shouldNotify('completed', 3, turnCfg), true, '达到门槛的轮次放行')
assert.equal(shouldNotify('completed', undefined, turnCfg), true, '轮次缺失时不拦（宁可多推）')
assert.equal(shouldNotify('completed', '2', turnCfg), true, '轮次不是数字时同样不拦')
assert.equal(shouldNotify('completed', 2.5, turnCfg), true, '非整数数字轮次视为不可靠元数据而放行')
// 裸调用（未经 resolveConfig 的 config）也回落默认全集，与 resolveConfig 口径一致。
assert.equal(shouldNotify('forked', 1, {}), false, '裸调用的 forked 也不推（回落默认集）')
assert.equal(shouldNotify('completed', 1, {}), true, '裸调用的 completed 放行（回落默认集）')
assert.equal(
  resolveConfig(resolved({ url: 'https://gotify.21zys.com', minTurn: -1 })).minTurn,
  0,
  '负数门槛回落 0',
)
// 分档优先级：成功档 / 异常档 / 越界回落。
assert.equal(priorityFor('completed', allCfg), 3, 'completed 用成功档优先级')
assert.equal(priorityFor('error', allCfg), 8, 'error 用异常档优先级')
assert.equal(priorityFor('unknown', allCfg), 8, '未知取值偏向异常档')
assert.equal(
  priorityFor('completed', resolveConfig(resolved({ url: 'https://gotify.21zys.com', priorityCompleted: 99 }))),
  3,
  '越界的优先级草稿回落默认档',
)

// 12) 「等待用户决定」通知：工具集合、独立配置档、轮次门槛、模板渲染。
assert.deepEqual(
  [...QUESTION_TOOLS].sort(),
  ['ask_user_question', 'request_user_input'],
  '提问工具集应只含选择框与输入框（权限审批走 ctx.approval 缝，明确不覆盖）',
)
const qCfg = resolveConfig(resolved({ url: 'https://gotify.21zys.com' }))
assert.equal(qCfg.notifyQuestion, false, '提问通知默认关闭')
assert.equal(qCfg.titleQuestion, 'DSH 等待你的决定', '默认提问标题')
assert.equal(qCfg.priorityQuestion, 8, '提问优先级默认与失败同档（会话停摆等人）')
assert.equal(
  resolveConfig(resolved({ url: 'https://gotify.21zys.com', titleQuestion: '  ' })).titleQuestion,
  'DSH 等待你的决定',
  '空提问标题回落默认值',
)
assert.equal(
  resolveConfig(resolved({ url: 'https://gotify.21zys.com', priorityQuestion: 99 })).priorityQuestion,
  8,
  '越界的提问优先级回落默认档',
)
assert.equal(reasonLabel('awaiting-input'), '等待用户输入', '提问通知的 {reason} 中文标签')
const qTurnCfg = resolveConfig(resolved({ url: 'https://gotify.21zys.com', minTurn: 3 }))
assert.equal(shouldNotifyQuestion(2, qTurnCfg), false, '低于门槛的提问不推')
assert.equal(shouldNotifyQuestion(3, qTurnCfg), true, '达到门槛的提问放行')
assert.equal(shouldNotifyQuestion(undefined, qTurnCfg), true, '轮次缺失的提问放行（与 shouldNotify 同口径）')
assert.equal(shouldNotifyQuestion('2', qTurnCfg), true, '非数字轮次不拦')
assert.equal(
  render(qCfg.questionMessage, { title: '演示会话', turn: 2, reason: reasonLabel('awaiting-input'), cwd: 'desktop', time: '2026/1/1 00:00:00' }),
  '会话 演示会话 在等你做决定（第 2 轮）\n目录：desktop\n时间：2026/1/1 00:00:00',
  '默认提问正文应渲染出标题/轮次/目录/时间与换行',
)

// 13) Gotify 客户端：token 缓存随服务器地址失效、401 清缓存重取、请求带超时信号。
//     全部走桩 fetch，不发真实网络请求。
const realFetch = globalThis.fetch
const calls = []
/** 一台假服务器：`/application` 返回固定 token，`/message` 按脚本回答。 */
function stubServer({ token = 'tok-1', messageStatus = [200] } = {}) {
  return async (url, init = {}) => {
    const href = String(url)
    calls.push({ href, init })
    if (href.endsWith('/application')) {
      return { ok: true, status: 200, json: async () => [{ name: 'DSH', token }] }
    }
    const status = messageStatus.length > 1 ? messageStatus.shift() : messageStatus[0]
    return { ok: status >= 200 && status < 300, status, json: async () => ({}) }
  }
}
const credentials = { user: 'admin', password: 'p@ss' }
const pushPayload = { title: 't', message: 'm', priority: 1 }
try {
  // 13a) 同一服务器：token 只取一次，后续推送复用缓存。
  calls.length = 0
  const client = new GotifyClient(undefined)
  globalThis.fetch = stubServer({ token: 'tok-a' })
  const cfgA = resolveConfig(resolved({ url: 'https://a.example' }))
  assert.equal((await client.push(cfgA, credentials, pushPayload)).status, 200, '首次推送应成功')
  assert.equal(calls.filter((c) => c.href.endsWith('/application')).length, 1, '首次推送应取一次 token')
  await client.push(cfgA, credentials, pushPayload)
  assert.equal(calls.filter((c) => c.href.endsWith('/application')).length, 1, '同一 url 再推不应重取 token')
  assert.equal(calls.length, 3, '两次推送共 1 次取 token + 2 次发消息')
  assert.ok(calls.every((c) => c.init.signal instanceof AbortSignal), '每次请求都应带超时信号')

  // 13b) 换服务器：旧 token 必须作废，重新 /application（否则会一直 401）。
  globalThis.fetch = stubServer({ token: 'tok-b' })
  const cfgB = resolveConfig(resolved({ url: 'https://b.example' }))
  calls.length = 0
  await client.push(cfgB, credentials, pushPayload)
  assert.equal(calls.filter((c) => c.href.endsWith('/application')).length, 1, '换 url 后应重新取 token')
  assert.ok(calls.some((c) => c.href.includes('token=tok-b')), '应使用新服务器的 token 推送')

  // 13c) 401：清缓存重取一次再试（token 被吊销的场景）。
  calls.length = 0
  globalThis.fetch = stubServer({ token: 'tok-c', messageStatus: [401, 200] })
  const cfgC = resolveConfig(resolved({ url: 'https://c.example' }))
  assert.equal((await client.push(cfgC, credentials, pushPayload)).status, 200, '401 后重取 token 应成功')
  assert.equal(calls.filter((c) => c.href.endsWith('/application')).length, 2, '401 应触发一次重取')
  assert.equal(calls.filter((c) => c.href.includes('/message')).length, 2, '401 后应重试一次推送')

  // 13d) 直接配置 token 时无法重取，401 原样报错。
  calls.length = 0
  globalThis.fetch = stubServer({ messageStatus: [401] })
  const cfgToken = resolveConfig(resolved({ url: 'https://d.example', token: 'fixed' }))
  await assert.rejects(() => client.push(cfgToken, credentials, pushPayload), /HTTP 401/, '自带 token 的 401 应直接报错')
  assert.equal(calls.length, 1, '自带 token 时不应触发重取')

  // 13e) 失败日志带上底层 errno，且不泄露凭据。
  const logs = []
  const logged = new GotifyClient({ error: (line) => logs.push(line) })
  const networkError = new TypeError('fetch failed')
  networkError.cause = { code: 'ECONNREFUSED' }
  logged.report(networkError)
  assert.equal(logs.length, 1, 'report 应写一行日志')
  assert.ok(logs[0].includes('fetch failed') && logs[0].includes('ECONNREFUSED'), '日志应带错误码便于诊断')
  assert.ok(!logs[0].includes('p@ss'), '日志不得泄露口令')
} finally {
  globalThis.fetch = realFetch
}

// 14) 回环 Host 的尾点写法（FQDN 形式）应被当作 localhost，而不是被 403 误伤。
assert.equal(sameOriginRequest(mockReq({ host: 'localhost.:19387' })), true, '带尾点的 localhost 也应是回环权威')
assert.equal(sameOriginRequest(mockReq({ host: 'evil.example.com.:19387' })), false, '带尾点的外部域名仍应拒绝')

console.log('selfcheck 通过：Config 16 个 volatile 字段、url/凭据（凭据服务优先）/模板/会话标题/结束原因中文化/错误详情/测试路由围栏/触发判定真值表/提问通知档/Gotify 客户端缓存与重取均符合预期。')
