/**
 * 非交互自检（浏览器半）：用桩件真正加载 `client/client.js` 的
 * `window.__ModuleLoader__` 工厂，验证它注册到了正确的槽位与键，
 * 并走一遍「编辑 → 保存」「开关立即写入」「原因勾选」「口令写入凭据域」
 * 与「取不到表单」这几条调用链。
 *
 * 组件树只做最小求值：用桩 React 渲染配置卡与「发送测试通知」按钮，核对官方组件
 * （SettingsForm / SettingsValueField / SettingsSecretField）的 props 读取点与五种
 * 测试结局的文案；真实样式与交互仍需人工确认。
 *
 * 用法：node selfcheck-client.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { REASON_KINDS, reasonLabel } from './lib/index.js'

/* ---------------------------------------------------------------- 桩件 */

/** 记录每一次 mutate 调用（含被拒绝的那些）。 */
const mutations = []

/** 按发生顺序记录 mutate 与凭据写入，用于校验「先写配置、再写口令」的时序。 */
const callLog = []

/**
 * 假的配置表单：持有 value/user，记录 mutate，并支持注入故障与只读态
 * （`failNext` / `setWritable`），以便覆盖失败路径 —— 只测成功路径会漏掉
 * 「一次异常把勾选链变成永久拒绝」这类缺陷。
 * @param namespace - 命名空间。
 * @param initial - 初始配置值。
 */
function makeScope(namespace, initial) {
  let value = { ...initial.value }
  let user = { ...(initial.user ?? {}) }
  let writable = true
  let failMode = undefined
  const listeners = new Set()
  return {
    getSnapshot: () => ({ status: 'ready', value: { ...value }, user: { ...user }, revision: 7, writable }),
    subscribe: listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    /** 让下一次 mutate 抛错（`'reject'`）或返回 false（`'false'`）。 */
    failNext: mode => {
      failMode = mode
    },
    setWritable: next => {
      writable = next
    },
    mutate: async (ops, revision) => {
      mutations.push({ namespace, ops, revision })
      if (failMode === 'reject') {
        failMode = undefined
        throw new Error('mutate 被拒绝（桩）')
      }
      if (failMode === 'false') {
        failMode = undefined
        return false
      }
      callLog.push({ kind: 'mutate', ops })
      for (const op of ops) {
        if (op.op === 'set') {
          value[op.path[0]] = op.value
          user[op.path[0]] = op.value
        } else if (op.op === 'unset') {
          delete value[op.path[0]]
          delete user[op.path[0]]
        }
      }
      for (const listener of listeners) listener()
      return true
    },
  }
}

/**
 * 极简 SettingsFormModel：语义照抄官方实现里与控制器相关的那几条（依据 `app.asar` 内
 * 官方 `SettingsFormModel.save()`：先 `mutate` 配置操作、再依次跑 `run()`）——
 * 只要有字段解析不出操作，整单非法、`save()` 直接返回且草稿保留；
 * 合法时先写配置操作、再跑 secret 的 `run()`。
 *
 * 桩件与真身不一致会让断言变成「只证明桩自己」：早先的版本把非法字段
 * 悄悄跳过并继续写其它字段，正好掩盖了整单拒绝这条真实语义。
 */
class StubFormModel {
  constructor(scope, specs, secrets = []) {
    this.scope = scope
    this.specs = specs
    this.secrets = secrets
    this.staged = new Map()
    this.baseline = undefined
    this.saving = false
    this.failed = false
  }

  bind(project) {
    this.project = project
    return {
      set: () => {},
      getSnapshot: () => project(),
    }
  }

