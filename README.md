# 地方口述史事件年表（Oral Chronicle）

供地方口述史团队本机使用的事件年表 Web 应用。编辑者录入**事件**、带**出处**的时间主张（可精确到年 / 月 / 日），以及事件之间的**「先于」关系**；同一事件可以保留多条互相矛盾的主张。发布时为每个事件选定一条主张，系统检查全部先后关系后生成**不可变版本**。访客只能看到最新已发布年表。

- 技术栈：Node.js（Express）+ SQLite（better-sqlite3）+ 浏览器原生界面（无需前端构建）

## 一键启动（Docker Compose，推荐）

```bash
docker compose up -d --build
```

启动即完成：安装依赖、初始化 SQLite 数据库（自动建表）、挂载持久化数据卷。
Compose 默认 `SEED_DEMO=1`，首次启动会写入一组演示草稿（3 个事件，含矛盾主张），方便体验发布流程。

访问地址：

| 用途 | 地址 |
| --- --- | --- |
| 访客年表（只读最新已发布版本） | http://localhost:3000/ |
| 编辑者工作台 | http://localhost:3000/editor |
| 最新发布快照 JSON | http://localhost:3000/api/public/chronicle |

编辑者口令默认在 `docker-compose.yml` 中为 `change-me-please`，**请修改后使用**：在编辑台右上角输入口令并保存（仅保存在该浏览器 localStorage 中，请求以 `X-Editor-Token` 头发送）。

停止与查看日志：

```bash
docker compose logs -f
docker compose down            # 保留数据卷
docker compose down -v         # 同时删除数据库数据卷
```

## 不用 Docker，本机直接运行

要求 Node.js ≥ 20。

```bash
npm install
npm start                     # 默认 http://localhost:3000
# 可选：写入演示草稿
npm run seed
npm test                      # 运行求解器与接口测试
```

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址（本机直跑可设 `127.0.0.1`） |
| `EDITOR_TOKEN` | `editor` | 编辑者口令，生产使用务必修改 |
| `DB_PATH` | `./data/chronicle.db`（容器内 `/app/data/chronicle.db`） | SQLite 数据库文件路径，目录自动创建 |
| `SEED_DEMO` | 未设置 | 设为 `1` 时启动写入演示草稿（仅在库为空时） |

改端口示例：

```bash
PORT=8080 EDITOR_TOKEN=my-secret npm start
# 访客 http://localhost:8080/ ，编辑 http://localhost:8080/editor
```

## 使用方式

### 编辑（http://localhost:3000/editor）

1. 右上角输入编辑者口令并保存。
2. 在「事件与时间主张」中添加事件；每个事件可添加**任意多条**时间主张，每条必须填写出处（受访人 / 访谈时间 / 档案全宗 / 页码等），矛盾说法可用「考异备注」记录。
3. 用单选按钮为**每个**事件选定一条拟发布主张（选择只保存在当前浏览器中）。
4. 在「先于」关系中声明 A 严格先于 B，可附出处。
5. 「校验能否发布」先预览；「发布新版本」正式生成不可变快照。

### 发布规则（为什么会发布失败）

粗精度日期按其覆盖的闭区间处理：

- 精确到**年**（如「1958 年」）：区间 `1958-01-01 ~ 1958-12-31`
- 精确到**月**（如「1958 年 3 月」）：区间 `1958-03-01 ~ 1958-03-31`
- 精确到**日**：区间即当天

发布时，系统为每个事件在其选定主张的区间内确定一个**具体日期**，并要求每条「先于」关系两端**严格相差至少一天**（不允许同一天）。以下情况会拒绝发布，错误面板会标明涉事事件与关系（点击可定位），**上一已发布版本保持不变**：

1. **缺少主张**：有事件未选定主张（或选定了已删除 / 不属于该事件的主张）；
2. **关系成环**：「先于」关系构成有向环（含自环，自环在录入时即被禁止）；
3. **时间无解**：区间内不存在满足全部严格先后关系的具体日期。错误信息会给出一条导致矛盾的见证链，例如「冬月会议 先于 春月会议」却分别主张 1958 年 12 月、1958 年 1 月。

