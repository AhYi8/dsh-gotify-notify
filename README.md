# dsh-gotify-notify

DSH 的 Gotify 通知插件：**每轮会话结束**时向你的 [Gotify](https://gotify.net/) 服务器推送一条通知，可在 DSH 的插件管理页里直接配置，无需手改配置文件。

## 功能

- 监听会话的 `turn/end` 事件，按「成功 / 其它结果」分别使用两套标题模板。
- 支持占位符：`{id}`（会话短 id）、`{title}`（会话标题，与侧边栏一致）、`{turn}`（轮次）、`{reason}`（结束原因的**中文标签**）、`{reasonRaw}`（结束原因的原始标识）、`{error}`（失败原因，仅在出错时有内容）、`{cwd}`（工作目录名）、`{time}`（本地时间）；未知占位符原样保留。
- **触发原因多选**（`notifyReasons`）：勾选哪些结束原因才推送 —— 成功、失败、被阻断、已中止、已中断、超出长度上限、分支继承；默认除「分支继承」外全选，一个都不勾等于关闭通知。
- **分档优先级**：成功（`priorityCompleted`，默认 3）与非成功（`priorityError`，默认 8）各一档，失败比成功更醒目。
- **最低轮次门槛**（`minTurn`，默认 0）：轮次低于该值不推送，快速小问答不打扰；轮次缺失时不拦截（宁可多推）。
- 默认跳过子 Agent 会话，可开关。
- 推送失败只写日志，绝不影响会话本身。
- 插件管理页提供「发送测试通知」按钮，配好之后可以先验证再启用。
- 口令存在 **DSH 凭据库**里（和模型设置页写 API Key 是同一个地方），配置文件里只留一个引用名（`passwordEnv`，默认 `GOTIFY_PASSWORD`），所以 `cordis.patch.yml` 里不含任何机密；用户名不是机密，仍放在设置里。详见下面的「凭据」一节。

## 安装

### 通过 dshmarket 安装

```text
市场 → 搜索 gotify → 安装 → 重启 DSH
```

安装后 DSH 会读取本包的 `dsh.bundle.patch`，把下面这条行插进 Loader 树（行内容由本包的 `cordis.patch.yml` 提供）：

```yaml
- insert:
    - id: gotify-notify
      name: dsh-gotify-notify
```

### 从本地目录安装（开发调试）

在 profile 目录（如 `~/.dsh/profiles/desktop`）里：

```powershell
pnpm add file:C:\path\to\dsh-gotify-notify
```

然后在该 profile 的 `package.json` 的 `dsh.profile.bundles` 数组里补上 `dsh-gotify-notify`，重启 DSH。

### 从旧的手工挂载迁移

如果你之前是手工挂在 profile 的 `cordis.patch.yml` 里（形如 `name: './gotify-notify/index.js'` 的相对路径 insert 行），**必须先删掉那条旧行**再安装本包，否则同一条通知会推送两次：

1. 打开 `~/.dsh/profiles/<profile>/cordis.patch.yml`，删掉 `id: gotify-notify` 且 `name` 指向相对路径的整条 insert 行。
2. 删除旧目录 `~/.dsh/profiles/<profile>/gotify-notify/`。
3. 把原来的 `url` 等设置好在插件管理页里重新填一遍（面板保存会写回 profile 的 `cordis.patch.yml`）。
4. 重启 DSH。

## 配置

打开 **设置 → 插件 → 找到 `dsh-gotify-notify` → 配置**（插件管理页的行内配置卡）。

| 字段 | 说明 | 默认 |
| --- | --- | --- |
| `url` | Gotify 服务器地址，必须以 `http://` 或 `https://` 开头 | `https://gotify.21zys.com` |
| `user` | Gotify 用户名（用于自动创建/复用名为 `DSH` 的应用并换取 token）；留空则读启动环境变量 `GOTIFY_USER` | 空 |
| `passwordEnv` | **口令的凭据引用名**：口令存在凭据库的哪个名字下（同时是环境变量名） | `GOTIFY_PASSWORD` |
| `token` | 直接指定应用 token，填了就不再需要账号密码 | 空 |
| `titleCompleted` | 正常结束时的通知标题模板 | `DSH 任务完成` |
| `titleOther` | 非正常结束时的标题模板 | `DSH 轮次结束（{reason}）` |
| `message` | 通知正文模板 | 见下 |
| `notifyReasons` | 哪些结束原因才推送（多选） | 除 `forked` 外全部 |
| `priorityCompleted` | 成功时的优先级，0–10 的整数 | `3` |
| `priorityError` | 非成功时的优先级，0–10 的整数 | `8` |
| `minTurn` | 最低轮次门槛，低于该值不推送 | `0` |
| `includeSubagents` | 连子 Agent 的轮次结束也通知 | 关 |

### 凭据

口令**不写进配置文件**。插件管理页里的口令控件走
`ctx.remote.credentials.set(ref, value)` 把值写进 DSH 的凭据库
（`$DSH_HOME/.credentials.yaml`，与模型 API Key 同一个库），配置文件里只留下
`passwordEnv` 这个引用名。是否已配置由 `describe()` 回读判定 —— 值永不回传。

插件求值时按下面的顺序找口令，前一条拿到就用前一条：

1. 凭据域按 `passwordEnv`（默认 `GOTIFY_PASSWORD`）解析 —— 凭据库与启动环境都走这一条；
2. 凭据域缺席、拒绝解析、或未命中该引用时，直接读启动环境里与 `passwordEnv` 同名的变量。

凭据域是**软探测**的：profile 没组合凭据服务时插件照常工作，直接从启动环境读，
不会因为缺一个服务就起不来。

默认正文：

```text
会话 {title} 第 {turn} 轮已结束
结果：{reason}
目录：{cwd}
时间：{time}
```

> **模板里的换行怎么写？** 设置面板是单行输入框，换行请写成两个字符 `\n`，插件会还原成真正的换行。

`{reason}` 输出中文标签，`{reasonRaw}` 输出 DSH 的原始标识：

| 原始标识 | `{reason}` |
| --- | --- |
| `completed` | 成功 |
| `error` | 失败 |
| `aborted` | 已中止 |
| `interrupted` | 已中断 |
| `blocked` | 被阻断 |
| `max-tokens` | 超出长度上限 |
| `forked` | 分支继承 |

`turn/end` 的原因集合在 DSH 里是**可扩展**的（`TurnEndReasonMap` 允许后端新增取值），未收录的标识会原样显示，不会编造中文。

`{error}` 只在 `error` 结束时才有内容：它取自 DSH 的失败快照 `reason.error`（`@deepseek-ai/dsh-llm` 的 LlmFailure，含非空的 `message` 与 `code`），优先用 `message`，消息为空时回落到 `code`；其余结束原因渲染成**空串**，所以像 `结果：{reason}\n{error}` 这样的正文在成功时是干净的，不会残留 `{error}` 字面量。

配置保存在当前 profile 的 `cordis.patch.yml` 中，由 DSH 的配置编辑器自动维护；本包的 `cordis.patch.yml` 不预置 `config:`，避免出现两份互相覆盖的配置。

## 行为细节

- 只处理 `turn/end`；子 Agent 判定同时看 `header.origin === 'subagent'` 与 `header.parentSession`。
- 触发判定链：结束原因先查 `notifyReasons` 集合（手写进配置的未收录新取值照样能触发推送；面板只展示已知原因，但勾选写回时会**原样保留**配置里的未知取值，不会悄悄删掉），再过 `minTurn` 轮次门槛（轮次缺失或非整数时放行，宁可多推）；优先级按「成功 / 非成功」分档，未知取值偏异常档。
- token 只在内存里缓存，进程重启后重新换取；获取失败会清空缓存，下次重试。
- 推送是 fire-and-forget：失败时只在 DSH 日志里记一条 `推送失败：…`。
- 「发送测试通知」由宿主侧路由 `/gotify-notify/test` 处理，围栏是「回环 socket + 回环 Host」：DSH 桌面壳转发页面请求时会删掉 `Origin` 与 `Sec-Fetch-Site`，所以不能靠浏览器同源标记判定，只能以回环连接本身为权威边界（带了 `Origin` 时仍要求与 `Host` 同权威，`Sec-Fetch-Site: cross-site` 一律拒绝）。

## 开发

```powershell
# 宿主半自检：Config / url / 凭据 / 模板渲染
node selfcheck.mjs

# 浏览器半自检：槽位注册 / 注入面 / 表单投影 / 保存与 secret
node selfcheck-client.mjs

# 清单自检：package.json 字段、exports/files 指向、bundle patch 形态、icon 与 locale
node selfcheck-manifest.mjs
```

自检脚本需要能解析 `@deepseek-ai/schemastery`，在未安装本包的目录里跑时可临时建目录联接：

```powershell
New-Item -ItemType Junction -Path node_modules\@deepseek-ai\schemastery `
  -Target "$env:DSH_PROFILE_DIR\node_modules\@deepseek-ai\schemastery"
```

## 发布（上架 dshmarket）

dshmarket 只允许安装 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 精选列表里的来源，因此上架需要两步：

1. **发布 npm 包**（市场优先使用经仓库验证的 npm 包，比 GitHub 源码安装更快更稳）：

   ```powershell
   npm publish
   ```

2. **向 awesome-dsh-plugin 仓库提 PR**，在插件列表里加一条，`url` 指向本包仓库、`npm` 指向包名（本包已配置 `publishConfig.access = public`）。

条目生效后，用户在 dshmarket 里搜索 `gotify` 即可一键安装。

## 许可

MIT