  /** 把草稿编译成计划项：secret 字段产出 `run`，其余产出配置操作（非法则为 undefined）。 */
  #plan() {
    const items = []
    for (const [field, text] of this.staged) {
      const secret = this.secrets.find(entry => entry.field === field)
      if (secret !== undefined) {
        items.push({ field, run: () => secret.write(text) })
        continue
      }
      const parsed = this.specs.find(entry => entry.field === field)?.parse(text)
      items.push({
        field,
        op: parsed === undefined
          ? undefined
          : (parsed.kind === 'clear' ? { op: 'unset', path: [field] } : { op: 'set', path: [field], value: parsed.value }),
      })
    }
    return items
  }

  shell() {
    const plan = this.#plan()
    return {
      available: true,
      writable: this.scope.getSnapshot().writable === true,
      dirty: plan.length > 0,
      invalid: plan.some(item => item.run === undefined && item.op === undefined),
      saving: this.saving,
      failed: this.failed,
    }
  }

  field(name) {
    const staged = this.staged.get(name)
    const secret = this.secrets.some(entry => entry.field === name)
    const spec = this.specs.find(entry => entry.field === name)
    return {
      text: staged ?? this.#formatted(name),
      overridden: Object.hasOwn(this.scope.getSnapshot().user ?? {}, name),
      invalid: staged !== undefined && !secret && spec?.parse(staged) === undefined,
    }
  }

  actions() {
    return {
      edit: (field, text) => {
        this.staged.set(field, text)
        this.baseline ??= this.scope.getSnapshot()
      },
      resetField: field => {
        this.staged.delete(field)
        this.baseline ??= this.scope.getSnapshot()
      },
      save: () => this.save(),
      discard: () => {
        this.staged.clear()
      },
    }
  }

  async save() {
    const plan = this.#plan()
    if (plan.some(item => item.run === undefined && item.op === undefined)) return false
    const ops = plan.flatMap(item => (item.op === undefined ? [] : [item.op]))
    this.saving = true
    let landed = ops.length === 0 || (await this.scope.mutate(ops, this.baseline?.revision))
    for (const item of plan) {
      if (item.run !== undefined) landed = (await item.run()) && landed
    }
    this.saving = false
    this.failed = landed !== true
    if (landed === true) this.staged.clear()
    return landed
  }

  dispose() {}

  #formatted(name) {
    const value = this.scope.getSnapshot().value?.[name]
    const spec = this.specs.find(entry => entry.field === name)
    if (spec !== undefined) return spec.format(value)
    return typeof value === 'string' ? value : ''
  }
}

const primitivesStub = {
  SettingsForm: function SettingsForm() {},
  SettingsValueField: function SettingsValueField() {},
  SettingsSecretField: function SettingsSecretField() {},
  SettingsFormModel: StubFormModel,
  settingsTextField: field => ({
    field,
    format: value => (typeof value === 'string' ? value : ''),
    parse: text => (text.trim() === '' ? { kind: 'clear' } : { kind: 'set', value: text.trim() }),
  }),
  settingsNumberField: field => ({
    field,
    format: value => (typeof value === 'number' ? String(value) : ''),
    parse: text => {
      const parsed = Number(text.trim())
      return Number.isFinite(parsed) ? { kind: 'set', value: parsed } : undefined
    },
  }),
  Checkbox: function Checkbox() {},
  Button: function Button() {},
}

/**
 * 极简 React 替身：`createElement` 保留 props 与 children，`useState` 按「同一次渲染内的
 * 调用序号」存状态 —— 够驱动单个函数组件（渲染 → 触发事件 → 再渲染）。真实 React 由
 * 宿主提供，这里只为能在自检里点到「发送测试通知」按钮并读到它写出的提示文案。
 */
let hookSlots = []
let hookCursor = 0
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: initial => {
    const index = hookCursor++
    if (hookSlots[index] === undefined) hookSlots[index] = { value: initial }
    return [hookSlots[index].value, next => {
      hookSlots[index].value = typeof next === 'function' ? next(hookSlots[index].value) : next
    }]
  },
  useEffect: () => {},
  useRef: () => ({ current: undefined }),
}

/** 渲染一个函数组件：重置 hook 游标但保留槽位，等价于一次重渲染。 */
const renderComponent = (component, props) => {
  hookCursor = 0
  return component(props)
}

/** 深度优先摊平渲染树，便于查找按钮与状态行。 */
const flatten = (node, out = []) => {
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out)
    return out
  }
  if (node === null || node === undefined || typeof node !== 'object') return out
  out.push(node)
  for (const child of node.children ?? []) flatten(child, out)
  return out
}

/** 取元素的文本子节点（本自检里状态行只有一个字符串子节点）。 */
const textOf = node => (node.children ?? []).filter(child => typeof child === 'string').join('')

/** 让已排队的微任务跑完（控制器的凭据回读是异步的）。 */
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

/** 默认引用名，须与 client.js 里的 DEFAULT_PASSWORD_REF 一致。 */
const DEFAULT_REF = 'GOTIFY_PASSWORD'

