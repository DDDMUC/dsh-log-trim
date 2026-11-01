/**
 * dsh-session-compact —— 启动时自动裁掉空闲会话的历史窗口。
 *
 * ## 为什么需要它
 *
 * 宿主的压缩是**累积**的：每个检查点覆盖前一个，所以更早的窗口对模型早已不可见，
 * 却还压在日志里、还显示在对话区。实测一个会话能涨到 13 MB，裁掉前 7 窗后剩 4.8 MB
 * 而**模型看到的内容完全不变**。
 *
 * 但这件事有个绕不开的时间窗：宿主只要打开过某个会话（侧栏点开、标签页恢复），就会
 * 持有它的 `session.lock` 直到进程退出，此时改文件会被随后的写入覆盖。而"宿主刚启动、
 * 会话还没被打开"是唯一稳定可用的窗口——所以这个插件在**启动时**扫一遍。
 *
 * ## 安全措施
 *
 * - 被持有的会话一律跳过（`session.lock` 被打开）；
 * - 达到阈值才裁（可丢弃事件数、占比，以及"模型视图必须完全不变"）；
 * - **先验后写**：裁剪结果要先过宿主自己的三层校验器（格式层 / 会话层 / 投影层），
 *   任何一项不过就删掉暂存文件、原文件一个字节都不动；
 * - 原文件改名成 `<日志>.precompact-<时间戳>` 保留，可随时改回；
 * - `dryRun` 只报告不落盘。
 *
 * 路由（仅本机）：
 *   GET  /api/dsh-session-compact/status   上次扫描结果 + 生效配置
 *   POST /api/dsh-session-compact/run      立刻再扫一遍（返回本次摘要）
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyTrim, foldSurface, isSessionLocked, keepLastWindows, readLog } from './vendor/compact-session.mjs'

export const name = 'dsh-session-compact'
export const PLUGIN_ID = name
export const PLUGIN_VERSION = '0.1.2'
export const ROUTE_PREFIX = '/api/dsh-session-compact'

/**
 * Where the per-file verdicts are remembered.
 *
 * A boot scan reads every candidate log (19 of them are over a megabyte, and
 * decoding one costs one to two seconds), so the second boot used to spend half a
 * minute re-deciding what it had already decided. The verdict is remembered per
 * file keyed by its size and mtime: a log that has not moved cannot have gained a
 * window, and a trimmed log's mtime changes, so it is looked at again.
 */
const MEMORY_FILE = 'dsh-session-compact/scan-memory.json'

/** Where the settings card's values are kept. */
const CONFIG_FILE = 'dsh-session-compact/config.json'

/**
 * The settings the card has saved, on top of whatever the patch declares.
 *
 * The patch block is a row's INITIAL value: a fresh install is configured there,
 * a running one through the card. The file wins so a save survives a restart even
 * though the patch is never rewritten.
 *
 * @returns {object} the saved values (partial, unknown keys dropped later).
 */
