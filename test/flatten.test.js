import { test } from 'node:test'
import assert from 'node:assert/strict'
import { flattenHistory } from '../lib/flatten.js'

/** 三轮：第 1 轮被 edit 改过，第 2 轮被 rerun 盖过，第 3 轮被整轮删除。 */
function logWithCarriers() {
  const events = []
  let seq = 0
  const push = (event) => {
    events.push({ ...event, seq: seq++ })
    return events[events.length - 1]
  }
  push({ type: 'system/message', data: { message: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'sys' }] } }, surfaceOp: 'append' })
  for (let turn = 1; turn <= 3; turn += 1) {
    push({ type: 'turn/start', data: { turn } })
    push({ type: 'step/start', data: { turn, step: 1 } })
    push({ type: 'user/message', data: { message: { id: `u${turn}`, role: 'user', content: [{ type: 'text', text: `q${turn}` }] }, turn, step: 1 }, surfaceOp: 'append' })
    push({ type: 'assistant/message', data: { turn, step: 1, message: { id: `a${turn}`, role: 'assistant', content: [{ type: 'text', text: `a${turn}` }] } }, surfaceOp: 'append' })
    push({ type: 'step/end', data: { turn, step: 1 } })
    push({ type: 'turn/end', data: { turn } })
  }
  const id = (value) => events.find((event) => event.data?.message?.id === value)
  const u1 = id('u1'), a2 = id('a2'), u3 = id('u3'), a3 = id('a3')
  // edit：载体带新正文，替换第 1 轮的提问
  push({
    type: 'user/message',
    data: { message: { id: 'edit1', role: 'user', content: [{ type: 'text', text: 'q1-edited' }] }, source: { kind: 'user', editedBy: 'dsh-edit-turn' } },
    surfaceOp: { op: 'replace', startSeq: u1.seq, endSeq: u1.seq },
    sourceEventSeqs: [u1.seq],
  })
  // rerun：静默载体，盖掉第 2 轮的回答
  push({
    type: 'user/message',
    data: { message: { role: 'user', content: [{ type: 'text', text: '\u200b' }] }, source: { kind: 'plugin:dsh-rerun-turn' } },
    surfaceOp: { op: 'replace', startSeq: a2.seq, endSeq: a2.seq },
    sourceEventSeqs: [a2.seq],
  })
  // delete：静默载体，整轮删掉第 3 轮
  push({
    type: 'user/message',
    data: { message: { role: 'user', content: [{ type: 'text', text: '\u200b' }] }, source: { kind: 'plugin:dsh-delete-turn', op: 'delete', turn: 3, deletedTurn: 3, deleteIndex: 1 } },
    surfaceOp: { op: 'replace', startSeq: u3.seq, endSeq: a3.seq },
    sourceEventSeqs: [u3.seq, a3.seq],
  })
  return events
}

test('折叠：edit 的新正文进了结果，载体与替换记录都消失', () => {
  const { events: out, folded } = flattenHistory(logWithCarriers())
  assert.ok(JSON.stringify(out).includes('q1-edited'), 'edit 的正文进了结果')
  assert.equal(folded.edits, 1)
  assert.equal(out.some((event) => String(event.data?.source?.kind ?? '').startsWith('plugin:')), false, '没有插件载体残留')
  assert.equal(out.some((event) => typeof event.surfaceOp === 'object' && event.surfaceOp !== null), false, '没有 replace 记录')
})

test('折叠：rerun 盖掉的旧回答、delete 删掉的整轮都不再出现', () => {
  const { events: out, folded } = flattenHistory(logWithCarriers())
  const text = JSON.stringify(out)
  assert.equal(text.includes('a2'), false, '第 2 轮的旧回答没了')
  assert.equal(text.includes('q3'), false, '第 3 轮随整轮删除一起消失')
  assert.equal(folded.reruns, 1)
  assert.equal(folded.deletes, 1)
})

test('折叠：seq 从 0 连续', () => {
  const { events: out } = flattenHistory(logWithCarriers())
  out.forEach((event, index) => assert.equal(event.seq, index, 'seq 连续'))
})

test('折叠：没有载体时原样返回', () => {
  const events = logWithCarriers().filter((event) => {
    const source = event.data?.source
    return !(typeof source?.kind === 'string' && source.kind.startsWith('plugin:')) && source?.editedBy === undefined
  })
  const { events: out, folded } = flattenHistory(events)
  assert.equal(out.length, events.length)
  assert.equal(folded.edits + folded.reruns + folded.deletes, 0)
})