/**
 * 假冒的凭据域：`describe` 按引用答复「是否已配置」，`set`/`unset` 记下来。
 * 与宿主真实契约一致 —— `describe` 返回 `{ ok, value: { [ref]: { configured, writable } } }`，
 * `set` 不返回口令本身。可注入一次失败，覆盖凭据域不可用时的分支。
 * @param initial - 初始已配置的引用表。
 */
function makeCredentials(initial = {}) {
  const store = new Map(Object.entries(initial))
  const calls = { describe: [], set: [], unset: [] }
  let failDescribe = false
  let failSet = false
  return {
    calls,
    failDescribe: () => {
      failDescribe = true
    },
    failSet: () => {
      failSet = true
    },
    api: {
      describe: async refs => {
        calls.describe.push([...refs])
        if (failDescribe) {
          failDescribe = false
          throw new Error('凭据域不可用（桩）')
        }
        return {
          ok: true,
          value: Object.fromEntries(refs.map(ref => [ref, { configured: store.has(ref), writable: true }])),
        }
      },
      set: async (ref, value) => {
        calls.set.push([ref, value])
        callLog.push({ kind: 'secret.set', ref })
        if (failSet) {
          failSet = false
          return { ok: false }
        }
        store.set(ref, value)
        return { ok: true }
      },
      unset: async ref => {
        calls.unset.push(ref)
        store.delete(ref)
        return { ok: true }
      },
    },
  }
}

/* ------------------------------------------------------------- 加载被测件 */

const registered = []
const effects = []
const dictionaries = []
const credentialEvents = []
const credentials = makeCredentials()
let scope = undefined

const ctx = {
  effect: (factory, label) => {
    effects.push(label)
    const disposer = factory()
    return disposer
  },
  locale: {
    bind: () => key => `t:${key}`,
    register: (namespace, dictionary) => {
      dictionaries.push({ namespace, dictionary })
      return () => {}
    },
  },
  remote: {
    credentials: credentials.api,
    $on: (event, handler) => {
      credentialEvents.push({ event, handler })
      return () => {}
    },
  },
  slots: {
    inject: (name, register) => {
      registered.push({ name, entry: register() })
      return () => {}
    },
    register: (options, component) => ({ options, component }),
  },
  configForms: {
    describe: () => ({
      getSnapshot: () => ({
        view: {
          namespaces: [
            { ns: 'gotify-notify', secrets: [{ path: ['password'], set: true }] },
          ],
        },
      }),
    }),
    get: id => {
      assert.equal(id, 'gotify-notify', '应绑定到 insert 行的 id')
      scope ??= makeScope(id, { value: {
        url: 'https://gotify.21zys.com',
        priorityCompleted: 5,
        // 末尾带一个宿主半未收录的未知取值，验证勾选写回不会丢掉它。
        notifyReasons: ['completed', 'error', 'blocked', 'aborted', 'interrupted', 'max-tokens', 'future-kind'],
      } })
      return scope
    },
  },
}

const requireStub = name => {
  if (name === 'react') return reactStub
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
  throw new Error(`自检未提供 require 桩：${name}`)
}

let loaded
const window = {
  __ModuleLoader__: {
    load: spec => {
      loaded = spec
    },
  },
}

const source = readFileSync(new URL('./client/client.js', import.meta.url), 'utf8')
// 浏览器半是给浏览器内核用的脚本，这里用 new Function 提供 window / require 两个自由变量。
const run = new Function('window', 'require', `${source}\nreturn undefined`)
run(window, requireStub)

/* --------------------------------------------------------------- 断言 */

assert.ok(loaded !== undefined, 'client.js 必须调用 window.__ModuleLoader__.load')
assert.equal(loaded.id, 'dsh-gotify-notify', '模块 id 必须是裸包名')
assert.equal(typeof loaded.factory, 'function')
const half = loaded.factory(requireStub)
assert.deepEqual(
  half.inject,
  ['slots', 'locale', 'remote', 'remote.credentials', 'configForms'],
  'inject 必须声明用到的服务（凭据域与官方网页搜索设置页一致）',
)
assert.equal(typeof half.apply, 'function')

half.apply(ctx)

