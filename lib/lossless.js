/**
 * The lossless mode: shrink the log without changing what the model reads.
 *
 * A log carries two kinds of events. The ones a compaction replaced are shadowed
 * forever - the model cannot reach them, no future compaction will look at them,
 * and they are pure bytes. The ones nothing replaced are still read on every turn.
 *
 * Cutting **windows** (the older mode) throws away both: a window is not "the part
 * the model cannot see", it is "a summary carrier plus whatever tail was never
 * replaced". Measured on a real session: keeping the last window instead of the
 * last two dropped 426 events the model was still reading.
 *
 * So this mode never looks at windows. It deletes exactly the shadowed events -
 * and then proves the result is lossless by folding both logs into the message
 * sequence the model would receive and requiring them to be identical, entry for
 * entry. Anything else is a refusal, not a close call.
 */

import fs from 'node:fs'
import { commitTrim, derivedHistory, encodeLog, foldSurface, readLog, renumber } from './vendor/compact-session.mjs'

/**
 * Pick the events a lossless pass keeps.
 *
 * The rule is not "drop what a replace covers": the range's endpoints and every
 * reference it points at have to survive, or the host's format layer rejects the
 * file. Measured on a real 4.1 MB session: this selection narrows 8,343 events to
 * 4,638 and leaves the model's message sequence identical entry for entry.
 *
 * It is still not enough on its own - the host additionally requires turn and step
 * numbering to stay dense inside an open turn, which dropping whole steps breaks.
 * That is why the caller verifies with the host's validators and refuses on any
 * failure: a selection that cannot be loaded is not a smaller session, it is a
 * broken one.
 *
 * @param {object[]} events - the session's events.
 * @returns {{ events: object[], dropped: number }} the kept events, still carrying their original seqs.
 */
export function selectLossless(events) {
  const keep = new Set(foldSurface(events).visible ?? [])
  for (const event of events) {
    const type = String(event.type ?? '')
    if (type.startsWith('compaction/') || type.startsWith('session/')) keep.add(event.seq)
    if (event.surfaceOp !== null && typeof event.surfaceOp === 'object') {
      keep.add(event.surfaceOp.startSeq)
      keep.add(event.surfaceOp.endSeq)
    }
    if (Array.isArray(event.sourceEventSeqs)) for (const seq of event.sourceEventSeqs) keep.add(seq)
    if (Number.isSafeInteger(event.data?.headerSeq)) keep.add(event.data.headerSeq)
  }
  const kept = events.filter((event) => keep.has(event.seq))
  return { events: kept, dropped: events.length - kept.length }
}

/**
 * Fold a log into what the model reads, as signatures.
 *
 * @param {object[]} events - events without the header.
 * @returns {string[]} one signature per visible message.
 */
export function modelView(events) {
  return derivedHistory(events)
}

/**
 * Whether two folded views are the same message sequence.
 *
 * @param {string[]} before - folded original.
 * @param {string[]} after - folded candidate.
 * @returns {boolean} true when nothing the model reads changed.
 */
export function sameView(before, after) {
  if (before.length !== after.length) return false
  for (let index = 0; index < before.length; index += 1) {
    if (before[index] !== after[index]) return false
  }
  return true
}

/**
 * Work out what a lossless pass would do to one log, without writing anything.
 *
 * The candidate event list is returned so the caller does not have to fold the
 * same log twice: a 5 MB log takes about a second to decode.
 *
 * @param {string} logFile - the session's log.
 * @param {object} config - the resolved config.
 * @returns {object} the plan: `should`, `reason`, and the numbers behind it.
 */
