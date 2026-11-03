import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULTS, listLogs, logFileOf, planTrim, pruneBackups, readSavedConfig, repairIfCorrupt, resolveConfig, restoreFromBackup, trimOne, writeSavedConfig } from '../lib/index.js'
import { discoverRoots, isCurrentLog, listCurrentLogs, listLegacy } from '../lib/roots.js'
import { checkpointTailStart, foldSurface, keepLastWindows } from '../lib/vendor/compact-session.mjs'
import { rebuildSurface } from '../lib/lossless.js'

test('配置：默认值齐全，非法值被忽略，sessionsRoot 有兜底', () => {
  const resolved = resolveConfig({})
  assert.equal(resolved.keepWindows, DEFAULTS.keepWindows)
  assert.ok(resolved.sessionsRoot.endsWith(path.join('.dsh', 'sessions')), '默认指向 ~/.dsh/sessions')
  const custom = resolveConfig({ keepWindows: 2, minRatio: 0.5, dryRun: true, minDroppableEvents: -5, keepWindowsBad: 1 })
  assert.equal(custom.keepWindows, 2)
  assert.equal(custom.minRatio, 0.5)
  assert.equal(custom.dryRun, true)
  assert.equal(custom.minDroppableEvents, DEFAULTS.minDroppableEvents, '负数不接受')
})

test('配置：重写兜底默认关，要开得显式打开', () => {
  // rebuild 是唯一"凭空造行"的路径，宿主对行的隐式要求漏一个就是整份日志打不开
  // （time、stream、受保护的 system 头，三个都踩过）。默认不自动走它。
  assert.equal(DEFAULTS.rebuildFallback, false, '默认值必须是关')
  assert.equal(resolveConfig({}).rebuildFallback, false)
  assert.equal(resolveConfig({ rebuildFallback: true }).rebuildFallback, true)
  assert.equal(resolveConfig({ rebuildFallback: 'yes' }).rebuildFallback, false, '非布尔值不接受')
  // 显式选 rebuild 模式仍然可用：那是人的决定，不是兜底。
  assert.equal(resolveConfig({ mode: 'rebuild' }).mode, 'rebuild')
})

test('判定：窗口不够不裁', () => {
  const config = resolveConfig({})
  const plan = planTrim({ events: 1000, windows: 2, droppable: 900, modelBefore: 10, modelAfter: 10 }, config)
  assert.equal(plan.should, false, '2 窗等于默认保留数，不裁')
  assert.match(plan.reason, /只有 2 个窗口/)
})

test('判定：可丢弃条数或占比不够不裁', () => {
  const config = resolveConfig({})
  assert.equal(planTrim({ events: 10000, windows: 8, droppable: 499, modelBefore: 10, modelAfter: 10 }, config).should, false)
  const lowRatio = planTrim({ events: 100000, windows: 8, droppable: 600, modelBefore: 10, modelAfter: 10 }, config)
  assert.equal(lowRatio.should, false)
  assert.match(lowRatio.reason, /占比/)
})

test('判定：模型视图会变就保守跳过', () => {
  const config = resolveConfig({})
  const plan = planTrim({ events: 10000, windows: 8, droppable: 5000, modelBefore: 900, modelAfter: 800 }, config)
  assert.equal(plan.should, false)
  assert.match(plan.reason, /模型视图会变/)
  const allowed = planTrim({ events: 10000, windows: 8, droppable: 5000, modelBefore: 900, modelAfter: 800 }, resolveConfig({ requireModelUnchanged: false }))
  assert.equal(allowed.should, true)
})

test('判定：都满足就裁，并说明理由', () => {
  const plan = planTrim({ events: 29497, windows: 10, droppable: 20116, modelBefore: 1000, modelAfter: 1000 }, resolveConfig({}))
  assert.equal(plan.should, true)
  assert.match(plan.reason, /窗口 10 → 2/)
  assert.match(plan.reason, /68\.2%/)
})

// --- the window definition this plugin cuts by -------------------------------

/**
 * One event, shaped the way the host writes them: only content events carry
 * `surfaceOp: 'append'`; the bookkeeping ones (turn/start, checkpoints) carry
 * none, or the replace range the checkpoint performed.
 */
function appended(seq, type, data = {}) {
  const event = { seq, time: seq, type, data }
  if (type !== 'turn/start') event.surfaceOp = 'append'
  return event
}

/** The session header the trimmer has to carry over: it needs real text. */
function systemMessage(seq) {
  return appended(seq, 'system/message', {
    message: { role: 'system', content: [{ type: 'text', text: 'You are DeepSeek Harness.' }] },
  })
}