// 0) 双份清单一致性 + 两套字典齐备。
const reasonsBlock = source.match(/const REASONS = \[([^\]]*)\]/)?.[1] ?? ''
const reasonKinds = [...reasonsBlock.matchAll(/'([\w-]+)'/g)].map(match => match[1])
assert.deepEqual(reasonKinds, REASON_KINDS, 'client 的 REASONS 必须与宿主半 REASON_KINDS 完全一致（含顺序）')

assert.equal(dictionaries.length, 1, '应只注册一个 locale 命名空间')
const [entry] = dictionaries
assert.match(entry.namespace, /^settings\./, 'locale 命名空间应形如 settings.xxx')
const zh = entry.dictionary?.zh
const en = entry.dictionary?.en
assert.ok(zh !== undefined && en !== undefined, '中英两套字典都必须登记（缺一套会在该语言的界面上显示原始键名）')
assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'zh 与 en 的键集必须完全一致')
assert.equal(Object.values(zh).every(text => typeof text === 'string' && text !== ''), true, '中文文案不允许为空')
assert.equal(Object.values(en).every(text => typeof text === 'string' && text !== ''), true, '英文文案不允许为空')
// 空对象的 every() 恒真：先钉住非空，免得上面两条将来退化成真空真。
assert.ok(Object.keys(zh).length >= 50, `字典键数异常（${Object.keys(zh).length}）`)
// 宿主半收录的每个原因都要有中文标签，且与宿主半的标签逐项一致。
const reasonKey = kind => `reason${kind.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join('')}`
for (const kind of REASON_KINDS) {
  assert.equal(zh[reasonKey(kind)], reasonLabel(kind), `${kind} 的中文标签必须与宿主半 reasonLabel 一致`)
}
// 字典键的双向检查：源码里静态写的每个 t('x') 都必须在字典里存在（拼错键名不会报错，
// 只会在界面上把原始键名显示出来），字典里的每个键也必须有读取点（改版删掉界面文案后
// 留下的死键会静默堆积）。两侧都按「去掉注释后的源码」判定，否则注释里写出来的
// t('…') 示例会同时污染正反两个方向：既会被当成读取点，又会被要求必须有对应文案。
// 逐字符扫描：注释整段丢掉，字符串与模板字面量**原样保留**（不能清空内容——`t('key')` 的
// 键名本身就在字符串里），因此字符串里的 `//` 不会被误判成注释。已知取舍：普通字符串字面量
// 里写的 `t('x')` 会被当成读取点（死键检查偏松），真实源码里没有这种写法。
const stripComments = code => {
  let out = ''
  let mode = 'code'
  let quote = ''
  let braces = 0
  for (let i = 0; i < code.length; i += 1) {
    const char = code[i]
    const next = code[i + 1]
    if (mode === 'string') {
      if (char === '\\') { out += char + (next ?? ''); i += 1; continue }
      if (char === quote) mode = 'code'
      out += char
      continue
    }
    if (mode === 'template') {
      if (char === '`') { mode = 'code'; out += char; continue }
      if (char === '$' && next === '{') { mode = 'code'; braces += 1; out += '${'; i += 1; continue }
      out += char
      continue
    }
    if (char === '/' && next === '/') { while (i < code.length && code[i] !== '\n') i += 1; out += '\n'; continue }
    if (char === '/' && next === '*') { i += 2; while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) i += 1; i += 1; out += ' '; continue }
    if (char === "'" || char === '"') { mode = 'string'; quote = char; out += char; continue }
    if (char === '`') { mode = 'template'; out += char; continue }
    if (char === '{' && braces > 0) { braces += 1; out += char; continue }
    if (char === '}' && braces > 0) { braces -= 1; mode = 'template'; out += char; continue }
    out += char
  }
  return out
}
// 先自证扫描器：注释里的键必须消失；同一行里字符串之后的键、以及模板插值里的键必须留下。
const commentProbe = stripComments([
  "// t('inLineComment')",
  "const url = 'https://example.com/x'; const a = t('afterUrl')",
  "/* t('inBlockComment') */",
  "const b = `${t('inTemplate')}`",
].join('\n'))
for (const key of ['inLineComment', 'inBlockComment']) {
  assert.equal(commentProbe.includes(key), false, `注释里的键不应被算作引用：${key}`)
}
for (const key of ['afterUrl', 'inTemplate']) {
  assert.ok(commentProbe.includes(key), `去注释后必须保留代码里的键：${key}`)
}

