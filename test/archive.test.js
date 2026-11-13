import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { appendArchive, archiveInfo, archivePathOf, readArchive } from '../lib/archive.js'
import { encodeLogAsync, readLogAsync, renumber } from '../lib/vendor/compact-session.mjs'

/** 造一个合法的会话日志，返回路径与事件。 */
async function session(turns) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshlt-archive-'))
  const logFile = path.join(dir, 'session.v4.jsonl.zstd')
  const events = []
  let seq = 0
  for (let turn = 1; turn <= turns; turn += 1) {
    events.push({ type: 'turn/start', seq: seq++, time: 1000 + seq, data: { turn } })
    events.push({ type: 'step/start', seq: seq++, time: 1000 + seq, data: { turn, step: 1 } })
    events.push({
      type: 'user/message',
      seq: seq++,
      time: 1000 + seq,
      data: { message: { id: `u${turn}`, role: 'user', content: [{ type: 'text', text: `q${turn}` }] }, turn, step: 1 },
    })
    events.push({
      type: 'assistant/message',
      seq: seq++,
      time: 1000 + seq,
      data: { turn, step: 1, message: { id: `a${turn}`, role: 'assistant', content: [{ type: 'text', text: `a${turn}` }] } },
    })
    events.push({ type: 'step/end', seq: seq++, time: 1000 + seq, data: { turn, step: 1 } })
    events.push({ type: 'turn/end', seq: seq++, time: 1000 + seq, data: { turn } })
  }
  const header = { type: 'session', version: 4, id: path.basename(dir), cwd: dir, createdAt: 1 }
  fs.writeFileSync(logFile, await encodeLogAsync(header, events))
  return { dir, logFile, events }
}

test('第一次追加把全部事件写进档案，档案在 .archive/ 子目录里', async () => {
  const { logFile, events } = await session(2)
  const result = appendArchive(logFile, events)
  assert.equal(result.added, events.length)
  assert.equal(readArchive(logFile).length, events.length)
  assert.match(archivePathOf(logFile), /\.archive\/session\.v4\.jsonl\.zstd$/)
  // 档案不能和会话日志同目录同名，否则宿主会把它当成一个会话。
  assert.notEqual(path.dirname(archivePathOf(logFile)), path.dirname(logFile))
})

test('重复追加不会写重复事件（第二次是 0）', async () => {
  const { logFile, events } = await session(2)
  appendArchive(logFile, events)
  const again = appendArchive(logFile, events)
  assert.equal(again.added, 0)
  assert.equal(readArchive(logFile).length, events.length)
})

test('裁剪后重新编号再追加：靠内容判重，不会重复记一遍', async () => {
  const { logFile, events } = await session(3)
  appendArchive(logFile, events)
  // 模拟窗口裁剪：只留最后一轮，seq 全部重编。
  const kept = renumber(events.slice(-6)).events
  const result = appendArchive(logFile, kept)
  assert.equal(result.added, 0, '同一批事件换了 seq 也不该再追加')
  assert.equal(readArchive(logFile).length, events.length)
})

test('新的一轮会追加成第二个 zstd 帧，读取时两帧都能解出来', async () => {
  const { logFile, events } = await session(2)
  appendArchive(logFile, events)
  const before = fs.statSync(archivePathOf(logFile)).size
  const extra = { type: 'user/message', seq: 99, time: 9999, data: { message: { id: 'u9', role: 'user', content: [{ type: 'text', text: 'later' }] } } }
  const result = appendArchive(logFile, [extra])
  assert.equal(result.added, 1)
  const size = fs.statSync(archivePathOf(logFile)).size
  assert.ok(size > before, '文件变长，而不是整份重写')
  // 帧数：每个 zstd 帧都以 28 b5 2f fd 开头。
  const buf = fs.readFileSync(archivePathOf(logFile))
  let frames = 0
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) frames += 1
  }
  assert.equal(frames, 2, '两次追加 = 两个帧')
  assert.equal(readArchive(logFile).length, events.length + 1, '跨帧读回全部事件')
})

test('档案统计报告大小、事件数与时间跨度', async () => {
  const { logFile, events } = await session(2)
  assert.equal(archiveInfo(logFile), null, '没裁剪过就没有档案')
  appendArchive(logFile, events)
  const info = archiveInfo(logFile)
  assert.equal(info.events, events.length)
  assert.ok(info.bytes > 0)
  assert.equal(info.from, Math.min(...events.map((event) => event.time)))
  assert.equal(info.to, Math.max(...events.map((event) => event.time)))
})

test('会话日志本身不受档案影响', async () => {
  const { logFile, events } = await session(2)
  appendArchive(logFile, events)
  const live = await readLogAsync(logFile)
  assert.equal(live.events.length, events.length, '读会话日志仍是原来的事件数')
  assert.equal(live.header?.type, 'session')
})

/** 一份真实的合法会话日志（21 条事件，含标题与两条消息），用来验证「还原」这条链路。 */
const REAL = path.join(import.meta.dirname, 'fixtures', 'session-real.jsonl.zstd')

test('用档案整份还原：校验通过、事件数等于档案', async () => {
  const { restoreFullFromArchive, resolveConfig } = await import('../lib/index.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshlt-archive-real-'))
  const logFile = path.join(dir, 'session.v4.jsonl.zstd')
  fs.copyFileSync(REAL, logFile)
  const live = await readLogAsync(logFile)
  appendArchive(logFile, live.events)
  const result = await restoreFullFromArchive(logFile, resolveConfig({}))
  assert.equal(result.ok, true, result.error)
  assert.equal(result.events, live.events.length)
  const after = await readLogAsync(logFile)
  assert.equal(after.events.length, live.events.length)
  assert.ok(fs.readdirSync(dir).some((name) => name.includes('precompact')), '落盘前留了快照')
})
