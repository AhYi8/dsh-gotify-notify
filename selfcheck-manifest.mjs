/**
 * 非交互自检：校验 package.json 的清单自洽性。
 *
 * 只做静态检查，不加载 DSH、不联网：
 *   1. package.json 可 JSON.parse，且必需字段齐备；
 *   2. `exports` / `files` 里声明的每个路径都真实存在；
 *   3. `dsh.client` 声明的平台与 `exports["./client"]` 一致
 *      （对应 `dsh-client-modules` 的 `clientExportOf` 要求）；
 *   4. `dsh.bundle.patch` 指向的 YAML 能被读成 UTF-8 文本且含 insert 行；
 *   5. `icon` 是包内相对路径、扩展名合法、体积不超过 256 KiB；
 *   6. 版本号与 `engines` 声明形态合法。
 *
 * 用法：node selfcheck-manifest.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const manifestPath = join(root, 'package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

// 1) 必需字段。
assert.equal(manifest.type, 'module', 'type 必须是 module')
assert.equal(typeof manifest.name, 'string', 'name 必填')
assert.equal(manifest.name, 'dsh-gotify-notify', 'name 必须与 ModuleLoader id 一致')
assert.ok(manifest.version !== undefined, 'version 必填')
assert.ok(manifest.main !== undefined, 'main 必填')

// 2) exports / files 指向真实文件。
assert.equal(manifest.exports['./client'], './client/client.js')
assert.equal(manifest.exports['.'], './lib/index.js')
for (const [, target] of Object.entries(manifest.exports)) {
  if (target.includes('*')) {
    // 通配导出不能一律跳过：本包只用 locale 这一处，一旦换成别的通配形态，
    // 这里必须同步补展开逻辑，否则「指向不存在的文件」就漏检了。
    assert.equal(target, './locale/*.json', `出现了未处理通配导出：${target}`)
    for (const language of ['en', 'zh']) {
      assert.ok(existsSync(join(root, 'locale', `${language}.json`)), `通配导出应能命中 locale/${language}.json`)
    }
    continue
  }
  assert.ok(existsSync(resolve(root, target)), `exports 目标不存在：${target}`)
}
for (const entry of manifest.files) {
  assert.ok(existsSync(join(root, entry)), `files 条目不存在：${entry}`)
}

// 3) dsh 声明自洽（dsh-client-modules 的 clientExportOf 要求 exports["./client"]）。
assert.equal(manifest.dsh.manifestVersion, 1)
assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
assert.equal(manifest.dsh.client.platform, 'web')
// 精确比对而非只看前缀：多列一个没被 require 的客户端包（或少列一个）都应有意识，
// 清单里声明的每个注入包也必须在 peerDependencies 里交代版本。
assert.deepEqual(
  manifest.dsh.client.inject,
  ['@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-settings'],
  'client.inject 列表与预期不一致',
)
for (const dependency of manifest.dsh.client.inject) {
  assert.match(dependency, /^@deepseek-ai\/dsh-client-/, `client.inject 只应列客户端包：${dependency}`)
  assert.equal(typeof manifest.peerDependencies?.[dependency], 'string', `client.inject 的 ${dependency} 应在 peerDependencies 里声明`)
}
assert.ok(existsSync(resolve(root, manifest.dsh.bundle.patch)), 'bundle.patch 指向的文件不存在')

// 3.1) 版本号与 engines 形态（装不上或声明写坏时给出可读的失败信息）。
assert.match(manifest.version, /^\d+\.\d+\.\d+$/, 'version 应是 x.y.z 形态')
assert.equal(typeof manifest.engines?.node, 'string', 'engines.node 必填')
assert.equal(typeof manifest.dsh.engines?.dsh, 'string', 'dsh.engines.dsh 必填（DSH 用它判断兼容范围）')
assert.match(manifest.dsh.engines.dsh, /^(>=|\^|~)/, 'dsh.engines.dsh 应是 semver 范围')

// 4) bundle patch 是最简 insert 行。
const patchText = readFileSync(resolve(root, manifest.dsh.bundle.patch), 'utf8')
assert.ok(patchText.includes('- insert:'), 'patch 应有 insert 行')
assert.ok(patchText.includes('id: gotify-notify'), 'patch 的行 id 应为 gotify-notify')
assert.ok(patchText.includes('name: dsh-gotify-notify'), 'patch 的行 name 应为包名')
assert.ok(!/^\s+config:/m.test(patchText), 'patch 不应预置 config（保存时由 config-editor 写入顶层行）')

// 5) icon 合法性（对齐 dsh-app-boot 的 iconOf）。
assert.equal(manifest.icon, './icon.svg')
assert.ok(!manifest.icon.startsWith('/'), 'icon 必须是相对路径')
const iconFile = resolve(root, manifest.icon)
assert.deepEqual(
  ['.svg', '.png', '.jpg', '.jpeg', '.webp'].includes(extname(iconFile).toLowerCase()),
  true,
  `icon 扩展名不合法：${extname(iconFile)}`,
)
const iconBytes = statSync(iconFile).size
assert.ok(iconBytes > 0 && iconBytes <= 256 * 1024, `icon 体积越界：${iconBytes}`)
assert.ok(readFileSync(iconFile, 'utf8').includes('<svg'), 'icon.svg 应是 SVG 文本')

// 6) 展示元数据的本地化文件（readPluginMeta 只认 locale/*.json + package.json 的 icon）。
for (const language of ['en', 'zh']) {
  const file = join(root, 'locale', `${language}.json`)
  assert.ok(existsSync(file), `缺少 locale/${language}.json`)
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(typeof parsed.meta?.title, 'string', `locale/${language}.json 缺少 meta.title`)
  assert.equal(typeof parsed.meta?.description, 'string', `locale/${language}.json 缺少 meta.description`)
}

console.log('selfcheck-manifest 通过：清单字段、exports/files（含通配导出）、版本与 engines、bundle patch 形态与 icon/locale 均合法。')