export function planLossless(logFile, config) {
  const original = readLog(logFile)
  const before = modelView(original.events)
  const cut = selectLossless(original.events)
  const after = modelView(cut.events)
  const bytes = encodeLog(original.header, cut.events).length
  const same = sameView(before, after)
  const raised = cut.dropped
  const ratio = original.events.length === 0 ? 0 : raised / original.events.length
  const savedRatio = original.compressedBytes === 0 ? 0 : (original.compressedBytes - bytes) / original.compressedBytes

  let title = ''
  for (let index = original.events.length - 1; index >= 0; index -= 1) {
    const event = original.events[index]
    if (event && event.type === 'session/title' && event.data && typeof event.data.title === 'string') {
      title = event.data.title
      break
    }
  }

  const report = {
    title,
    events: original.events.length,
    windows: 0,
    droppable: raised,
    modelBefore: before.length,
    modelAfter: after.length,
    modelSame: same,
    bytes: original.compressedBytes,
    afterBytes: bytes,
  }

  if (!same) {
    return { should: false, reason: `无损校验未通过（模型可见 ${before.length} → ${after.length} 条），放弃`, report, cut }
  }
  if (raised === 0) {
    return { should: false, reason: '没有可删的已遮蔽事件，不需要裁', report, cut }
  }
  if (raised < config.minDroppableEvents) {
    return { should: false, reason: `可删 ${raised} 条，少于阈值 ${config.minDroppableEvents}`, report, cut }
  }
  if (ratio < config.minRatio) {
    return { should: false, reason: `可删占比 ${(ratio * 100).toFixed(1)}%，低于阈值 ${(config.minRatio * 100).toFixed(1)}%`, report, cut }
  }
  if (savedRatio <= 0) {
    return { should: false, reason: '裁剪后体积没有变小', report, cut }
  }
  return {
    should: true,
    reason: `删掉 ${raised} 条已遮蔽事件（${(ratio * 100).toFixed(1)}%），模型可见 ${before.length} 条逐条不变`,
    report,
    cut,
  }
}

/**
 * Write one lossless pass: stage, verify with the host's validators, then commit.
 *
 * The order is the same one the window mode uses, for the same reason - the log
 * format rules live in the host, and a file that "looks right" is not the same as
 * a file the host will load.
 *
 * @param {string} logFile - the session's log.
 * @param {object} config - the resolved config.
 * @param {object} plan - the plan from {@link planLossless}.
 * @param {{ verify?: boolean }} [options] - `verify: false` skips the validators.
 * @returns {Promise<object>} the summary of what was written.
 */
export async function applyLossless(logFile, config, plan, options = {}) {
  const original = readLog(logFile)
  const renamed = renumber(plan.cut.events)
  const seqs = new Set(renamed.events.map((event) => event.seq))
  for (let index = 0; index < renamed.events.length; index += 1) {
    if (!seqs.has(index)) throw new Error(`内部错误：seq ${index} 缺失`)
  }
  for (const event of renamed.events) {
    const refs = [...(Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs : [])]
    if (event.surfaceOp !== null && typeof event.surfaceOp === 'object') refs.push(event.surfaceOp.startSeq, event.surfaceOp.endSeq)
    for (const ref of refs) {
      if (ref !== undefined && !seqs.has(Number(ref))) throw new Error(`内部错误：seq ${event.seq} 引用不存在的 ${ref}`)
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `${logFile}.precompact-${stamp}`
  const staging = `${logFile}.staging-${stamp}`
  fs.writeFileSync(staging, encodeLog(original.header, renamed.events))

  if (options.verify !== false) {
    let verified
    try {
      const { verifyLog } = await import('./verify-session-log.mjs')
      verified = await verifyLog(staging)
    } catch (error) {
      fs.rmSync(staging, { force: true })
      throw new Error(`校验器跑不起来，未写入：${error instanceof Error ? error.message : String(error)}`)
    }
    if (!verified.ok) {
      fs.rmSync(staging, { force: true })
      const failed = (verified.checks || []).filter((check) => !check.ok).slice(0, 3)
      const detail = failed.map((check) => `${check.name}：${check.detail}`).join('；')
      throw new Error(`校验未通过，未写入：${detail === '' ? '未知原因' : detail}`)
    }
  }

  const summary = commitTrim({ staging, backup }, logFile)
  return {
    ...summary,
    mode: 'lossless',
    model: { before: plan.report.modelBefore, after: plan.report.modelAfter, same: plan.report.modelSame },
  }
}