/**
 * A session with two compactions, laid out the way the host writes one:
 * the checkpoint REPLACES the older range and is FOLLOWED by units it keeps
 * verbatim (the retained tail). Those tail units sit before the checkpoint's own
 * seq, which is exactly why cutting at the checkpoint drops live context.
 */
function twoCompactionSession() {
  // The checkpoint carries the summary text it stands for; an empty one is a
  // silent carrier and would be dropped by the trimmer instead of kept.
  const checkpoint = (seq, compactionId, startSeq, endSeq) => ({
    seq,
    time: seq,
    type: 'user/message',
    data: {
      source: { kind: 'compact-checkpoint', compactionId },
      message: {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'This is an automatically generated checkpoint condensing an earlier span of the conversation (c' + compactionId + ')',
          },
        ],
      },
    },
    surfaceOp: { op: 'replace', startSeq, endSeq },
  })
  return [
    systemMessage(1),
    appended(2, 'turn/start'),
    appended(3, 'user/message'),
    appended(4, 'assistant/message'),
    appended(5, 'turn/start'),
    appended(6, 'user/message'),
    appended(7, 'assistant/message'),
    checkpoint(8, 'c1', 3, 4),
    appended(9, 'turn/start'),
    appended(10, 'user/message'),
    checkpoint(11, 'c2', 5, 8),
    appended(12, 'turn/start'),
    appended(13, 'assistant/message'),
  ]
}

test('窗口：切点落在检查点保留的尾巴起点，而不是检查点自己', () => {
  const events = twoCompactionSession()
  // c2 replaced [5,8] and kept what follows: the window it opens starts at 9.
  assert.equal(checkpointTailStart(events, 11), 9)
  // A checkpoint the log does not describe, or one with no replaced range, keeps
  // its own seq as the boundary.
  assert.equal(checkpointTailStart(events, 999), 999)
  assert.equal(checkpointTailStart([appended(4, 'user/message')], 4), 4)

  const kept = keepLastWindows(events, 1)
  assert.equal(kept.cutSeq, 9, 'the cut is the tail start, snapped back to its turn')
  assert.notEqual(kept.cutSeq, 11, 'cutting at the checkpoint itself is the regression')
  assert.equal(kept.windows, 3, 'the log still had three windows')
  assert.equal(kept.dropped > 0, true, 'and the trim really did remove events')
  for (const seq of [9, 10]) {
    assert.equal(kept.events.some((e) => e.seq === seq), true, 'retained tail unit ' + seq + ' must survive')
  }
  assert.equal(kept.events.some((e) => e.seq === 6), false, 'the earlier window itself does not')
})

test('重写：产出的日志没有替换记录、没有压缩记录，seq 连续', () => {
  const events = twoCompactionSession()
  const rebuilt = rebuildSurface(events)
  assert.equal(rebuilt.some((event) => event.surfaceOp !== undefined && typeof event.surfaceOp === 'object'), false, 'no replace record survives')
  assert.equal(rebuilt.some((event) => String(event.type).startsWith('compaction/')), false, 'no compaction record survives')
  assert.deepEqual(rebuilt.map((event) => event.seq), rebuilt.map((_, index) => index), 'seqs are dense')
  // The visible messages are still all there, in order: the checkpoints become
  // ordinary messages, and the turns are rebuilt around them.
  const visibleBefore = foldSurface(events).visible.length
  const visibleAfter = foldSurface(rebuilt).visible.length
  assert.equal(visibleAfter, visibleBefore, 'the rebuilt log shows the same number of surface nodes')
})

test('重写：每一行都带 time，缺了整份日志都打不开', () => {
  // 宿主的行格式把 time 列为必填（EVENT_REQUIRED），缺一个就
  // `released v2 row 0 lacks required field time`，整份日志拒收。
  // 重写是唯一"凭空造行"的路径，所以这里逐行查。
  const events = twoCompactionSession()
  const rebuilt = rebuildSurface(events)
  for (const event of rebuilt) {
    assert.equal(Number.isSafeInteger(event.time), true, `seq ${event.seq}（${event.type}）缺 time`)
  }
  // 时间线按日志顺序非递减，否则界面里的时间是乱的。
  for (let index = 1; index < rebuilt.length; index += 1) {
    assert.ok(
      rebuilt[index].time >= rebuilt[index - 1].time,
      `seq ${rebuilt[index].seq} 的时间早于上一行（${rebuilt[index].time} < ${rebuilt[index - 1].time}）`,
    )
  }
  // 有源事件的行沿用源事件的时间，而不是统一盖一个 now。
  const sourceTimes = new Set(events.map((event) => event.time))
  const carried = rebuilt.filter((event) => sourceTimes.has(event.time)).length
  assert.ok(carried > rebuilt.length / 2, `沿用源时间的行只有 ${carried}/${rebuilt.length}`)
})