const codeSource = stripComments(source)
const referencedKeys = [...codeSource.matchAll(/\bt\('([^']+)'\)/g)].map(match => match[1])
assert.ok(referencedKeys.length >= 40, `只抓到 ${referencedKeys.length} 个 t('…') 引用，正则可能已失效`)
for (const key of new Set(referencedKeys)) {
  assert.ok(zh[key] !== undefined, `字典缺少源码引用的键：${key}`)
}
// 动态拼接的键（reasonXxx 由 reasonKey(kind) 生成）没有字面量读取点，按规则单独枚举；
// title 由官方卡片外壳按约定读取（自检里的表单外壳替身并不读它），是唯一的既有例外。
const dynamicKeys = new Set(REASON_KINDS.map(reasonKey))
const unreadKeys = Object.keys(zh).filter(key => !dynamicKeys.has(key) && !referencedKeys.includes(key))
assert.deepEqual(unreadKeys, ['title'], '字典里存在既无字面量读取点、也不属于动态键与 title 约定的键（死键）')

// 1) 注册到了 plugins.row.config，且键是「包名#行 id」。
const card = registered.find(entry => entry.name === 'plugins.row.config')
assert.ok(card !== undefined, '必须注册 plugins.row.config')
assert.equal(card.entry.options.key, 'dsh-gotify-notify#gotify-notify', '键必须是 <包名>#<行 id>')
assert.match(String(card.entry.options.locale), /^settings\./, 'locale 命名空间应形如 settings.xxx')
assert.ok(
  credentialEvents.some(entry => entry.event === 'credentials/reference-updated'),
  '应订阅凭据变更事件（同一个引用可能在模型页被写）',
)

// 2) 注入面：hook + 四个动作 + setFlag + toggleReason。
assert.equal(typeof card.entry.options.inject, 'function', 'inject 应是函数')
const injected = card.entry.options.inject()
for (const key of ['edit', 'resetField', 'save', 'discard', 'setFlag', 'toggleReason']) {
  assert.ok(injected[key] !== undefined, `inject() 缺少 ${key}`)
}
assert.ok(injected.hooks?.gotifyNotifyCard !== undefined, 'inject() 缺少 hooks.gotifyNotifyCard')

/** 取当前投影（store.getSnapshot 每次现算）。 */
const snapshot = () => injected.hooks.gotifyNotifyCard.getSnapshot()

// 3) 快照里既有表单外壳字段，也有各控件状态与开关/原因组。
for (const key of ['available', 'writable', 'dirty', 'invalid', 'saving', 'failed', 'url', 'urlSaved', 'passwordEnv', 'priorityCompleted', 'priorityError', 'priorityQuestion', 'minTurn', 'message', 'questionMessage', 'titleQuestion', 'passwordConfigured', 'passwordWritable', 'passwordRef', 'notifyReasons', 'notifyQuestion', 'includeSubagents']) {
  assert.ok(key in snapshot(), `投影缺少 ${key}`)
}
assert.equal(snapshot().url.text, 'https://gotify.21zys.com', 'url 应从配置值回填')
assert.equal(snapshot().urlSaved, 'https://gotify.21zys.com', 'urlSaved 应反映已保存的 url')
assert.equal(snapshot().priorityCompleted.text, '5', 'priorityCompleted 应从配置值回填')
await flush()
assert.equal(snapshot().passwordConfigured, false, '凭据域还没报已配置时应视为未配置')

// 4) 「编辑 + 保存」走一次 mutate，路径与值正确，且带 revision。
injected.edit('url', 'https://gotify.example.com')
assert.equal(snapshot().dirty, true, '有草稿时应报 dirty')
assert.equal(snapshot().urlSaved, 'https://gotify.21zys.com', '草稿未保存前 urlSaved 不应跟着变（测试按钮打的是已保存配置）')
await injected.save()
assert.deepEqual(mutations.at(-1).ops, [{ op: 'set', path: ['url'], value: 'https://gotify.example.com' }])
assert.equal(mutations.at(-1).revision, 7, '应带上读到的 revision')
assert.equal(snapshot().dirty, false, '保存成功后草稿应清空')
assert.equal(snapshot().urlSaved, 'https://gotify.example.com', '保存后 urlSaved 应更新')

// 5) 非法草稿让整单落空：不产生任何 mutate，草稿保留。
const beforeIllegal = mutations.length
injected.edit('priorityCompleted', '99')
assert.equal(snapshot().invalid, true, '越界数字应报 invalid')
await injected.save()
assert.equal(mutations.length, beforeIllegal, '非法草稿不应写配置')
assert.equal(snapshot().invalid, true, '非法草稿应保留给用户修改')
injected.edit('url', 'https://draft.example.com')
await injected.save()
assert.equal(mutations.length, beforeIllegal, '只要有一个字段非法，整单都不写')
injected.discard()
assert.equal(snapshot().dirty, false, 'discard 后应清空草稿')
assert.equal(snapshot().url.text, 'https://gotify.example.com', 'discard 后回到已保存值')

// 6) 布尔开关与原因勾选都是立即写入；未知取值原样保留，不被面板悄悄删掉。
await injected.setFlag('includeSubagents', true)
assert.deepEqual(mutations.at(-1).ops, [{ op: 'set', path: ['includeSubagents'], value: true }])
await injected.setFlag('notifyQuestion', true)
assert.deepEqual(mutations.at(-1).ops, [{ op: 'set', path: ['notifyQuestion'], value: true }])
await injected.toggleReason('forked', true)
assert.deepEqual(
  mutations.at(-1).ops,
  [{ op: 'set', path: ['notifyReasons'], value: ['completed', 'error', 'blocked', 'aborted', 'interrupted', 'max-tokens', 'forked', 'future-kind'] }],
  '勾上 forked 应整组写回，未知取值追加在尾部保留',
)
await injected.toggleReason('completed', false)
assert.deepEqual(
  mutations.at(-1).ops,
  [{ op: 'set', path: ['notifyReasons'], value: ['error', 'blocked', 'aborted', 'interrupted', 'max-tokens', 'forked', 'future-kind'] }],
  '取消勾选应把该项移出集合，未知取值仍保留',
)
assert.equal(mutations.every(record => record.revision === 7), true, '每次立即写入都应带上读到的 revision')

// 7) 失败路径：写入抛错只折成 false，且勾选链仍可继续（链一旦 rejected 就永久失效）。
const beforeFail = mutations.length
scope.failNext('reject')
assert.equal(await injected.toggleReason('aborted', false), false, '写入抛错应返回 false 而不是把异常抛给槽位')
assert.equal(mutations.length, beforeFail + 1, '抛错的那次也算一次尝试')
assert.equal(await injected.toggleReason('aborted', false), true, '一次失败之后勾选必须仍然可用')
assert.deepEqual(
  mutations.at(-1).ops,
  [{ op: 'set', path: ['notifyReasons'], value: ['error', 'blocked', 'interrupted', 'max-tokens', 'forked', 'future-kind'] }],
  '重试应写回当前集合',
)

// 8) 只读态：立即写入直接放弃，不产生 mutate，也不抛错。
scope.setWritable(false)
const beforeReadOnly = mutations.length
assert.equal(await injected.setFlag('includeSubagents', false), false, '只读时开关写入应返回 false')
assert.equal(mutations.length, beforeReadOnly, '只读时不应调用 mutate')
assert.equal(await injected.setFlag('includeSubagents', true), false, '只读时开关（第二次）同样应放弃')
assert.equal(mutations.length, beforeReadOnly, '只读时不应调用 mutate')
scope.setWritable(true)

// 9) 口令不进配置文件：保存它只写凭据域，不产生任何 mutate。
const beforeSecret = mutations.length
injected.edit('password', 's3cret')
await injected.save()
await flush()
assert.equal(mutations.length, beforeSecret, '口令保存不应改写 cordis.patch.yml')
assert.deepEqual(credentials.calls.set, [[DEFAULT_REF, 's3cret']], '口令应写进凭据库的默认引用名下')
assert.equal(snapshot().passwordConfigured, true, '写入后 describe 回读应报已配置')

// 10) 同一次保存里既改引用名又填口令：口令必须落到改完之后的引用名下。
credentials.calls.set.length = 0
const logBefore = callLog.length
injected.edit('passwordEnv', 'GOTIFY_PASSWORD_ALT')
injected.edit('password', 's3cret2')
await injected.save()
await flush()
assert.deepEqual(credentials.calls.set, [['GOTIFY_PASSWORD_ALT', 's3cret2']], '口令应写到新引用名下（先落配置、再写凭据）')
const order = callLog.slice(logBefore).map(record => record.kind)
assert.equal(order.at(-1), 'secret.set', '口令写入应是这次保存的最后一步')
assert.equal(order.includes('mutate'), true, '改引用名应产生一次配置写入')
assert.equal(order.indexOf('mutate') < order.lastIndexOf('secret.set'), true, '配置写入必须早于口令写入')
assert.deepEqual(credentials.calls.describe.at(-1), ['GOTIFY_PASSWORD_ALT'], '改引用名后应按新名字重新查询')
assert.equal(snapshot().passwordRef, 'GOTIFY_PASSWORD_ALT')
assert.equal(snapshot().passwordConfigured, true, '新引用名下已有口令')

// 11) 凭据域不可用：只读侧静默降级，不抛异常，也不谎报已配置。
credentials.failDescribe()
injected.edit('passwordEnv', 'GOTIFY_PASSWORD_B')
await injected.save()
await flush()
assert.equal(snapshot().passwordRef, 'GOTIFY_PASSWORD_B', '引用名应已切到新名字')
assert.equal(snapshot().passwordConfigured, false, 'describe 失败时不应谎报已配置')
assert.equal(snapshot().passwordWritable, true, 'describe 失败时保留「可写」这一乐观默认')

// 12) 一个候选命名空间都取不到表单：不注册空壳卡片，也不让异常冒到插槽里。
const brokenCards = []
const brokenHalf = loaded.factory(requireStub)
brokenHalf.apply({
  effect: (factory, label) => {
    effects.push(label)
    return factory()
  },
  locale: { bind: () => key => key, register: () => () => {} },
  remote: { credentials: credentials.api, $on: () => () => {} },
  slots: {
    inject: (name, register) => {
      brokenCards.push({ name, entry: register() })
      return () => {}
    },
    register: (options, component) => ({ options, component }),
  },
  configForms: {
    describe: () => {
      throw new Error('配置镜像不可用（桩）')
    },
    get: () => {
      throw new Error('表单取不到（桩）')
    },
  },
})
assert.equal(brokenCards.length, 0, '取不到表单时不应注册卡片')

// 13) 「发送测试通知」按钮：草稿未保存时不动网络，未保存挡下/成功/宿主报错/超时/网络错误
// 五条路径的文案，以及请求必须带兜底超时信号（宿主路由最坏情况要串 3 次 Gotify 请求）。
const cardEntry = registered.find(entry => entry.name === 'plugins.row.config')
assert.equal(typeof cardEntry?.entry.component, 'function', '槽位注册必须带卡片组件')
const t = key => `t:${key}`
const cardProps = {
  view: 'page',
  t,
  useGotifyNotifyCard: selector => selector(snapshot()),
  edit: injected.edit,
  resetField: injected.resetField,
  save: injected.save,
  discard: injected.discard,
  setFlag: injected.setFlag,
  toggleReason: injected.toggleReason,
}
const testElement = flatten(renderComponent(cardEntry.entry.component, cardProps))
  .find(node => typeof node.type === 'function' && node.type.name === 'TestNotification')
assert.ok(testElement !== undefined, '卡片页必须渲染「发送测试通知」按钮组件')

const fetchCalls = []
let fetchHandler = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })
globalThis.fetch = async (input, init) => {
  fetchCalls.push({ input, init })
  return fetchHandler(input, init)
}

