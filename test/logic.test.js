import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULTS, listLogs, logFileOf, planTrim, pruneBackups, readSavedConfig, resolveConfig, trimOne, writeSavedConfig } from '../lib/index.js'
import { discoverRoots, isCurrentLog, listCurrentLogs, listLegacy } from '../lib/roots.js'

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
