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