test('重写：assistant/message 保留 stream，否则宿主判 settlement 非法', () => {
  // 宿主的 seed 边界校验（assertAssistantSettlementShape）要求
  // `Array.isArray(data.stream)`；缺了就是
  // `seed assistant/message at index N has invalid settlement fields`，
  // 整份日志打不开。stream 加载时不重放，只原样留着。
  const stream = [{ type: 'chunk', time: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } }]
  const events = [
    systemMessage(1),
    appended(2, 'turn/start'),
    appended(3, 'user/message', { message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
    appended(4, 'assistant/message', {
      turn: 1,
      step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      stream,
    }),
  ]
  const rebuilt = rebuildSurface(events)
  const assistant = rebuilt.filter((event) => event.type === 'assistant/message')
  assert.equal(assistant.length, 1)
  assert.deepEqual(assistant[0].data.stream, stream, 'stream 必须原样带过去')
  assert.equal(Number.isSafeInteger(assistant[0].data.turn), true)
  assert.equal(Number.isSafeInteger(assistant[0].data.step), true)
})

test('还原：外来路径与不合格的备份都拒绝，装不上的日志会被报出来', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-'))
  const logFile = path.join(dir, 'session.v4.jsonl.zstd')
  fs.writeFileSync(logFile, 'garbage')
  const config = resolveConfig({})
  const outside = path.join(os.tmpdir(), path.basename(logFile) + '.precompact-其它会话')
  assert.equal((await restoreFromBackup(logFile, outside, config)).ok, false, 'a backup outside the session dir is refused')
  const bad = logFile + '.precompact-1'
  fs.writeFileSync(bad, 'also garbage')
  const refused = await restoreFromBackup(logFile, bad, config)
  assert.equal(refused.ok, false, 'a backup that cannot load is refused')
  assert.match(String(refused.error), /备份自己就不合格/)
  const repaired = await repairIfCorrupt(logFile, config)
  assert.equal(repaired.failed, true, 'a corrupt log with no usable backup is reported, never silently trimmed')
})

test('重写：可见表面里没有 system 消息时，也要从日志里捞一个顶到最前', () => {
  // 宿主规定表面第一个节点必须是受保护的 system/message；压缩会把旧的 system
  // 消息替换掉，于是它不在 `visible` 里。只从 visible 挑就一个也挑不到，重写出来
  // 的日志表面以 user/assistant 开头，宿主读的时候报
  // `system/message requires a protected first surface head`，整份拒收。
  const events = [
    systemMessage(1),
    appended(2, 'turn/start'),
    appended(3, 'user/message', { message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
    appended(4, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, stream: [] }),
    {
      seq: 5,
      time: 5,
      type: 'user/message',
      data: { turn: 2, message: { role: 'user', content: [{ type: 'text', text: 'checkpoint' }] } },
      surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 },
      sourceEventSeqs: [1],
    },
  ]
  // The fixture really does shadow the head out of the visible surface.
  assert.deepEqual(foldSurface(events).visible, [3, 4, 5])
  const rebuilt = rebuildSurface(events)
  const SURFACE = new Set(['system/message', 'user/message', 'developer/message', 'assistant/message', 'tool/result'])
  const first = rebuilt.find((event) => SURFACE.has(event.type))
  assert.equal(first?.type, 'system/message', '第一个表面节点必须是 system/message')
  assert.equal(first.data.message.content[0].text, 'You are DeepSeek Harness.')
})

test('列举：只认会话日志文件名，目录结构不对就跳过', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-compact-list-'))
  const workspace = path.join(root, '--Users-x--')
  const session = path.join(workspace, 'session-aaaa')
  fs.mkdirSync(session, { recursive: true })
  fs.writeFileSync(path.join(session, 'session.v4.jsonl.zstd'), 'x')
  fs.writeFileSync(path.join(session, 'session.lock'), '')
  fs.writeFileSync(path.join(session, 'session.v4.jsonl.zstd.precompact-2026'), 'backup')
  fs.writeFileSync(path.join(workspace, 'loose.txt'), 'x')
  const logs = listLogs(root)
  assert.deepEqual(logs, [path.join(session, 'session.v4.jsonl.zstd')], '备份和锁文件不算会话日志')
})

