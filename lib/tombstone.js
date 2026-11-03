/**
 * 可见轮 ↔ 日志轮：带删除的秩。
 *
 * 删掉一整轮之后，界面上的轮号和日志里的轮号就分叉了。两者之间只有一个量：
 * **这个位置前面有多少个轮被删过**（墓碑前缀计数）。
 *
 *     可见轮(L) = L − #{ t ∈ T : t < L }
 *     日志轮(V) = 第 V 个不在 T 里的正整数
 *
 * 第 k 次 delete 落在日志轮 i 时，k = 自己前面 delete 数 + 1，所以“第几次”和
 * “前面有多少个”是同一个量，差一：投影只依赖前缀计数，`deleteIndex` 用来校验
 * 墓碑序列没有重复/乱序。
 *
 * @typedef {{ turn: number, index: number, seq: number }} Tombstone
 */

const DELETE_KIND = 'plugin:dsh-delete-turn'

/**
 * 从日志里读出墓碑序列（被整轮删掉的日志轮号，按轮升序）。
 *
 * 认两种写法：新载体直接带 `source.deletedTurn`；老载体只带 `source.turn`，
 * 那就把 `turn` 当被删的那一轮（整轮 delete 一直如此）。
 *
 * @param {object[]} events - 会话事件。
 * @returns {Tombstone[]} 按轮升序、去重后的墓碑。
 */
export function tombstonesOf(events) {
  const seen = new Map()
  for (const event of events) {
    const source = event?.data?.source
    if (source === null || source === undefined) continue
    if (source.kind !== DELETE_KIND && source.op !== 'delete') continue
    const turn = Number.isSafeInteger(source.deletedTurn) ? source.deletedTurn : source.turn
    if (!Number.isSafeInteger(turn) || turn < 1) continue
    if (seen.has(turn)) continue
    seen.set(turn, { turn, index: 0, seq: event.seq })
  }
  const sorted = [...seen.values()].sort((left, right) => left.turn - right.turn)
  sorted.forEach((entry, position) => {
    entry.index = position + 1
  })
  return sorted
}

/**
 * 日志轮号 → 可见轮号；这一轮自己被删掉时返回 null。
 *
 * @param {Tombstone[]} tombstones - 墓碑序列（升序）。
 * @param {number} logTurn - 日志轮号。
 * @returns {number|null} 可见轮号。
 */
export function visibleTurnOf(tombstones, logTurn) {
  if (!Number.isSafeInteger(logTurn) || logTurn < 1) return null
  let before = 0
  for (const tombstone of tombstones) {
    if (tombstone.turn === logTurn) return null
    if (tombstone.turn > logTurn) break
    before += 1
  }
  return logTurn - before
}

/**
 * 可见轮号 → 日志轮号。
 *
 * @param {Tombstone[]} tombstones - 墓碑序列（升序）。
 * @param {number} visibleTurn - 可见轮号（≥1）。
 * @returns {number|null} 对应的日志轮号；超出范围时为 null。
 */
export function logTurnOf(tombstones, visibleTurn) {
  if (!Number.isSafeInteger(visibleTurn) || visibleTurn < 1) return null
  const dead = new Set(tombstones.map((tombstone) => tombstone.turn))
  let logTurn = 0
  let visible = 0
  // 轮次是几十的量级；上界给一个足够大的窗口，避免死循环。
  while (logTurn < 100000) {
    logTurn += 1
    if (dead.has(logTurn)) continue
    visible += 1
    if (visible === visibleTurn) return logTurn
  }
  return null
}

/**
 * 给 delete 载体补齐标注（`deletedTurn` / `deleteIndex` / `visibleAfter`）。
 *
 * 只改 `data.source`，不动正文，也不改 `surfaceOp`：标注是“注释”，不是替换。
 *
 * @param {object[]} events - 会话事件（不会被修改）。
 * @returns {{ events: object[], tombstones: Tombstone[] }} 新事件数组与墓碑序列。
 */
export function annotateDeletes(events) {
  const tombstones = tombstonesOf(events)
  const byTurn = new Map(tombstones.map((tombstone) => [tombstone.turn, tombstone]))
  const out = events.map((event) => {
    const source = event?.data?.source
    if (source === null || source === undefined) return event
    if (source.kind !== DELETE_KIND && source.op !== 'delete') return event
    const turn = Number.isSafeInteger(source.deletedTurn) ? source.deletedTurn : source.turn
    const tombstone = turn === undefined ? undefined : byTurn.get(turn)
    if (tombstone === undefined) return event
    const after = visibleTurnOf(tombstones, tombstone.turn + 1)
    return {
      ...event,
      data: {
        ...event.data,
        source: {
          ...source,
          op: 'delete',
          deletedTurn: tombstone.turn,
          deleteIndex: tombstone.index,
          visibleAfter: after,
        },
      },
    }
  })
  return { events: out, tombstones }
}
