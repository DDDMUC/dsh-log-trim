// The settings card's registration, checked against a stub loader.
//
// The card only works if two things line up: the package serves a client half
// (`exports["./client"]` + `dsh.client`), and that half registers on the SAME two
// slot seats `dsh-free-search` uses, with keys the plugin manager derives:
// `<包名>#<patch 行 id>` for the row page and the bare package name for the bundle
// page. A typo here is invisible until someone opens Settings → Plugins, so it is
// pinned here instead.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(here, '..')

/** Load the browser half against a stub module loader and return what it exports. */
function loadClientHalf() {
  let loaded = null
  globalThis.window = {
    __ModuleLoader__: {
      load: ({ id, factory }) => {
        loaded = { id, exports: factory((specifier) => {
          if (specifier === 'react') {
            return { useState: (value) => [value, () => {}], useEffect: () => {}, useCallback: (fn) => fn, useRef: (value) => ({ current: value }) }
          }
          if (specifier === 'react/jsx-runtime') {
            const make = (type, props, key) => ({ type, props, key })
            return { jsx: make, jsxs: make, Fragment: 'Fragment' }
          }
          throw new Error(`unexpected require(${specifier})`)
        }) }
      },
    },
  }
  const source = fs.readFileSync(path.join(packageRoot, 'lib', 'client.js'), 'utf8')
  // 客户端半部是 classic bundle（靠 window.__ModuleLoader__ 注册），这里直接求值。
  new Function('window', source)(globalThis.window)
  assert.ok(loaded !== null, 'the bundle registered itself')
  return loaded
}

test('package 声明了客户端半部，并且在插件管理器认得的位置注册', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
  assert.equal(manifest.exports['./client'], './lib/client.js', '客户端入口有导出')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.ok(Array.isArray(manifest.dsh.client.inject) && manifest.dsh.client.inject.length > 0, '声明了要注入的宿主 UI 包')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml', '宿主补丁仍在')

  const loaded = loadClientHalf()
  assert.equal(loaded.id, 'dsh-session-compact')
  assert.deepEqual(loaded.exports.inject, ['slots'], '只需要 slots')

  const registered = []
  loaded.exports.apply({ slots: { inject: (name, build) => build(), register: (meta) => { registered.push(meta); return () => {} } } })
  const seats = registered.map((meta) => `${meta.name} | ${meta.key}`).sort()
  assert.deepEqual(seats, [
    'plugins.bundle.config | dsh-session-compact',
    'plugins.row.config | dsh-session-compact#dsh-session-compact',
  ], '和 dsh-free-search 并排的那两个座位')
})
