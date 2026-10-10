/**
 * 非交互自检（浏览器半）：用桩件真正加载 `client/client.js` 的
 * `window.__ModuleLoader__` 工厂，验证它注册到了正确的槽位与键，
 * 并走一遍「编辑 → 保存」「开关立即写入」与「口令写入凭据域」的调用链。
 *
 * 这里不求值 React 组件树，只验证 apply 的挂载与控制器行为。
 *
 * 用法：node selfcheck-client.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { REASON_KINDS, reasonLabel } from './lib/index.js'

/* ---------------------------------------------------------------- 桩件 */

/** 记录一次 mutate 调用。 */
const mutations = []

/** 假的配置表单：持有 value/user，并记录 mutate。 */
function makeScope(namespace, initial) {
  let value = { ...initial.value }
  let user = { ...(initial.user ?? {}) }
  const listeners = new Set()
  return {
    getSnapshot: () => ({ status: 'ready', value, user, revision: 7, writable: true }),
    subscribe: listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    mutate: async (ops, revision) => {
      mutations.push({ namespace, ops, revision })
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

/** 极简 SettingsFormModel：实现 CardController 用到的那部分语义。 */
class StubFormModel {
  constructor(scope, specs, secrets = []) {
    this.scope = scope
    this.specs = specs
    this.secrets = secrets
    this.staged = new Map()
    this.baseline = undefined
    this.listener = undefined
  }

  bind(project) {
    this.project = project
    this.listener = () => {}
    return {
      set: () => {},
      getSnapshot: () => project(),
    }
  }

  shell() {
    return { available: true, writable: true, dirty: this.staged.size > 0, invalid: false, saving: false, failed: false }
  }

  field(name) {
    const staged = this.staged.get(name)
    const text = staged ?? this.#formatted(name)
    return { text, overridden: Object.hasOwn(this.scope.getSnapshot().user ?? {}, name), invalid: false }
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
    // secret 字段走各自的 write()，空草稿不写（与官方 SettingsFormModel 一致）。
    let landed = true
    for (const secret of this.secrets) {
      const text = this.staged.get(secret.field)
      if (text === undefined || String(text).trim() === '') continue
      const ok = await secret.write(text)
      landed = ok && landed
    }
    const ops = []
    for (const [field, text] of this.staged) {
      if (this.secrets.some(secret => secret.field === field)) continue
      const spec = this.specs.find(entry => entry.field === field)
      const parsed = spec?.parse(text)
      if (parsed === undefined) continue
      ops.push(parsed.kind === 'clear' ? { op: 'unset', path: [field] } : { op: 'set', path: [field], value: parsed.value })
    }
    this.staged.clear()
    if (ops.length === 0) return landed
    return (await this.scope.mutate(ops, this.baseline?.revision)) && landed
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

const reactStub = {
  createElement: type => type,
  useState: initial => [initial, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: undefined }),
}

/** 让已排队的微任务跑完（控制器的凭据回读是异步的）。 */
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

/** 默认引用名，须与 client.js 里的 DEFAULT_PASSWORD_REF 一致。 */
const DEFAULT_REF = 'GOTIFY_PASSWORD'

/**
 * 假冒的凭据域：`describe` 按引用答复「是否已配置」，`set`/`unset` 记下来。
 * 与宿主真实契约一致 —— `describe` 返回 `{ ok, value: { [ref]: { configured, writable } } }`，
 * `set` 不返回口令本身。
 * @param initial - 初始已配置的引用表。
 */
function makeCredentials(initial = {}) {
  const store = new Map(Object.entries(initial))
  const calls = { describe: [], set: [], unset: [] }
  return {
    calls,
    api: {
      describe: async refs => {
        calls.describe.push([...refs])
        return {
          ok: true,
          value: Object.fromEntries(refs.map(ref => [ref, { configured: store.has(ref), writable: true }])),
        }
      },
      set: async (ref, value) => {
        calls.set.push([ref, value])
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
      dictionaries.push(namespace)
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
run(window, name => {
  if (name === 'react') return reactStub
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
  throw new Error(`自检未提供 require 桩：${name}`)
})

/* --------------------------------------------------------------- 断言 */

assert.ok(loaded !== undefined, 'client.js 必须调用 window.__ModuleLoader__.load')
assert.equal(loaded.id, 'dsh-gotify-notify', '模块 id 必须是裸包名')
assert.equal(typeof loaded.factory, 'function')
const half = loaded.factory(name => {
  if (name === 'react') return reactStub
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
  throw new Error(`自检未提供 require 桩：${name}`)
})
assert.deepEqual(
  half.inject,
  ['slots', 'locale', 'remote', 'remote.credentials', 'configForms'],
  'inject 必须声明用到的服务（凭据域与官方网页搜索设置页一致）',
)
assert.equal(typeof half.apply, 'function')

half.apply(ctx)

// 0) 双份清单一致性：client 的 REASONS 与宿主半 REASON_KINDS/reasonLabel 逐项对齐。
const reasonsBlock = source.match(/const REASONS = \[([\s\S]*?)\n\s*\]/)?.[1] ?? ''
const reasonPairs = [...reasonsBlock.matchAll(/\{ kind: '([\w-]+)', label: '([^']+)' \}/g)].map(match => [match[1], match[2]])
assert.equal(reasonPairs.length, 7, 'REASONS 应有 7 项（漏改双份清单会被这里抓住）')
assert.deepEqual(reasonPairs.map(pair => pair[0]), REASON_KINDS, 'REASONS 的 kind 集合与顺序必须与宿主半 REASON_KINDS 一致')
for (const [kind, label] of reasonPairs) {
  assert.equal(label, reasonLabel(kind), `REASONS 里 ${kind} 的 label 与宿主半 reasonLabel 不一致`)
}

// 1) 注册到了 plugins.row.config，且键是「包名#行 id」。
const card = registered.find(entry => entry.name === 'plugins.row.config')
assert.ok(card !== undefined, '必须注册 plugins.row.config')
assert.equal(card.entry.options.key, 'dsh-gotify-notify#gotify-notify', '键必须是 <包名>#<行 id>')
assert.match(String(card.entry.options.locale), /^settings\./, 'locale 命名空间应形如 settings.xxx')

// 2) 字典注册到了自己的 locale 命名空间（官方同类页用 `settings.xxx` 命名法）。
assert.ok(dictionaries.length === 1, '应只注册一个 locale 命名空间')
assert.match(dictionaries[0], /^settings\./, 'locale 命名空间应形如 settings.xxx')
assert.ok(
  credentialEvents.some(entry => entry.event === 'credentials/reference-updated'),
  '应订阅凭据变更事件（同一个引用可能在模型页被写）',
)

// 3) 注入面：hook + 四个动作 + setFlag + toggleReason。
assert.equal(typeof card.entry.options.inject, 'function', 'inject 应是函数')
const injected = card.entry.options.inject()
for (const key of ['edit', 'resetField', 'save', 'discard', 'setFlag', 'toggleReason']) {
  assert.ok(injected[key] !== undefined, `inject() 缺少 ${key}`)
}
assert.ok(injected.hooks?.gotifyNotifyCard !== undefined, 'inject() 缺少 hooks.gotifyNotifyCard')

// 4) 快照里既有表单外壳字段，也有各控件状态与开关/原因组。
const snapshot = injected.hooks.gotifyNotifyCard.getSnapshot()
for (const key of ['available', 'writable', 'dirty', 'invalid', 'saving', 'failed', 'url', 'passwordEnv', 'priorityCompleted', 'priorityError', 'minTurn', 'message', 'passwordConfigured', 'passwordWritable', 'passwordRef', 'notifyReasons', 'includeSubagents']) {
  assert.ok(key in snapshot, `投影缺少 ${key}`)
}
assert.equal(snapshot.url.text, 'https://gotify.21zys.com', 'url 应从配置值回填')
assert.equal(snapshot.priorityCompleted.text, '5', 'priorityCompleted 应从配置值回填')
assert.equal(snapshot.passwordConfigured, false, '凭据域还没报已配置时应视为未配置')

// 5) 「编辑 + 保存」走一次 mutate，路径与值正确。
injected.edit('url', 'https://gotify.example.com')
await injected.save()
assert.equal(mutations.length, 1, '保存应产生一次 mutate')
assert.deepEqual(mutations[0].ops, [{ op: 'set', path: ['url'], value: 'https://gotify.example.com' }])
assert.equal(mutations[0].revision, 7, '应带上读到的 revision')

// 6) 越界 priorityCompleted 不产生写入。
injected.edit('priorityCompleted', '99')
await injected.save()
assert.equal(mutations.length, 1, '越界 priorityCompleted 不应写入')

// 7) 布尔开关与原因勾选都是立即写入；未知取值原样保留，不被面板悄悄删掉。
await injected.setFlag('includeSubagents', true)
assert.equal(mutations.length, 2, '开关应立即写入一次')
assert.deepEqual(mutations[1].ops, [{ op: 'set', path: ['includeSubagents'], value: true }])
await injected.toggleReason('forked', true)
assert.equal(mutations.length, 3, '勾选原因应立即写入一次')
assert.deepEqual(
  mutations[2].ops,
  [{ op: 'set', path: ['notifyReasons'], value: ['completed', 'error', 'blocked', 'aborted', 'interrupted', 'max-tokens', 'forked', 'future-kind'] }],
  '勾上 forked 应整组写回，未知取值追加在尾部保留',
)
assert.equal(mutations[2].revision, 7, '勾选写入应带上读到的 revision')
await injected.toggleReason('completed', false)
assert.deepEqual(
  mutations[3].ops,
  [{ op: 'set', path: ['notifyReasons'], value: ['error', 'blocked', 'aborted', 'interrupted', 'max-tokens', 'forked', 'future-kind'] }],
  '取消勾选应把该项移出集合，未知取值仍保留',
)
assert.equal(mutations.length, 4, '两次勾选各写入一次')

// 8) 口令不进配置文件：保存它只写凭据域，不产生任何 mutate。
await injected.edit('password', 's3cret')
await injected.save()
await flush()
assert.equal(mutations.length, 4, '口令保存不应改写 cordis.patch.yml')
assert.deepEqual(credentials.calls.set, [[DEFAULT_REF, 's3cret']], '口令应写进凭据库的默认引用名下')
assert.equal(
  injected.hooks.gotifyNotifyCard.getSnapshot().passwordConfigured,
  true,
  '写入后 describe 回读应报已配置',
)

// 9) 改引用名会重新问凭据域，且问的是新名字。
injected.edit('passwordEnv', 'GOTIFY_PASSWORD_ALT')
await injected.save()
await flush()
assert.deepEqual(credentials.calls.describe.at(-1), ['GOTIFY_PASSWORD_ALT'], '改引用名后应按新名字重新查询')
assert.equal(injected.hooks.gotifyNotifyCard.getSnapshot().passwordRef, 'GOTIFY_PASSWORD_ALT')

console.log('selfcheck-client 通过：槽位键、注入面、投影、保存、开关/原因勾选与凭据写入均符合预期。')
