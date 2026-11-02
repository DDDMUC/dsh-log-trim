# dsh-log-trim

启动时自动裁掉空闲会话的历史窗口：只保留最后 N 个窗口，把模型早已看不到的那部分从日志里切掉，**裁剪结果先过宿主自己的三层校验器，验不过就不落盘**。

## 为什么需要它

DSH 的会话日志是只增不减的，而宿主的压缩是**累积**的：每个检查点覆盖前一个，所以更早的窗口对模型早已不可见——它们还压在日志里、还占着对话区的长度。实测一个长会话：

```
裁剪前   13.2 MB   29,497 事件   10 个窗口
裁剪后    4.8 MB    9,302 事件    3 个窗口
模型视图  1000 → 1000（完全不变）
```

**模型看到的内容一条都没少**，少掉的只是"已经折叠进摘要里的旧窗口"。

## 为什么要在"启动时"做

宿主只要打开过某个会话（侧栏点开、标签页恢复），就会持有它的 `session.lock`，**直到进程退出**——切换对话、关掉标签页都不会释放。此时改文件会被随后的写入覆盖。

于是"宿主刚启动、会话还没被打开"是唯一稳定可用的窗口。本插件就在这个窗口里扫一遍。

## 它做什么

1. 列出会话根目录下的所有 `session.v*.jsonl.zstd`；
2. **跳过被持有的**（`session.lock` 被打开）——正在用的会话永远不碰；
3. 试算：裁到 `keepWindows` 会丢多少条、**模型视图会不会变**；
4. 过阈值才动手（条数、占比、模型视图不变）；
5. **先验后写**：裁剪结果写到暂存文件，用宿主自己的校验器验六项——格式层（`dsh-session-format-v3-to-v4`）、会话层（`dsh-session` 的 `adoptSessionEvent` + `foldSurface`）、交叉引用、inbox 投影、结构、标题。任何一项不过就删掉暂存文件，原文件一个字节都不动；
6. 通过才把原文件改名成 `<日志>.precompact-<时间戳>`，暂存文件上位；
7. 按 `backupKeep` 清理旧备份（只动自己命名的那批）。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `scanOnBoot` | `true` | 启动时自动扫一遍 |
| `keepWindows` | `3` | 保留最后几个窗口（只数带检查点的对话窗） |
| `minDroppableEvents` | `500` | 可丢弃事件数低于它就跳过 |
| `minRatio` | `0.2` | 可丢弃占比低于它就跳过 |
| `requireModelUnchanged` | `true` | 模型视图会变就保守跳过 |
| `dryRun` | `false` | 只报告不落盘 |
| `backupKeep` | `1` | 每个日志保留几份备份（`0` = 全留） |
| `sessionsRoot` | `~/.dsh/sessions` | 会话根目录 |

## 路由（仅本机）

```
GET  /api/dsh-log-trim/status   上次扫描结果 + 生效配置
POST /api/dsh-log-trim/run      立刻再扫一遍
```

想手动裁一次又不想等重启：关掉那个会话的标签页（若宿主仍未释放，就退出宿主后在终端跑 `dsh-edit-turn` 的 `tools/compact-session.mjs --apply`）。

## 出问题怎么回退

裁剪前的原文件都在旁边：

```sh
cd ~/.dsh/sessions/<工作区目录>/<会话目录>/
mv session.v4.jsonl.zstd.precompact-<时间戳> session.v4.jsonl.zstd
```

备份是本插件**改名**出来的，不是复制，所以恢复就是改回名字。

## 裁剪内核的来源

