# 日志改写方案：折叠 + 删行 + 重排（每个组件自己的"注释行"）

## 前提（用户的心智模型，也是对的）

会话日志 = 一行一个事件。组件改历史时**不改旧行**，而是在后面追加一行"说明"：

```
第 11 行：user/message  source: { kind: "plugin:dsh-edit-turn" }  surfaceOp: replace(第 3 行)
```

`source.kind` + `surfaceOp` + `sourceEventSeqs` 就是它的**注释**：谁改的、改了哪行、改成了什么。
所以"重写日志"= 把注释行做的事**就地落实**，再删掉注释行，后面的行整体上移。

## 三个组件的做法

| 组件 | 载体里有什么 | 就地落实 | 删掉什么 |
|---|---|---|---|
| edit | **新文本**（`data.message`） | 把新文本抄回被替换的原行（位置不动） | 载体行 + 其 `replace` |
| rerun | 空正文（静默载体） | 旧回复本来就被替换掉；新回复是另一条 append，已在正确位置 | 旧回复行 + 载体行 |
| delete | 空正文 | 无需落实（目标本来就不该存在） | 目标行 + 载体行 |

## 为什么 delete 反而要多想一步

edit 和 rerun 都只动"这一轮里的一条消息"，轮次骨架不动。
delete 有可能是**删掉某轮的提问**——那一轮就没有开场白了：

- 该轮若还有回复，会变成"没有问题的回答"，宿主的轮次结构不认；
- 处理方式二选一：把这一轮整体删掉（提问+回复一起），或把回复并进上一轮。

所以 delete 的改写必须**成组处理轮次**，而不只是删一行。这是它比 edit"麻烦"的唯一原因，
但依然是机械的：删行 → 检查这一轮是否还有开场白 → 没有就成组删/并 → 重排编号。

## 统一管线（三个组件共用）

1. **认出注释行**：`data.source.kind` 以 `plugin:` 开头，且带 `surfaceOp`；
2. **就地落实**：
   - edit → 新文本写回原行；
   - rerun → 什么都不用写（新回复已在表面上）；
   - delete → 什么都不用写（目标是删除）；
3. **成组删除**：载体行 + 它的 `replace` + 目标行；delete 额外检查轮次开场白；
4. **重排编号**：`seq` 连续化、`turn/step` 连续化、所有引用字段（`sourceEventSeqs`、
   `surfaceOp.start/endSeq`、`headerSeq`、`messageSeqs`）同步改写；成对事件（turn/step 括号、
   tool call/result、compaction start/end）保持完整；
5. **验证**：宿主九项校验（装载 + 表面头 + 解码器），失败则原文件一个字节不动。

## 注释约定（每个组件都必须写全，方便定位）

载体行至少带：

- `source.kind`：`plugin:<组件名>`（edit 的改写按平台惯例保留 `kind: 'user'`，另加 `editedBy`）；
- `source.op`：`'edit' | 'delete' | 'rerun'`；
- `source.targetSeqs`：被改/被删/被重跑的行（与 `sourceEventSeqs` 一致）；
- `source.turn`：发生在第几轮；
- edit 额外写 `source.replacedSeq` 与 `source.reason`（可选备注）。

这样任何一份日志都能一眼看出：**哪一行、谁写的、改了什么、改成了什么**。

## 数学：可见轮 ↔ 日志轮（带删除的秩）

**母题名**：带删除元素的秩查询（rank / select with deletions），等价于“墓碑（tombstone）前缀计数”。
区间树、OP 树、分块位图解决的都它；这里轮次只有几十个，直接用一个有序数组即可。

设被整轮删掉的日志轮号构成**墓碑序列** `T = [t1 < t2 < … < tm]`（从各 delete 载体的
`deletedTurn` 读出，按序去重）。那么：

```
可见轮(L) = L − #{ t ∈ T : t < L }
日志轮(V) = 第 V 个不在 T 里的正整数（按序扫描，跳过 T 中的轮）
```

第 k 次 delete 发生在日志轮 i 时，`k = #{t ∈ T : t ≤ i}`，`#{t ∈ T : t < i} = k−1`。
所以“自己是第几次 delete”和“自己前面有多少个 delete”是同一个量，差 1 —— 投影只依赖**前缀计数**：

```
可见轮(L) = L − 前缀计数(L)
```

载体行只需写两个字段即可复原全部信息：

- `source.deletedTurn = i`（第几日志轮被删）
- `source.deleteIndex = k`（它是第几次 delete）

`前缀计数` 由所有 `deletedTurn` 排序后累加得到，不需要额外字段；
`deleteIndex` 用来**校验**墓碑序列没有重复/乱序（`k` 与排序后位置必须一致）。

### 复杂度

- 投影一次扫描 O(m + L)；m ≤ 轮数、L ≤ 轮数，几十个，忽略不计；
- 每次 delete 追加一条墓碑是 O(1)；重算前缀计数 O(m)。

### 为什么不能只记“第几次”

只记 k 不记 i 时，需要靠“第 k 次 delete 之前的可见轮号”反推 i，而可见轮号本身依赖此前的墓碑
——变成解方程。记 i 则是一次减法。两者都记，等于给出**可校验的位置 + 序号**。

## 状态（2026-11-04）

- `flattenEdits` / `flattenReruns` 已删除：实测这三个组件写的是**静默载体**（`data.message` 不存在），
  “换面”没有对象，命中恒为 0——留着只会让人以为已经实现了折叠。
- `lib/tombstone.js` 保留并有测试（`tombstone.test.js`）：它是**读者侧**的参考实现
  （`visibleTurnOf` / `logTurnOf` / `annotateDeletes`），目前没有消费方；
  接线的地方应当是显示层（窗口/轮次视图），不是裁剪器。
- 重写（`mode: 'rebuild'`）仍是 opt-in，默认关；实测重写后的日志九项校验全绿、落到两窗。
