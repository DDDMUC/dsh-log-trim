import { test } from 'node:test'
import assert from 'node:assert/strict'
import { flattenHistory } from '../lib/flatten.js'
import { rebuildSurface } from '../lib/lossless.js'
import { assertGoalEventsKept, orphanGoalRounds, stripOrphanGoalSources } from '../lib/goal-repair.js'

const GOAL_ID = 'goal-3be59a73-1c5d-4658-bd32-e08c5350943e'

/** 一个 goal/change 快照（与宿主的落盘形状一致）。 */
function changeEvent(seq, time, operation, revision, roundsStarted, phase = 'active') {
  return {
    seq,
    time,
    type: 'goal/change',
    data: {
      kind: 'goal/change',
      version: 1,
      operation,
      goal: { id: GOAL_ID, revision, objective: '修好前端', phase, maxGoalRounds: 256 },
      roundsStarted,
      createdAt: time - 1000,
      updatedAt: time,
    },
  }
}

/** 一轮目标续跑：普通 user/message，靠 source 认领目标。 */
function goalRound(seq, time, revision, round, text = '继续') {
  return {
    seq,
    time,
    type: 'user/message',
    data: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'goal', goalId: GOAL_ID, revision, round } },
    surfaceOp: 'append',
  }
}

function message(seq, time, type, text, extra = {}) {
  return {
    seq,
    time,
    type,
    data: { turn: 1, step: 1, message: { role: type === 'user/message' ? 'user' : 'assistant', content: [{ type: 'text', text }] }, ...extra },
    surfaceOp: 'append',
  }
}

/**
 * 两轮目标会话：创建 → 第 1 轮 → 编辑（rev2）→ 第 2 轮。
 *
 * @returns {object[]} 事件（seq 与 time 都递增）。
 */