`lib/vendor/` 里的三个文件由 `scripts/sync-vendor.mjs` 从
[dsh-edit-turn](https://github.com/DDDMUC/dsh-edit-turn) 的 `tools/` 复制而来（那份 `tools/`
不随 npm 包发布，所以必须复制进来）：

- `compact-session.mjs` —— 窗口裁剪与引用重编（切点退到 `turn/start`、轮次步骤重编号、所有 `*Seq`/`*Seqs`/`*Range` 交叉引用统一重编、compaction 记账按表面现算……）
- `verify-session-log.mjs` —— 六项校验
- `host-libs.mjs` —— 从 `app.asar` 按需取出宿主的校验器（数据段起点是 `8 + headerSize`）

源改了就跑一次 `npm run sync:vendor`。

## 已知边界

- 裁剪**只改日志**：对话区里更早的窗口就看不到了（这是裁剪的语义）。模型侧无损失。
- 被宿主持有的会话一律跳过，所以"启动时没被打开的会话"才会被裁；宿主若恢复了标签页，那些会话要等下一次启动。
- 每次扫描要读全部日志（实测 92 个会话约 20 秒，在启动后台跑）。

### 更新日志

**0.3.0** —— 默认保留 2 窗；新增「无损」裁剪方式（实验性）。

- **`keepWindows` 默认 2、最少 1**。为什么不是 1：一个窗口 = 摘要载体 + **没被替换过的尾巴**，那条尾巴模型还在读。实测某个会话保留 1 窗会丢掉 426 条模型可见的消息；保留 2 窗则不用裁。

- **`mode`**：`window`（默认，按窗口切，会丢上下文）与 `lossless`（实验性）。

- **无损模式的现状，说清楚**：算法已验证可行 —— 只保留表面节点、被替换区间的端点、`sourceEventSeqs`/`headerSeq` 指向的事件，以及被引用到的 turn/step 起点；实测一个 4.1 MB 会话从 8,343 条缩到 4,638 条，**模型可见的消息序列逐条相同**。但它还过不了宿主的格式层：裁剪后 turn/step 编号不再连续，而宿主要求「打开中的 turn 内 step 必须逐个递增」。所以这条路径目前会被校验器整体拒绝（等于不裁）—— 拒绝是正确行为，不写坏文件。

- 因此**默认仍是 `window`**，`lossless` 需要显式选。

**0.2.0** —— 改名 **dsh-log-trim**（中文：日志裁剪）。

- **为什么改名**：原名 `dsh-session-compact` 会被读成"压缩会话上下文"——那是宿主自己的压缩（把旧消息总结成一条摘要）。本插件做的是**另一件事**：把模型早已看不到的旧窗口从**日志文件**里切掉，让文件变小。名字必须自己说明这一点。

- 旧名 **`dsh-session-compact` 已弃用**，功能等价；设置与扫描记忆会从旧目录 `~/.dsh/dsh-session-compact/` **只读迁移**一次，之后的写入只走新目录 `~/.dsh/dsh-log-trim/`。

- 接口前缀随之变为 `/api/dsh-log-trim/*`；设置页仍在「设置 → 插件 → 日志裁剪」那一行的配置箭头里。

**0.1.5** —— 设置卡上架；两个根都能扫了；旧格式日志可以清掉。

- **设置卡（和 dsh-free-search 并排）**：注册在 `plugins.row.config`（键 `dsh-log-trim#dsh-log-trim`）与 `plugins.bundle.config`（键 = 包名），所以「设置 → 插件」里本插件那一行右侧有配置箭头。卡里是 5 个数值 + 4 个开关 + 「保存」「现在扫一遍」「填回默认值」，外加**备份列表**（会话 id / 大小 / 时间 / 目录）和每行一个「打开目录」。

- **配置怎么存**：`cordis.patch.yml` 里那一行的 `config:` 只是**初始值**；卡片保存的值写到 `~/.dsh/dsh-log-trim/config.json` 并优先于它。保存即时生效，不必重启。

- **三个新接口**：`GET/POST /config`（读/存设置）、`POST /trim`（裁**指定**一个会话）、`GET/POST /legacy`（旧格式日志清单；`{"confirm":true}` 才删）。

- **先释放再裁**：被宿主打开的会话以前一律跳过（重启会恢复标签页，于是它永远"正被打开"）。现在 `POST /trim` 会用 `sessions.store.get(id).detach()`（`dsh-session-relocate`、`dsh-delete-session` 生产环境同款缝）请宿主放手，再用**写租约探针**确认真的释放，然后才裁。只有显式请求时这么做，自动扫描仍然跳过被打开的会话。

- **多根自动发现**：`~/.dsh/sessions` 之外的第二套 DSH home（实测 `~/fish2/.dsh`，里面有一个 36.2 MB 的会话）以前根本没被扫过。现在根目录是**发现**出来的：默认家目录 + `DSH_HOME` + `~/*/.dsh/sessions`，不写死任何人的路径。

- **旧格式日志**：一个会话目录可能同时留着 `session.v3.jsonl.zstd`（升级前的）和宿主真正读的 `session.v4`。前者永远不会再被读，裁剪也动不了它 —— 实测一个这样的残留 **9.3 MB 压缩 / 36.6 MB 解压**，全机 6 个共 11.3 MB。现在它们不再被当会话扫，而是单独统计，并由卡片上的「清理旧格式日志」按钮（需要确认）回收。

- **文案与样式**：「最少可丢事件」改成「至少要能省下 500 条」并写清含义；`保留备份数 0` 明确为**一份都不留**（之前文案写反了）；输入框收窄成 96px、自适应网格。

**0.1.2** —— 校验器在宿主里能跑起来了；扫描 68 秒 → 5 秒。

- **一个会话都没裁掉的原因**：`app.asar` 在**运行中的宿主里**被 asar 文件系统接管，按文件去读它会报 `ENOENT ... app.asar`，于是"先验后写"的闸门每次都拒绝写入（这是对的 —— 宁可不动，也不能写一份没验过的日志）。而在宿主里根本不需要解包 asar：平台包本来就 `import` 得到。现在先直接 `import`，取不到才回落到解包（后者是给独立 CLI 用的）。

- **扫描提速**：94 个会话扫了 **68 秒**，因为每个日志都被解开过。加一道大小预筛（默认 1 MB —— 不到这个体积不可能有 4 个窗口），实测 **5.1 秒**。

- 实测（干跑）：扫 94 个会话，判定要裁 1 个（11 窗 → 3 窗，可丢 74.6%），失败 0。

**0.1.1** —— 声明 `dsh.bundle`，profile 才能把它当插件管理。

- 首版只装了依赖（pnpm 把包装进了 profile 的 `node_modules`），但插件管理器报 `not-bundle`：包必须声明 `dsh.bundle`（指向 `cordis.patch.yml`）才会被当作可管理的插件。现在按本仓库其它插件的写法补上 `dsh.bundle` 与 `dsh.engines`。

**0.1.0** —— 第一版：启动时自动裁掉空闲会话的历史窗口。

- **为什么**：DSH 的会话日志只增不减，而宿主的压缩是累积的（每个检查点覆盖前一个），于是更早的窗口对模型早已不可见、却还压在日志里。实测一个长会话从 13.2 MB / 29,497 事件裁到 4.8 MB / 9,302 事件，而**模型视图 1000 → 1000 完全不变**。

- **为什么在启动时**：宿主只要打开过某个会话就会持有它的 `session.lock` 直到进程退出（切换对话、关标签页都不释放），此时改文件会被随后的写入覆盖。"宿主刚启动、会话还没被打开"是唯一稳定可用的窗口。

- **安全措施**：被持有的会话一律跳过；过了阈值（条数 / 占比 / 模型视图必须不变）才动手；**先验后写**——裁剪结果要过宿主自己的六项校验（格式层 `dsh-session-format-v3-to-v4`、会话层 `adoptSessionEvent` + `foldSurface`、交叉引用、inbox 投影、结构、标题），任何一项不过就删掉暂存文件、原文件一个字节都不动；原文件改名成 `<日志>.precompact-<时间戳>` 保留，恢复就是改回名字；`dryRun` 只报告不落盘。

- **裁剪内核**来自 [dsh-edit-turn](https://github.com/DDDMUC/dsh-edit-turn) 的 `tools/`（那份不随 npm 包发布），由 `scripts/sync-vendor.mjs` 同步进 `lib/vendor/`。它做的事远不止截断：切点退到 `turn/start`、轮次与步骤从 1 重编号、系统提示词放进第一对 `turn/start`+`step/start` 之后、所有 `*Seq`/`*Seqs`/`*Range` 交叉引用统一重编（`throughSeq` 除外——它指向别的会话）、compaction 记账按模拟出的表面现算、summary 没了就整组丢、inbox 拼接先重放拿到最终状态。

## English

Compacts idle DSH session logs at startup: keeps the last N windows and drops the ones the model can no longer see. Every result is validated with the host's own format, session and projection validators before it is written; a failed validation leaves the original file untouched. Sessions held by the host (`session.lock`) are always skipped, and the original is kept as `<log>.precompact-<stamp>`.