export function readSavedConfig() {
  try {
    const file = path.join(os.homedir(), '.dsh', CONFIG_FILE)
    if (!fs.existsSync(file)) return {}
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Persist the settings card's values.
 *
 * @param {object} config - the full resolved config to remember.
 * @returns {boolean} whether it was written.
 */
export function writeSavedConfig(config) {
  try {
    const file = path.join(os.homedir(), '.dsh', CONFIG_FILE)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const kept = {}
    for (const key of Object.keys(DEFAULTS)) kept[key] = config[key]
    fs.writeFileSync(file, `${JSON.stringify(kept, null, 2)}\n`)
    return true
  } catch {
    return false
  }
}

/**
 * Trim one session on demand, with the same guard rails the boot scan uses:
 * a held session is refused, the result is verified, the original is kept as a
 * backup.
 *
 * @param {string} logFile - the session's log.
 * @param {number} keepWindows - how many windows to keep.
 * @param {number} backupKeep - how many backups to keep afterwards.
 * @returns {Promise<object>} what happened.
 */
export async function trimOne(logFile, keepWindows, backupKeep) {
  if (isSessionLocked(logFile)) {
    throw new Error('这个会话正被宿主打开着（session.lock）。先切到别的对话或重启 DSH，再压缩它')
  }
  const before = fs.statSync(logFile).size
  const result = await applyTrim(logFile, keepWindows)
  const pruned = pruneBackups(logFile, backupKeep)
  return {
    sessionId: path.basename(path.dirname(logFile)),
    before: { events: result.before.events, bytes: before, windows: result.before.windows },
    after: { events: result.after.events, bytes: result.after.bytes },
    dropped: result.dropped,
    model: result.model,
    backup: path.basename(result.backup),
    prunedBackups: pruned,
  }
}

/**
 * The log file of one session id under a sessions root.
 *
 * @param {string} root - sessions root.
 * @param {string} sessionId - the session id.
 * @returns {string|null} the log path, or null.
 */
export function logFileOf(root, sessionId) {
  if (typeof sessionId !== 'string' || !/^session-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId)) return null
  for (const logFile of listLogs(root)) {
    if (path.basename(path.dirname(logFile)) === sessionId) return logFile
  }
  return null
}

/** 默认配置。 */
export const DEFAULTS = {
  enabled: true,
  scanOnBoot: true,
  keepWindows: 3,
  minDroppableEvents: 500,
  minBytes: 1048576,
  minRatio: 0.2,
  requireModelUnchanged: true,
  dryRun: false,
  backupKeep: 1,
  sessionsRoot: '',
}

/**
 * 合并用户配置。
 *
 * @param {object} raw - 用户配置。
 * @returns {object} 生效配置。
 */
export function resolveConfig(raw = {}) {
  const merged = { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS)) {
    const value = raw[key]
    if (value === undefined || value === null) continue
    if (key === 'minBytes') {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) merged[key] = value
      continue
    }
    if (key === 'sessionsRoot') {
      if (typeof value === 'string') merged.sessionsRoot = value
      continue
    }
    if (typeof value === 'boolean') merged[key] = value
    else if (typeof value === 'number' && Number.isFinite(value) && value >= 0) merged[key] = value
  }
  if (merged.sessionsRoot === '') merged.sessionsRoot = path.join(os.homedir(), '.dsh', 'sessions')
  return merged
}

/**
 * 判断一个会话该不该裁（纯函数，便于测试）。
 *
 * @param {{ events: number, windows: number, droppable: number, modelBefore: number, modelAfter: number }} report - 试算结果。
 * @param {object} config - 生效配置。
 * @returns {{ should: boolean, reason: string }} 结论与理由。
 */
export function planTrim(report, config) {
  if (report.windows <= config.keepWindows) return { should: false, reason: `只有 ${report.windows} 个窗口，不需要裁` }
  if (report.droppable < config.minDroppableEvents) {
    return { should: false, reason: `可丢弃 ${report.droppable} 条，少于阈值 ${config.minDroppableEvents}` }
  }
  const ratio = report.events === 0 ? 0 : report.droppable / report.events
  if (ratio < config.minRatio) {
    return { should: false, reason: `可丢弃占比 ${(ratio * 100).toFixed(1)}%，低于阈值 ${(config.minRatio * 100).toFixed(1)}%` }
  }
  if (config.requireModelUnchanged && report.modelBefore !== report.modelAfter) {
    return { should: false, reason: `模型视图会变（${report.modelBefore} → ${report.modelAfter}），保守跳过` }
  }
  return { should: true, reason: `窗口 ${report.windows} → ${config.keepWindows}，可丢弃 ${report.droppable} 条（${(ratio * 100).toFixed(1)}%）` }
}

/**
 * 列出候选日志文件。
 *
 * @param {string} root - 会话根目录。
 * @returns {string[]} 日志文件路径。
 */