test('备份清理：只留最新 N 份，且只动自己命名的那批', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-compact-prune-'))
  const log = path.join(dir, 'session.v4.jsonl.zstd')
  fs.writeFileSync(log, 'x')
  for (const stamp of ['2026-01-01', '2026-01-02', '2026-01-03']) fs.writeFileSync(`${log}.precompact-${stamp}`, stamp)
  fs.writeFileSync(`${log}.broken-2026-01-01`, '别人的备份，不许动')
  const removed = pruneBackups(log, 1)
  assert.deepEqual(removed, ['session.v4.jsonl.zstd.precompact-2026-01-01', 'session.v4.jsonl.zstd.precompact-2026-01-02'])
  assert.equal(fs.existsSync(`${log}.precompact-2026-01-03`), true, '最新的留着')
  assert.equal(fs.existsSync(`${log}.broken-2026-01-01`), true, '不碰别人命名的文件')
})

test('会话日志定位：只认合法 id，找不到就是 null', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-compact-locate-'))
  const sessionDir = path.join(root, 'ws', 'session-abc123')
  fs.mkdirSync(sessionDir, { recursive: true })
  fs.writeFileSync(path.join(sessionDir, 'session.v4.jsonl.zstd'), 'x')
  assert.equal(logFileOf(root, 'session-abc123'), path.join(sessionDir, 'session.v4.jsonl.zstd'))
  assert.equal(logFileOf(root, 'session-nope'), null, '不存在的会话')
  assert.equal(logFileOf(root, '../etc/passwd'), null, '不接受路径穿越')
  assert.equal(logFileOf(root, ''), null, '空 id')
})

test('设置文件：写进去能读回来，只保留已知的键', () => {
  const previous = process.env.HOME
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-compact-home-'))
  process.env.HOME = fakeHome
  try {
    assert.deepEqual(readSavedConfig(), {}, '还没写过时是空对象')
    const resolved = resolveConfig({ keepWindows: 2, dryRun: true })
    assert.equal(writeSavedConfig(resolved), true)
    const back = readSavedConfig()
    assert.equal(back.keepWindows, 2)
    assert.equal(back.dryRun, true)
    assert.equal(Object.keys(back).includes('sessionsRoot'), true, '路径也记住')
    assert.equal(Object.keys(back).includes('nonsense'), false, '多余键不写')
  } finally {
    process.env.HOME = previous
  }
})

test('手动压缩：会话被持有（session.lock 被打开）时拒绝', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-compact-trim-'))
  const log = path.join(dir, 'session.v4.jsonl.zstd')
  fs.writeFileSync(log, 'not a real log')
  const lock = path.join(dir, 'session.lock')
  const handle = fs.openSync(lock, 'w')
  try {
    await assert.rejects(() => trimOne(log, resolveConfig({})), /正被宿主打开/, '被持有的会话必须拒绝')
  } finally {
    fs.closeSync(handle)
  }
})

test('格式判定：只认当前版本，旧版本算“旧格式”', () => {
  assert.equal(isCurrentLog('session.v4.jsonl.zstd'), true)
  assert.equal(isCurrentLog('session.v5.jsonl.zstd'), true, '更新的版本也算当前格式')
  assert.equal(isCurrentLog('session.v3.jsonl.zstd'), false, '旧版本不是当前日志')
  assert.equal(isCurrentLog('session.lock'), false)
  assert.equal(isCurrentLog('session.v4.jsonl.zstd.precompact-2026-01-01'), false, '备份不是日志')
})

test('多根发现：默认根 + 家目录下第二套 .dsh 都会被找到', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-compact-roots-'))
  const previous = process.env.HOME
  const previousDshHome = process.env.DSH_HOME
  process.env.HOME = home
  delete process.env.DSH_HOME
  try {
    fs.mkdirSync(path.join(home, '.dsh', 'sessions', 'ws', 'session-a'), { recursive: true })
    fs.mkdirSync(path.join(home, 'second', '.dsh', 'sessions', 'ws', 'session-b'), { recursive: true })
    const roots = discoverRoots()
    assert.equal(roots.length, 2, '两个根')
    assert.ok(roots.some((root) => root.endsWith(path.join('.dsh', 'sessions'))))
    assert.ok(roots.some((root) => root.includes('second')))
    // 旧格式只在旧格式清单里出现，不混进当前日志
    const legacyDir = path.join(home, '.dsh', 'sessions', 'ws', 'session-a')
    fs.writeFileSync(path.join(legacyDir, 'session.v4.jsonl.zstd'), 'x')
    fs.writeFileSync(path.join(legacyDir, 'session.v3.jsonl.zstd'), 'old')
    const current = roots.flatMap((root) => listCurrentLogs(root))
    assert.equal(current.length, 1, '只列出 v4')
    const legacy = listLegacy(path.join(home, '.dsh', 'sessions'))
    assert.equal(legacy.length, 1, 'v3 被单独列出')
    assert.equal(legacy[0].version, 3)
  } finally {
    process.env.HOME = previous
    if (previousDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousDshHome
  }
})
