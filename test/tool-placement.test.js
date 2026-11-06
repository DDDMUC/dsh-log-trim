import { test } from 'node:test'
import assert from 'node:assert/strict'
import { repairLateToolResults } from '../lib/vendor/compact-session.mjs'

/** 造一条事件。 */
const ev = (seq, type, data) => ({ seq, type, time: 1000 + seq, data, surfaceOp: 'append' })

/** 两个轮次；turn 1 step 1 里有一次工具调用。 */
function base() {
  return [
    ev(0, 'turn/start', { turn: 1 }),
    ev(1, 'step/start', { turn: 1, step: 1 }),
    ev(2, 'tool/call', { turn: 1, step: 1, callId: 'call-1' }),
    ev(3, 'step/end', { turn: 1, step: 1 }),
    ev(4, 'turn/end', { turn: 1 }),
    ev(5, 'turn/start', { turn: 2 }),
    ev(6, 'step/start', { turn: 2, step: 1 }),
    ev(7, 'user/message', { turn: 2, step: 1, message: { role: 'user', content: [] } }),
  ]
}

test('迟到结果：挪回自己那一步，落在 step 结束之前', () => {
  const late = ev(8, 'tool/result', {
    turn: 1,
    step: 1,
    message: { role: 'tool', toolCallId: 'call-1', source: { kind: 'tool', callId: 'call-1' }, content: [] },
  })
  const events = [...base(), late]
  const out = repairLateToolResults(events)
  assert.equal(out.moved, 1)
  const index = out.events.findIndex((event) => event.seq === 8)
  const stepEnd = out.events.findIndex((event) => event.type === 'step/end')
  assert.ok(index !== -1 && index < stepEnd, '结果挪进了 turn 1 的 step 1')
})

test('孤儿结果：调用已被裁掉的结果直接丢弃', () => {
  const orphan = ev(9, 'tool/result', {
    turn: 2,
    step: 1,
    message: { role: 'tool', toolCallId: 'call-gone', source: { kind: 'tool', callId: 'call-gone' }, content: [] },
  })
  const out = repairLateToolResults([...base(), orphan])
  assert.equal(out.dropped, 1)
  assert.equal(out.events.some((event) => event.type === 'tool/result'), false)
})

test('已经合法的结果不动', () => {
  const ok = ev(8, 'tool/result', {
    turn: 2,
    step: 1,
    message: { role: 'tool', toolCallId: 'call-1', source: { kind: 'tool', callId: 'call-1' }, content: [] },
  })
  const out = repairLateToolResults([...base(), ok])
  assert.equal(out.moved, 0)
  assert.equal(out.dropped, 0)
})