/**
 * Read the remembered verdicts.
 *
 * @returns {Record<string, { size: number, mtimeMs: number, verdict: string, reason: string }>} the memory.
 */
export function readMemory() {
  try {
    const file = path.join(os.homedir(), '.dsh', MEMORY_FILE)
    if (!fs.existsSync(file)) return {}
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Write the remembered verdicts back.
 *
 * @param {object} memory - the memory to store.
 */
export function writeMemory(memory) {
  try {
    const file = path.join(os.homedir(), '.dsh', MEMORY_FILE)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(memory))
  } catch {
    // A scan that cannot remember is still a correct scan.
  }
}

export function listLogs(root) {
  if (!fs.existsSync(root)) return []
  const out = []
  for (const workspace of fs.readdirSync(root)) {
    const workspaceDir = path.join(root, workspace)
    let entries
    try {
      if (!fs.statSync(workspaceDir).isDirectory()) continue
      entries = fs.readdirSync(workspaceDir)
    } catch {
      continue
    }
    for (const entry of entries) {
      const sessionDir = path.join(workspaceDir, entry)
      let files
      try {
        if (!fs.statSync(sessionDir).isDirectory()) continue
        files = fs.readdirSync(sessionDir)
      } catch {
        continue
      }
      for (const file of files) {
        if (!/^session\.v\d+\.jsonl\.zstd$/.test(file)) continue
        out.push(path.join(sessionDir, file))
      }
    }
  }
  return out
}

/**
 * 试算一个日志：裁到 keepWindows 会丢多少、模型视图变不变。
 *
 * @param {string} logFile - 日志文件。
 * @param {number} keepWindows - 保留最后几窗。
 * @returns {object} 试算结果。
 */
export function estimate(logFile, keepWindows) {
  const log = readLog(logFile)
  const trimmed = keepLastWindows(log.events, keepWindows)
  const before = foldSurface(log.events).visible.length
  const after = trimmed.cutSeq === null ? before : foldSurface(trimmed.events).visible.length
  return {
    events: log.events.length,
    bytes: log.compressedBytes,
    windows: trimmed.windows,
    cutSeq: trimmed.cutSeq,
    droppable: trimmed.dropped,
    modelBefore: before,
    modelAfter: after,
    sessionId: log.header?.id ?? path.basename(path.dirname(logFile)),
  }
}

/**
 * 清理旧备份，只留最新的 keep 份（只动本插件自己命名的那批）。
 *
 * @param {string} logFile - 日志文件。
 * @param {number} keep - 保留份数。
 * @returns {string[]} 被删掉的备份。
 */
export function pruneBackups(logFile, keep) {
  const dir = path.dirname(logFile)
  const prefix = `${path.basename(logFile)}.precompact-`
  let names
  try {
    names = fs.readdirSync(dir).filter((n) => n.startsWith(prefix))
  } catch {
    return []
  }
  names.sort()
  const doomed = names.slice(0, Math.max(0, names.length - keep))
  for (const name of doomed) {
    try {
      fs.rmSync(path.join(dir, name), { force: true })
    } catch {
      // 删不掉就算了：备份多留一份不是问题。
    }
  }
  return doomed
}

/**
 * 扫一遍并（按配置）裁剪。
 *
 * @param {object} config - 生效配置。
 * @param {{ info?: Function, warn?: Function }} [logger] - 日志器。
 * @returns {Promise<object>} 本次摘要。
 */
export async function runScan(config, logger = {}) {
  const started = Date.now()
  const summary = { startedAt: new Date().toISOString(), scanned: 0, trimmed: [], skipped: [], failed: [], savedBytes: 0, dryRun: config.dryRun }
  const memory = readMemory()
  const remember = {}
  for (const logFile of listLogs(config.sessionsRoot)) {
    summary.scanned += 1
    const sessionId = path.basename(path.dirname(logFile))
    if (isSessionLocked(logFile)) {
      summary.skipped.push({ sessionId, reason: '正被宿主打开（session.lock）' })
      continue
    }
    // A log smaller than `minBytes` cannot hold four windows, and reading it out
    // is the expensive half of a scan: 94 sessions took 68 s when every one was
    // decoded, and almost all of them are tiny.
    let bytes = 0
    try {
      bytes = fs.statSync(logFile).size
    } catch {
      summary.skipped.push({ sessionId, reason: '读不到文件大小' })
      continue
    }
    if (bytes < config.minBytes) {
      summary.skipped.push({ sessionId, reason: `只有 ${Math.round(bytes / 1024)} KB，不可能有 4 个窗口` })
      continue
    }
    let mtimeMs = 0
    try {
      mtimeMs = fs.statSync(logFile).mtimeMs
    } catch {
      mtimeMs = 0
    }
    const known = memory[logFile]
    if (!config.dryRun && known !== undefined && known.size === bytes && known.mtimeMs === mtimeMs) {
      // Same bytes, same mtime: the answer cannot have changed.
      remember[logFile] = known
      if (known.verdict === 'skip') {
        summary.skipped.push({ sessionId, reason: known.reason })
      } else if (known.verdict === 'fail') {
        summary.failed.push({ sessionId, reason: known.reason })
      }
      continue
    }
    let report
    try {
      report = estimate(logFile, config.keepWindows)
    } catch (error) {
      summary.failed.push({ sessionId, reason: `读不出来：${error instanceof Error ? error.message : String(error)}` })
      continue
    }
    const plan = planTrim(report, config)
    if (!plan.should) {
      remember[logFile] = { size: bytes, mtimeMs, verdict: 'skip', reason: plan.reason }
      summary.skipped.push({ sessionId, reason: plan.reason })
      continue
    }
    if (config.dryRun) {
      summary.trimmed.push({ sessionId, dryRun: true, reason: plan.reason, before: report.bytes, after: report.bytes, events: [report.events, report.events - report.droppable] })
      continue
    }
    try {
      const result = await applyTrim(logFile, config.keepWindows)
      const pruned = pruneBackups(logFile, config.backupKeep)
      summary.savedBytes += Math.max(0, result.before.bytes - result.after.bytes)
      summary.trimmed.push({
        sessionId,
        reason: plan.reason,
        before: result.before.bytes,
        after: result.after.bytes,
        events: [result.before.events, result.after.events],
        windows: result.before.windows,
        backup: path.basename(result.backup),
        prunedBackups: pruned,
      })
    } catch (error) {
      summary.failed.push({ sessionId, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  if (!config.dryRun) writeMemory(remember)
  summary.ms = Date.now() - started
  const line = `扫 ${summary.scanned} 个会话：裁 ${summary.trimmed.length}，跳过 ${summary.skipped.length}，失败 ${summary.failed.length}，省 ${(summary.savedBytes / 1048576).toFixed(1)} MB（${summary.ms} ms）`
  if (typeof logger.info === 'function') logger.info(`[dsh-session-compact] ${line}`)
  return summary
}

/**
 * 只允许本机访问（路由不该对外暴露）。
 *
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @returns {boolean} 允许返回 true。
 */
function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * Cordis 插件入口。
 *
 * @param {object} ctx - 插件上下文。
 * @param {object} [config] - 用户配置。
 */
export function apply(ctx, config = {}) {
  // The card can change these while the host runs, so the resolved values live in
  // a box the routes can replace instead of a frozen const.
  let resolved = resolveConfig({ ...config, ...readSavedConfig() })
  const state = { last: null, running: false }

  /** Replace the live config (a save from the card) and report what took effect. */
  const reload = (patch) => {
    resolved = resolveConfig({ ...resolved, ...patch })
    return resolved
  }

  const run = async () => {
    if (state.running) return state.last
    state.running = true
    try {
      state.last = await runScan(resolved, ctx.logger ?? {})
      return state.last
    } finally {
      state.running = false
    }
  }

  if (resolved.enabled && resolved.scanOnBoot) {
    // 启动就扫：这是"会话还没被打开"的那个窗口。
    ctx.effect(() => {
      let cancelled = false
      void (async () => {
        try {
          await run()
        } catch (error) {
          if (!cancelled && typeof ctx.logger?.warn === 'function') {
            ctx.logger.warn(`[dsh-session-compact] 扫描失败：${error instanceof Error ? error.message : String(error)}`)
          }
        }
      })()
      return () => {
        cancelled = true
      }
    })
  }

  /** Read a JSON body, bounded: this route is a settings form, not an upload. */
  const readJsonBody = (req, limit = 64 * 1024) =>
    new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > limit) {
          reject(new Error('请求体太大'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8').trim()
          resolve(text === '' ? {} : JSON.parse(text))
        } catch (error) {
          reject(error)
        }
      })
      req.on('error', reject)
    })

  const sendJson = (res, status, body) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify(body))
  }

  const registerRoutes = (webServer, fiber) => {
    fiber.effect(() =>
      webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/status`,
        handler: (req, res) => {
          if (!isLoopback(req)) {
            res.statusCode = 403
            res.end('loopback only')
            return
          }
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ ok: true, version: PLUGIN_VERSION, config: resolved, running: state.running, last: state.last }, null, 2))
        },
      }),
    )
    fiber.effect(() =>
      webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/run`,
        handler: async (req, res) => {
          if (!isLoopback(req)) {
            res.statusCode = 403
            res.end('loopback only')
            return
          }
          if (req.method !== 'POST') {
            res.statusCode = 405
            res.end('POST only')
            return
          }
          const result = await run()
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ ok: true, result }, null, 2))
        },
      }),
    )
    // The settings card's own bridge: read the live values, write them back. Kept
    // separate from `/status` so a save never has to look like a scan.
    fiber.effect(() =>
      webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/config`,
        handler: async (req, res) => {
          if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' })
          if (req.method === 'GET') {
            return sendJson(res, 200, { ok: true, config: resolved, defaults: DEFAULTS, version: PLUGIN_VERSION })
          }
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'GET or POST' })
          try {
            const body = await readJsonBody(req)
            const next = reload(body !== null && typeof body === 'object' ? body : {})
            const saved = writeSavedConfig(next)
            sendJson(res, 200, { ok: true, config: next, saved })
          } catch (error) {
            sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        },
      }),
    )

    // Trim ONE session, now. This is the "choose a conversation and compress it"
    // entry the card and the tooling use: it refuses a held session, verifies the
    // result before writing, and keeps the original as a backup.
    fiber.effect(() =>
      webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/trim`,
        handler: async (req, res) => {
          if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' })
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
          try {
            const body = await readJsonBody(req)
            const sessionId = String((body && body.sessionId) || '').trim()
            if (sessionId === '') return sendJson(res, 400, { ok: false, error: 'sessionId required' })
            const logFile = logFileOf(resolved.sessionsRoot, sessionId)
            if (logFile === null) return sendJson(res, 404, { ok: false, error: '找不到这个会话的日志' })
            const keep = Number.isSafeInteger(body && body.keep) && body.keep > 0 ? Math.min(body.keep, 50) : resolved.keepWindows
            const result = await trimOne(logFile, keep, resolved.backupKeep)
            if (typeof ctx.logger?.info === 'function') {
              ctx.logger.info(`[dsh-session-compact] 手动压缩 ${sessionId}：${result.before.events} → ${result.after.events} 事件`)
            }
            sendJson(res, 200, { ok: true, ...result })
          } catch (error) {
            sendJson(res, 409, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        },
      }),
    )

  }

  const webServer = ctx.get('webServer')
  if (webServer !== undefined && webServer !== null) registerRoutes(webServer, ctx)
  else ctx.inject(['webServer'], (sub) => registerRoutes(sub.webServer, sub))
}