发布成功后得到递增版本号（第 1 版、第 2 版……），事件、所选主张（精度、区间、出处、考异）、关系与求解日期全部**复制进版本快照**；此后修改草稿不影响任何旧版本。访客页只展示当前最新版本。

### 上传 JSON 采访整理包（预览 → 确认，整包追加）

编辑台左侧「上传 JSON 采访整理包」支持把一次访谈整理成果批量入库。导入是**追加**而非替换：不清空、不覆盖任何已有草稿、历史快照与访客视图；导入的新事件同样需要逐事件选定主张、通过现有先后校验后才能发布。

**包格式（UTF-8 JSON 对象）：**

```json
{
  "batchId": "interview-2026-09",
  "events": [
    {
      "key": "e1",
      "title": "土地改革动员",
      "description": "可选描述",
      "claims": [
        { "precision": "day", "year": 1950, "month": 12, "day": 3, "source": "陈阿婆 2021-06-01 访谈，录音 1 段", "note": "记得下雪" },
        { "precision": "year", "year": 1951, "source": "《乡志》第 42 页" }
      ]
    },
    { "key": "e2", "title": "初级社成立",
      "claims": [ { "precision": "month", "year": 1952, "month": 3, "source": "老账本，全宗 8，案卷 17" } ] }
  ],
  "relations": [ { "earlierKey": "e1", "laterKey": "e2", "source": "多位老人回忆一致" } ]
}
```

- `batchId`：批次标识，非空字符串（≤200 字）。**全库唯一，成功导入后永久不可再次导入**（跨重启生效）。
- `events[].key`：包内唯一键，非空字符串；`title` 必填；`claims` 可多条且允许互相矛盾。
- 每条主张：`precision` 为 `year`/`month`/`day`；`year` 必填（1–9999），月/日精度分别需要合法的 `month`、`day`（如 2 月 30 日非法）；`source` 出处必填（受访人 / 访谈时间 / 档案全宗 / 页码等），`note` 考异备注可选。
- `relations` 可省略（等价于空数组），每项以 `earlierKey`/`laterKey` 引用包内事件，自相引用（`x` 先于 `x`）非法；`source`/`note` 可选。允许重复边。

流程与冲突约定（与「从历史版本恢复草稿」一致）：

1. **预览只读**：`POST /api/editor/import-preview`（请求体即包本身）。返回将追加的全部事件/主张/关系、数量（`counts`）、当前草稿修订号 `draftRevisionNo`、以及对规范化包内容取的 **SHA-256 内容指纹 `fingerprint`**；预览不写任何数据。
   键重复、关系引用缺失、自相引用、日期或出处非法、批次标识缺失等问题会在一次响应中**全部列出**（422 `errors:[{type,...}]`），整包拒绝。预览同时返回 `batchAlreadyImported` 标记该批次是否曾导入。
2. **确认追加**：`POST /api/editor/import-commit`，体含 **`pkg`（原包）、`fingerprint`、`draftRevisionNo`（均取预览返回值）**。服务器重新校验原包并重算指纹，在**一个事务**内整包追加，返回：
   - `idMap.events`：包内 `key` → 新草稿 `eventId` 及各主张 `claimId`（按包内 `index`）；
   - `idMap.relations`：每条关系的新 `relationId` 与两端新事件 id；
   - 新草稿修订号 `revisionNo`（整包只推进一次修订号）。
3. **冲突保护（均 409，不写入任何数据，需重新预览再确认）**：
   - `PACKAGE_CHANGED`：提交的原包与预览时不一致（重算指纹不符，即内容被替换）；
   - `DRAFT_REVISION_CONFLICT`：预览与确认之间草稿被任何人增删改过（修订号变化）；
   - `BATCH_ALREADY_IMPORTED`：该 `batchId` 已成功导入过。

导入后：历史快照与访客年表不变；草稿里的新事件在编辑台逐事件选定主张，沿用现有「校验能否发布 → 发布新版本」与 `baseVersionNo` 冲突约定。

**curl 调用示例：**

