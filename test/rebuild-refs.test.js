import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rebuildSurface } from '../lib/lossless.js'

/** 造一行日志事件。 */
const row = (seq, type, data, surfaceOp = 'append') => ({ seq, type, time: 1000 + seq, data, surfaceOp })

/** 一份带标题、工具通知、载体引用的最小日志。 */
function fixture() {
  const tools = [
    { name: 'read', description: 'read', parameters: { type: 'object' } },
    { name: 'write', description: 'write', parameters: { type: 'object' } },
    { name: 'glob', description: 'glob', parameters: { type: 'object' } },
  ]
  return [
    row(0, 'system/message', { turn: 1, step: 1, message: { role: 'system', content: [{ type: 'text', text: 'sys' }] } }),
    row(1, 'request/header', { turn: 1, step: 1, header: { config: {}, tools } }),
    row(2, 'user/message', { turn: 1, step: 1, message: { role: 'user', content: [{ type: 'text', text: 'hi' }] }, source: { kind: 'user' } }),
    row(3, 'assistant/message', {
      turn: 1, step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }], source: { promptSeq: 2 } },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0 },
      stream: [],
    }),
    row(4, 'developer/message', {
      turn: 2, step: 1,
      message: { source: { kind: 'tool-registry' }, content: [{ type: 'tool-addition', toolName: 'glob' }] },
    }),
    row(5, 'user/message', { turn: 2, step: 1, message: { role: 'user', content: [{ type: 'text', text: 'again' }] }, source: { kind: 'user' } }),
    row(6, 'session/title', { title: '标题', messageSeqs: [2], source: { kind: 'fallback' } }),
  ]
}

test('重建：标题排在引用消息之后，且引用的是更早的 user/message', () => {
  const out = rebuildSurface(fixture())
  const title = out.find((event) => event.type === 'session/title')
  assert.ok(title, '标题还在')
  assert.ok(Array.isArray(title.data.messageSeqs) && title.data.messageSeqs.length > 0, '自动标题必须引用消息')
  for (const seq of title.data.messageSeqs) {
    assert.ok(seq < title.seq, `引用 ${seq} 必须早于标题 ${title.seq}`)
    assert.equal(out[seq].type, 'user/message')
    assert.equal(out[seq].data.source.kind, 'user')
  }
})

test('重建：tool-addition 的 header 只定义被点名的那个工具', () => {
  const out = rebuildSurface(fixture())
  const notice = out.find((event) => event.type === 'developer/message')
  assert.equal(typeof notice.data.headerSeq, 'number', '通知引用了 header')
  const header = out[notice.data.headerSeq]
  assert.equal(header.type, 'request/header')
  const names = header.data.header.tools.map((tool) => tool.name)
  assert.deepEqual(names, ['glob'], '恰好一个工具，且就是被点名的那一个')
})

test('重建：source.promptSeq 重新映射到更早的位置', () => {
  const out = rebuildSurface(fixture())
  const assistant = out.find((event) => event.type === 'assistant/message')
  assert.equal(typeof assistant.data.message.source.promptSeq, 'number')
  assert.ok(assistant.data.message.source.promptSeq < assistant.seq)
  assert.equal(out[assistant.data.message.source.promptSeq].type, 'user/message')
})

test('重建：扁平载体上的 promptSeq/logFrom/logTo 也重映射', () => {
  const events = fixture()
  events.push(row(7, 'user/message', { role: 'user', content: [{ type: 'text', text: '\u200b' }], source: { kind: 'plugin:dsh-rerun-turn', promptSeq: 2, logFrom: 2, logTo: 3 } }))
  const out = rebuildSurface(events)
  const carrier = out.find((event) => event.type === 'user/message' && event.data.source?.kind === 'plugin:dsh-rerun-turn')
  for (const key of ['promptSeq', 'logFrom', 'logTo']) {
    assert.equal(typeof carrier.data.source[key], 'number', `${key} 保留了`)
    assert.ok(carrier.data.source[key] < carrier.seq, `${key} 更早`)
  }
})