/** 渲染按钮组件 → 点一次 → 等异步跑完 → 再渲染并读出状态行文案。 */
async function clickTest(state) {
  const before = flatten(renderComponent(testElement.type, { t, state }))
  const button = before.find(node => typeof node.props.onClick === 'function')
  assert.ok(button !== undefined, '测试按钮必须带 onClick')
  button.props.onClick()
  await flush()
  await flush()
  const after = flatten(renderComponent(testElement.type, { t, state }))
  const status = after.find(node => node.props.role === 'status')
  return status === undefined ? '' : textOf(status)
}

// 13.1 草稿未保存：直接提示，且不发起任何请求。
injected.edit('url', 'https://draft.example.com')
assert.equal(snapshot().dirty, true, '改过草稿后 dirty 应为 true')
assert.equal(await clickTest(snapshot()), 't:testUnsaved', '草稿未保存时应提示先保存')
assert.equal(fetchCalls.length, 0, '草稿未保存时不应发起请求')
await injected.discard()
assert.equal(snapshot().dirty, false, '丢弃草稿后应回到已保存状态')

// 13.2 成功：POST 到宿主注册的同源路由，并带上兜底超时信号。
fetchHandler = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })
assert.equal(await clickTest(snapshot()), 't:testOk', '成功时应提示已发送')
assert.equal(fetchCalls.length, 1, '成功路径应只请求一次')
assert.equal(fetchCalls[0].input, '/gotify-notify/test', '测试请求必须打宿主注册的路由')
assert.equal(fetchCalls[0].init.method, 'POST', '测试请求应是 POST')
assert.equal(fetchCalls[0].init.signal instanceof AbortSignal, true, '测试请求必须带兜底超时信号')

