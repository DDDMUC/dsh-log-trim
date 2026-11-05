import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { clearLedger, ledgerPath, readLedger, recordFor, recordTrim } from '../lib/ledger.js'

/** 造 n 个事件，前若干个是检查点窗口。 */
function events(count, checkpoints = 0) {
  const out = []
  for (let index = 0; index < count; index += 1) {
    const isCheckpoint = index < checkpoints
    out.push({
      seq: index,
      type: 'user/message',
      data: { source: isCheckpoint ? { kind: 'compact-checkpoint' } : { kind: 'user' }, message: { role: 'user', content: [{ type: 'text', text: 'x' }] } },
      surfaceOp: 'append',
    })
  }
  return out
}

test('账本：记一笔，窗口与事件数都算出来', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'))
  const totals = recordTrim(
    { sessionId: 'session-a', mode: 'window', before: events(10, 2), after: events(6, 1), bytesBefore: 1000, bytesAfter: 400 },
    home,
  )
  assert.equal(totals.trims, 1)
  const ledger = readLedger(home)
  const entry = ledger.sessions['session-a']
  assert.equal(entry.trims.length, 1)
  assert.equal(entry.trims[0].mode, 'window')
  assert.equal(entry.trims[0].windowsBefore, 3)
  assert.equal(entry.trims[0].windowsAfter, 2)
  assert.equal(entry.trims[0].windowsRemoved, 1)
  assert.equal(entry.trims[0].eventsRemoved, 4)
  assert.equal(entry.totals.bytesSaved, 600)
})

test('账本：多次裁剪按会话累计', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'))
  recordTrim({ sessionId: 'session-b', mode: 'window', before: events(8, 2), after: events(4, 1) }, home)
  const totals = recordTrim({ sessionId: 'session-b', mode: 'flatten', before: events(20, 1), after: events(9, 1) }, home)
  assert.equal(totals.trims, 2)
  assert.equal(totals.windowsRemoved, 1)
  assert.equal(totals.eventsRemoved, 15)
  assert.equal(readLedger(home).sessions['session-b'].trims.length, 2)
})

test('账本：按日志路径记录时 sessionId 取目录名', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'))
  const logFile = path.join(home, 'sessions', 'ws', 'session-c', 'session.v4.jsonl.zstd')
  fs.mkdirSync(path.dirname(logFile), { recursive: true })
  recordFor(logFile, 'stream', events(5, 1), events(5, 1), { bytesBefore: 500, bytesAfter: 300, home })
  const entry = readLedger(home).sessions['session-c']
  assert.ok(entry, '按目录名记进了 session-c')
  assert.equal(entry.trims[0].mode, 'stream')
  assert.equal(entry.totals.bytesSaved, 200)
})

test('账本：record: false 时不写', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'))
  recordFor('/tmp/x/session-d/session.v4.jsonl.zstd', 'window', events(3), events(2), { record: false, home })
  assert.equal(readLedger(home).sessions['session-d'], undefined)
})

test('账本：坏文件当成空账本，清空后文件消失', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'))
  fs.mkdirSync(path.dirname(ledgerPath(home)), { recursive: true })
  fs.writeFileSync(ledgerPath(home), '{not json')
  assert.deepEqual(readLedger(home).sessions, {})
  recordTrim({ sessionId: 'session-e', mode: 'window', before: events(2), after: events(1) }, home)
  assert.ok(fs.existsSync(ledgerPath(home)))
  assert.equal(clearLedger(home), true)
  assert.equal(fs.existsSync(ledgerPath(home)), false)
})

// 回归：`carriers` 曾经只在 `flattenOnBoot !== false` 的块里声明，折叠默认关时
// 扫描走到「清理已遮蔽要不要跳过」那一行就抛 ReferenceError——/run 直接 400、
// 开机扫描永远完不成。
import { runScan, resolveConfig } from '../lib/index.js'

test('扫描：折叠关着（默认）也能跑完，不再抛 ReferenceError', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-'))
  fs.mkdirSync(path.join(root, 'ws'), { recursive: true })
  const config = resolveConfig({ sessionsRoot: root, isolateRoots: true, flattenOnBoot: false })
  assert.equal(config.flattenOnBoot, false, '折叠关着，正是会踩到的那条路')
  const summary = await runScan(config, {})
  assert.equal(summary.scanned, 0)
  assert.deepEqual(summary.failed, [])
})

test('账本：被裁掉的 usage 记成差额，且可加回真实总量', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'))
  const withUsage = (count, checkpointCount, usage) =>
    events(count, checkpointCount).map((event, index) => (index < 2 ? { ...event, data: { ...event.data, usage } } : event))
  const before = withUsage(10, 2, { inputTokens: 100, outputTokens: 10, totalTokens: 110, cacheReadTokens: 40 })
  const after = before.slice(4)
  const totals = recordTrim({ sessionId: 'session-u', mode: 'window', before, after }, home)
  assert.equal(totals.usage.inputTokens, 200, '被裁掉 2 条 usage')
  assert.equal(totals.usage.outputTokens, 20)
  const entry = readLedger(home).sessions['session-u']
  assert.equal(entry.trims[0].dropped.usage.inputTokens, 200)
  assert.equal(entry.trims[0].dropped.events, 4)
})