```bash
# 1) 只读预览（请求体就是包本身）
curl -s -X POST http://localhost:3000/api/editor/import-preview \
  -H 'Content-Type: application/json' -H 'X-Editor-Token: change-me-please' \
  --data-binary @interview-batch.json > preview.json

# preview.json 中取 fingerprint 与 draftRevisionNo
# 2) 确认：原包 + 内容指纹 + 草稿修订号
node -e '
const fs=require("fs");
const pv=JSON.parse(fs.readFileSync("preview.json","utf8"));
fs.writeFileSync("commit.json", JSON.stringify({
  pkg: JSON.parse(fs.readFileSync("interview-batch.json","utf8")),
  fingerprint: pv.fingerprint,
  draftRevisionNo: pv.draftRevisionNo,
}));'
curl -s -X POST http://localhost:3000/api/editor/import-commit \
  -H 'Content-Type: application/json' -H 'X-Editor-Token: change-me-please' \
  --data-binary @commit.json
```

### 从历史版本恢复草稿（预览 → 确认）

编辑台右侧「已发布版本」中，每个版本都有「预览并恢复草稿」按钮。恢复**不产生新版本、不改动任何历史快照**，只替换草稿区：

1. **预览（只读）**：弹窗双栏列出——
   - 该版的事件、每个事件在**当版被选的那一条时间主张**（精度、区间、出处、考异）、全部「先于」关系；
   - 当前草稿中将被替换掉的全部事件（含未选主张）与关系，以及草稿修订号、最新版本号。
   预览不写任何数据。
2. **确认恢复**：请求必须提交预览时返回的**草稿修订号**与**最新版本号**。确认成功时系统在一个事务内**原子替换整个草稿**：清空当前草稿的事件 / 主张 / 关系，按该版快照重建，并**只恢复当版被选的主张**（同一事件其它未选主张不恢复）。返回：
   - 旧快照 id → 新草稿 id 的映射（事件、主张、关系）；
   - 每事件一条的**待选主张**，编辑台据此自动填好单选；
   - 新草稿修订号（每次恢复只推进一次修订号）。
3. **冲突保护**：确认前若草稿被任何人增删改过（修订号变化），或期间发布了更新的版本（最新版本号变化），返回 **409**（`DRAFT_REVISION_CONFLICT` / `VERSION_CONFLICT`）且**不改动任何数据**，需重新预览再确认；目标版本不存在返回 404。

草稿的任何增、删、改都会推进草稿修订号（含恢复本身）。恢复后：

- **历史快照与访客年表保持不变**（访客仍看当前最新发布版）；
- 草稿仅含该版内容，仍需「校验能否发布」后正式发布才会公开；
- 发布仍遵守现有编辑口令、求解校验与 `baseVersionNo` 冲突约定——恢复的是更旧的版本时，请以**当前最新版本号**为 `baseVersionNo` 发布，否则同样收到 409。

### 两名编辑者并发修改（版本冲突）

发布请求必须带 `baseVersionNo`（编辑台打开时自动记录当前最新版本号）。若两名编辑者都从第 N 版开始改，第一人发布产生第 N+1 版后，第二人仍以 `baseVersionNo=N` 提交时：

- 服务器返回 **409 版本冲突**，编辑台弹出冲突框，告知对方发布的第 N+1 版概况；
- **不会**静默覆盖对方版本；
- 第二人需点击「刷新到最新版本并重新确认选择」，重新核对每个事件的主张单选后再发布。

### 访客（http://localhost:3000/）

只渲染最新已发布版本：按系统确定的日期排列的时间线、每条事件所选主张的精度与出处、全部「先于」关系及其出处。草稿、未发布主张、未发布关系均不出现在任何公开接口中。尚无发布版本时仅显示「尚未发布」。

## 数据与备份

- 单文件 SQLite 数据库：容器中位于 `/app/data/chronicle.db`（Docker 卷 `chronicle-data`），本机直跑位于 `./data/chronicle.db`。
- 备份：停止写入后复制该 `.db` 文件即可（或使用 SQLite 的 `.backup` 命令）。
- 历史版本表 `versions / version_events / version_relations` 只追加、不更新不删除，保证不可变。
- 导入批次台账 `imported_batches` 同样只追加：记录每个成功导入的 `batchId` 与内容指纹，使同一批次永久不可重复导入。

## 目录结构