function goalSession() {
  return [
    { seq: 0, time: 1000, type: 'system/message', data: { message: { role: 'system', content: [{ type: 'text', text: 'sys' }] } }, surfaceOp: 'append' },
    { seq: 1, time: 1001, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, time: 1002, type: 'step/start', data: { turn: 1, step: 1 } },
    changeEvent(3, 1003, 'create', 1, 0),
    goalRound(4, 1004, 1, 1),
    message(5, 1005, 'assistant/message', 'a1'),
    { seq: 6, time: 1006, type: 'step/end', data: { turn: 1, step: 1 } },
    { seq: 7, time: 1007, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    { seq: 8, time: 1008, type: 'turn/start', data: { turn: 2 } },
    { seq: 9, time: 1009, type: 'step/start', data: { turn: 2, step: 1 } },
    changeEvent(10, 1010, 'edit', 2, 1),
    goalRound(11, 1011, 2, 2),
    message(12, 1012, 'assistant/message', 'a2'),
    { seq: 13, time: 1013, type: 'step/end', data: { turn: 2, step: 1 } },
    { seq: 14, time: 1014, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
  ]
}

test('重写：goal/change 与目标轮次的相对顺序保留，回放不再报孤儿', () => {
  // 重写路径旧行为：从可见表面重建，goal/change 不是表面节点，被整条丢掉，
  // 而目标轮次（user/message）留着 —— 目标投影回放时整份日志报错。
  const rebuilt = rebuildSurface(goalSession())
  const changes = rebuilt.filter((event) => event.type === 'goal/change')
  assert.equal(changes.length, 2, '两个 goal/change 都要留下')
  assert.deepEqual(changes.map((event) => event.data.operation), ['create', 'edit'], '顺序保持')
  const order = rebuilt.map((event) => event.type === 'goal/change' ? `chg:${event.data.operation}` : event.type)
  const create = order.indexOf('chg:create')
  const round1 = order.indexOf('user/message')
  const edit = order.indexOf('chg:edit')
  const round2 = order.lastIndexOf('user/message')
  assert.ok(create < round1, 'create 必须在第 1 轮之前')
  assert.ok(round1 < edit, '编辑必须仍在第 1 轮之后')
  assert.ok(edit < round2, '编辑必须在第 2 轮之前')
  assert.deepEqual(orphanGoalRounds(rebuilt), [], '重写后的日志回放得出零个孤儿轮次')
  assert.deepEqual(rebuilt.map((event) => event.seq), rebuilt.map((_, index) => index), 'seq 仍然密集')
})

test('重写：折叠（flatten）之后 goal/change 也还在', () => {
  const events = goalSession()
  // 一轮 rerun 载体：它盖掉第 1 轮的回答，折叠会重建整份日志。
  const target = events.find((event) => event.type === 'assistant/message')
  events.push({
    seq: events.length,
    time: 2000,
    type: 'user/message',
    data: { message: { role: 'user', content: [{ type: 'text', text: '\u200b' }] }, source: { kind: 'plugin:dsh-rerun-turn' } },
    surfaceOp: { op: 'replace', startSeq: target.seq, endSeq: target.seq },
    sourceEventSeqs: [target.seq],
  })
  const { events: out } = flattenHistory(events)
  assert.equal(out.some((event) => event.type === 'goal/change'), true, '折叠不能吃掉目标快照')
  assert.deepEqual(orphanGoalRounds(out), [])
})

test('识别：没有 goal/change 时，目标轮次全是孤儿', () => {
  const events = goalSession().filter((event) => event.type !== 'goal/change')
  const orphans = orphanGoalRounds(events)
  assert.deepEqual(orphans, [4, 11], '两条轮次都指向不存在/不匹配的目标')
})

test('识别：完整的目标生命周期没有孤儿', () => {
  assert.deepEqual(orphanGoalRounds(goalSession()), [])
  // clear 之后再出现的轮次同样是孤儿（目标已经没了）。
  const cleared = goalSession()
  cleared.push(changeEvent(cleared.length, 2000, 'clear', 3, 2).valueOf())
  cleared.at(-1).data.operation = 'clear'
  cleared.at(-1).data.cleared = { id: GOAL_ID, revision: 3 }
  delete cleared.at(-1).data.goal
  cleared.at(-1).data.clearedAt = 2000
  cleared.push(goalRound(cleared.length, 2001, 3, 3))
  assert.deepEqual(orphanGoalRounds(cleared), [cleared.length - 1])
})

test('修复：只把孤儿轮次的 source 改回普通用户，内容与 seq 不动', () => {
  const events = goalSession().filter((event) => event.type !== 'goal/change')
  const orphans = orphanGoalRounds(events)
  const repaired = stripOrphanGoalSources(events, orphans)
  assert.deepEqual(repaired.map((event) => event.seq), events.map((event) => event.seq), 'seq 不变')
  for (const event of repaired) {
    if (orphans.includes(event.seq)) {
      assert.deepEqual(event.data.source, { kind: 'user' }, '孤儿轮次变成普通用户消息')
      assert.deepEqual(event.data.content, events.find((old) => old.seq === event.seq).data.content, '正文不变')
    } else {
      assert.equal(event, events.find((old) => old.seq === event.seq), '其余事件保持原对象')
    }
  }
  assert.deepEqual(orphanGoalRounds(repaired), [], '修完之后没有孤儿')
})

test('修复：没有孤儿时原样返回同一份事件', () => {
  const events = goalSession()
  assert.equal(stripOrphanGoalSources(events, []), events)
})

test('守卫：裁剪只要会让目标事件变少就必须拒绝', () => {
  const events = goalSession()
  assert.doesNotThrow(() => assertGoalEventsKept(events, events), '没删目标事件就放行')
  assert.doesNotThrow(
    () => assertGoalEventsKept(events, events.filter((event) => event.type !== 'assistant/message')),
    '只删普通消息放行',
  )
  const withoutSnapshot = events.filter((event) => event.type !== 'goal/change')
  assert.throws(() => assertGoalEventsKept(events, withoutSnapshot), /目标事件/)
  const withoutRound = events.filter((event) => event.seq !== 11)
  assert.throws(() => assertGoalEventsKept(events, withoutRound), /目标事件/)
  // 一条目标事件都没有的会话不受影响。
  assert.doesNotThrow(() => assertGoalEventsKept([{ seq: 0, type: 'turn/start' }], []))
})
