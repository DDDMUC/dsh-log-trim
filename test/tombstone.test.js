import { test } from 'node:test'
import assert from 'node:assert/strict'
import { annotateDeletes, logTurnOf, tombstonesOf, visibleTurnOf } from '../lib/tombstone.js'

/** One delete carrier: the whole turn it removed is in `source.turn`. */
function deleteCarrier(seq, turn, kind = 'plugin:dsh-delete-turn') {
  return { seq, type: 'user/message', data: { source: { kind, turn } }, surfaceOp: { op: 'replace', startSeq: turn, endSeq: turn } }
}

const tombstones = tombstonesOf([deleteCarrier(30, 3), deleteCarrier(60, 10)])

test('墓碑：按轮升序去重，序号从 1 开始', () => {
  assert.deepEqual(tombstones.map((t) => [t.turn, t.index]), [[3, 1], [10, 2]])
})

test('可见轮：删了第 3 轮，日志第 4 轮变成可见第 3 轮', () => {
  assert.equal(visibleTurnOf(tombstones, 4), 3)
  assert.equal(visibleTurnOf(tombstones, 3), null, '被删的那一轮没有可见编号')
})

test('可见轮：再删第 10 轮，日志第 11 轮变成可见第 9 轮', () => {
  assert.equal(visibleTurnOf(tombstones, 11), 9)
  assert.equal(visibleTurnOf(tombstones, 2), 2)
})

test('反向：可见轮 → 日志轮', () => {
  assert.equal(logTurnOf(tombstones, 3), 4)
  assert.equal(logTurnOf(tombstones, 9), 11)
  assert.equal(logTurnOf(tombstones, 2), 2)
  assert.equal(logTurnOf([], 7), 7)
})

test('标注：delete 载体写出 deletedTurn / deleteIndex / visibleAfter', () => {
  const { events } = annotateDeletes([deleteCarrier(30, 3), deleteCarrier(60, 10)])
  const sources = events.map((event) => event.data.source)
  assert.deepEqual(
    sources.map((source) => [source.op, source.deletedTurn, source.deleteIndex, source.visibleAfter]),
    [['delete', 3, 1, 3], ['delete', 10, 2, 9]],
  )
  assert.deepEqual(events[0].surfaceOp, { op: 'replace', startSeq: 3, endSeq: 3 }, '标注不动替换记录')
})

test('标注：别人的载体一律不碰', () => {
  const foreign = deleteCarrier(10, 5, 'plugin:dsh-edit-turn')
  assert.deepEqual(annotateDeletes([foreign]).events[0].data.source, foreign.data.source)
})

// 隔离：`discoverRoots(extra, { only: true })` 绝不能追加默认根目录。
// 这条测试来自一次真实事故：用 $HOME 做“隔离”在 macOS 上无效（os.homedir 不读它），
// 结果一次“测试扫描”跑到了用户真实的日志上。
import { discoverRoots } from '../lib/roots.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

test('隔离：only 只返回指定根目录，不追加默认根', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roots-'))
  const only = discoverRoots(dir, { only: true })
  assert.deepEqual(only, [path.resolve(dir)])
  const all = discoverRoots(dir)
  assert.ok(all.includes(path.resolve(dir)), '默认模式包含指定目录')
  assert.ok(all.length >= only.length)
  if (all.length > 1) assert.ok(all.some((entry) => entry !== path.resolve(dir)), '默认模式确实追加了别的根')
})
