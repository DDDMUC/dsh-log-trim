import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stripOldStreams } from '../lib/vendor/compact-session.mjs'

/** 三轮，每轮的 assistant/message 都带一份流式回放记录。 */
function turns(count) {
  const events = []
  let seq = 0
  for (let turn = 1; turn <= count; turn += 1) {
    events.push({ type: 'turn/start', seq: seq++, data: { turn } })
    events.push({ type: 'step/start', seq: seq++, data: { turn, step: 1 } })
    events.push({ type: 'user/message', seq: seq++, data: { message: { role: 'user', content: [{ type: 'text', text: `q${turn}` }] } } })
    events.push({
      type: 'assistant/message',
      seq: seq++,
      data: {
        turn,
        usage: { inputTokens: 10, outputTokens: 5 },
        stream: [{ type: 'chunk', chunk: { type: 'block-end', block: { type: 'reasoning', text: `thinking ${turn}` } } }],
        message: { role: 'assistant', content: [{ type: 'reasoning', text: `thinking ${turn}` }] },
      },
    })
    events.push({ type: 'step/end', seq: seq++, data: { turn, step: 1 } })
    events.push({ type: 'turn/end', seq: seq++, data: { turn } })
  }
  return events
}

test('只留最近 N 轮的 stream，正文与行数不变', () => {
  const events = turns(5)
  const { events: out, stripped } = stripOldStreams(events, 2)
  assert.equal(out.length, events.length, '行数不变')
  assert.equal(stripped, 3, '前 3 轮的 stream 被删')
  const byTurn = new Map(out.filter((event) => event.type === 'assistant/message').map((event) => [event.data.turn, event]))
  // 不能整条删：宿主对结算字段有校验，空数组才是合法的“没有回放记录”。
  assert.deepEqual(byTurn.get(1).data.stream, [])
  assert.deepEqual(byTurn.get(2).data.stream, [])
  assert.deepEqual(byTurn.get(3).data.stream, [])
  assert.ok(byTurn.get(4).data.stream.length > 0, '第 4 轮（倒数第二）保留')
  assert.ok(byTurn.get(5).data.stream.length > 0, '最后一轮保留')
  assert.deepEqual(byTurn.get(1).data.message, { role: 'assistant', content: [{ type: 'reasoning', text: 'thinking 1' }] }, '正文不受影响')
})

test('keepTurns 为 Infinity 时一条都不删', () => {
  const events = turns(3)
  const { events: out, stripped } = stripOldStreams(events, Infinity)
  assert.equal(stripped, 0)
  assert.equal(out.filter((event) => event.data?.stream).length, 3)
})

test('缺 usage 的行不清：宿主会拿 stream 兜底算用量', () => {
  const events = turns(3)
  for (const event of events) if (event.type === 'assistant/message') delete event.data.usage
  const { stripped } = stripOldStreams(events, 0)
  assert.equal(stripped, 0, '没有 usage 的行一条都不动')
})

test('keepTurns = 0 表示全清', () => {
  const events = turns(3)
  const { stripped } = stripOldStreams(events, 0)
  assert.equal(stripped, 3)
})