```
src/
  server.js     Express 入口、口令中间件、静态界面
  routes.js     公开只读 API 与编辑者草稿/发布/恢复 API
  db.js         SQLite 连接与建表（草稿区 + 草稿修订号触发器 + 版本快照区）
  dates.js      年/月/日精度 → 覆盖区间（公历序数日）
  solver.js     Tarjan 环检测 + 拓扑下界传播求严格先后可行解
  publish.js    发布事务：再校验 + 版本冲突检查 + 写不可变快照
  restore.js    恢复草稿：只读预览 + 原子替换事务（修订号/版本号冲突检查、按快照重建）
  import.js     JSON 采访整理包：整包校验 + 内容指纹 + 只读预览 + 单事务整包追加（批次去重台账）
  seed.js       演示数据
public/         访客页与编辑台（原生 HTML/CSS/JS）
test/           node:test 单元与端到端测试（含成环、无解、409 冲突、草稿恢复）
```

## 主要 HTTP API

公开（无口令）：

- `GET /api/public/chronicle` — 最新已发布版本完整快照
- `GET /api/public/versions` / `GET /api/public/versions/:no` — 版本清单 / 指定版本

编辑（需请求头 `X-Editor-Token`）：

- `GET  /api/editor/state` — 草稿全貌 + 当前版本号 + 草稿修订号 `draftRevisionNo`
- 事件：`POST /api/editor/events`、`PUT/DELETE /api/editor/events/:id`
- 主张：`POST /api/editor/events/:id/claims`、`PUT/DELETE /api/editor/claims/:claimId`
- 关系：`POST /api/editor/relations`、`DELETE /api/editor/relations/:id`
- `POST /api/editor/validate` — 预校验（不落库）
- `POST /api/editor/publish` — 发布；体含 `selection:[{eventId,claimId}]`、`baseVersionNo`、`editor`、`note`
  - 422：`{errors:[{type:missing|cycle|temporal, eventIds, relationIds, message, detail}]}`
  - 409：`{code:"VERSION_CONFLICT", baseVersionNo, currentVersionNo, currentVersion}`
- `GET  /api/editor/restore-preview/:no` — 从第 `:no` 版恢复草稿的只读预览（该版被选内容 + 将被替换的当前草稿），返回 `draftRevisionNo`、`currentVersionNo`；版本不存在 404
- `POST /api/editor/restore` — 确认恢复；体含 `versionNo`、`draftRevisionNo`、`currentVersionNo`（后两者取预览返回值）
  - 200：`{restoredFromVersionNo, currentVersionNo, revisionNo, idMap:{events,relations}, pendingSelection:[{eventId,claimId}], draft}`
  - 409：`{code:"DRAFT_REVISION_CONFLICT"|"VERSION_CONFLICT", ...}`（草稿或最新版本在确认前变化，数据不变）；版本不存在 404；参数非法 400
- `POST /api/editor/import-preview` — JSON 采访整理包只读预览；请求体即包 `{batchId, events:[{key,title,description,claims:[{precision,year,month,day,source,note}]}], relations:[{earlierKey,laterKey,source,note}]}`
  - 200：`{ok:true, batchId, fingerprint, counts:{eventCount,claimCount,relationCount}, draftRevisionNo, currentVersionNo, batchAlreadyImported, events, relations}`
  - 422：`{ok:false, errors:[{type,index,key,claimIndex|relationIndex,message}]}`，type ∈ `invalid_batch|duplicate_key|invalid_event|invalid_claim|invalid_date|invalid_source|invalid_relation|missing_relation_key|self_relation`，整包拒绝、不写入
- `POST /api/editor/import-commit` — 确认导入；体含 `pkg`（原包）、`fingerprint`、`draftRevisionNo`（后两者取预览返回值）
  - 201：`{ok:true, batchId, fingerprint, counts, baseRevisionNo, revisionNo, currentVersionNo, idMap:{events:[{key,eventId,claims:[{index,claimId}]}], relations:[{index,relationId,earlierKey,laterKey,earlierEventId,laterEventId}]}}`
  - 409：`{code:"PACKAGE_CHANGED"|"DRAFT_REVISION_CONFLICT"|"BATCH_ALREADY_IMPORTED", ...}`（内容被替换、草稿已变化或批次曾导入，均不写入）；422：同预览的整包校验错误；参数非法 400