// 13.3 宿主报错：透出宿主给的错误原文，并带上「测试失败：」前缀。
fetchHandler = async () => ({ ok: false, status: 500, json: async () => ({ ok: false, error: '推送失败：HTTP 500' }) })
assert.equal(await clickTest(snapshot()), 't:testFailed推送失败：HTTP 500', '宿主报错时应透出原文')

// 13.4 超时：AbortSignal.timeout 以 TimeoutError 结束，显示超时提示而不是 DOMException 原文。
fetchHandler = async () => {
  const error = new Error('The operation was aborted due to timeout')
  error.name = 'TimeoutError'
  throw error
}
assert.equal(await clickTest(snapshot()), 't:testFailedt:testTimeout', '超时时应显示可读的超时提示')

// 13.5 其它网络错误：仍然透出原文（fetch 失败信息对用户是可读的）。
fetchHandler = async () => { throw new TypeError('fetch failed') }
assert.equal(await clickTest(snapshot()), 't:testFailedfetch failed', '网络错误时应透出原文')

// 14) 官方组件的 props 契约：自检里的官方组件是空函数，prop 名写错不会报错、只会在真实界面里
//     丢内容。这里按 asar 内 primitives 实现的读取点逐项核对。
const cardNodes = flatten(renderComponent(cardEntry.entry.component, cardProps))
const nodesNamed = name => cardNodes.filter(node => typeof node.type === 'function' && node.type.name === name)
const formNode = nodesNamed('SettingsForm')[0]
assert.ok(formNode !== undefined, '卡片页必须渲染官方 SettingsForm')
assert.deepEqual(
  Object.keys(formNode.props.labels).sort(),
  ['readOnly', 'save', 'saveFailed', 'saving', 'unavailable'],
  'SettingsForm 的 labels 必须提供官方读取的五个键',
)
for (const flag of ['dirty', 'invalid', 'saving', 'writable', 'failed']) {
  assert.equal(flag in formNode.props.state, true, `SettingsForm 读 state.${flag}，卡片必须提供`)
}
for (const action of ['onSave', 'onDiscard']) {
  assert.equal(typeof formNode.props[action], 'function', `SettingsForm 读 ${action}，必须是函数`)
}
const valueNodes = nodesNamed('SettingsValueField')
assert.ok(valueNodes.length >= 8, `卡片页应渲染多个文本/数值字段，实际 ${valueNodes.length}`)
for (const node of valueNodes) {
  for (const name of ['id', 'label', 'hint', 'text', 'invalid', 'disabled', 'onEdit', 'onReset', 'overriddenLabel', 'resetLabel', 'invalidLabel']) {
    assert.equal(node.props[name] !== undefined, true, `SettingsValueField 读 ${name}，「${String(node.props.id)}」未提供`)
  }
}
const secretNode = nodesNamed('SettingsSecretField')[0]
assert.ok(secretNode !== undefined, '卡片页应渲染口令字段')
for (const name of ['id', 'label', 'hint', 'text', 'disabled', 'configured', 'stateLabel', 'onEdit']) {
  assert.equal(secretNode.props[name] !== undefined, true, `SettingsSecretField 读 ${name}，未提供`)
}

console.log('selfcheck-client 通过：字典（中/英）、槽位键、注入面、投影、官方组件 props 契约、保存与非法草稿、开关/原因勾选的失败路径、凭据写入时序与降级、测试通知的五种结局均符合预期。')
