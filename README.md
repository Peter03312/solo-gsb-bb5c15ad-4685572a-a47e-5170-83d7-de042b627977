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
2. 可直接逐条录入；也可在顶部「上传 JSON 采访整理包」按批次一次导入多个事件、多条主张与「先于」关系（先预览、后确认，详见[下文](#上传-json-采访整理包预览--确认整包事务追加)）。
3. 在「事件与时间主张」中添加事件；每个事件可添加**任意多条**时间主张，每条必须填写出处（受访人 / 访谈时间 / 档案全宗 / 页码等），矛盾说法可用「考异备注」记录。
4. 用单选按钮为**每个**事件选定一条拟发布主张（选择只保存在当前浏览器中）。
5. 在「先于」关系中声明 A 严格先于 B，可附出处。
6. 「校验能否发布」先预览；「发布新版本」正式生成不可变快照。

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

### 上传 JSON 采访整理包（预览 → 确认，整包事务追加）

编辑台顶部「上传 JSON 采访整理包」卡片支持一次性导入一个批次。整理包是一个 JSON 对象：

- `batchId`：**批次标识**（非空字符串）。同一标识一旦成功导入即登记在只追加的导入台账中，再次导入返回冲突。
- `events`：事件数组，每个事件以包内唯一的 `key` 标记，含 `title`、可选 `description`、以及 `claims` 时间主张数组（每事件至少一条）；每条主张含精度 `precision`（`year` / `month` / `day`）、`year`、按精度需要的 `month` / `day`、必填的 `source` 出处、可选 `note` 考异。
- `relations`：「先于」关系数组，每项以 `earlierKey` / `laterKey` **按键引用**包内事件，可附 `source` / `note`。

示例：

```json
{
  "batchId": "interview-2026-q3-01",
  "events": [
    {
      "key": "dongyuan",
      "title": "修水渠动员会",
      "description": "大队在晒谷场召开动员会",
      "claims": [
        { "precision": "day", "year": 1958, "month": 9, "day": 12, "source": "李宝山口述，2021-07-05 访谈，录音 03 段 08:12", "note": "中秋节后第三天" },
        { "precision": "year", "year": 1958, "source": "《县水利志》1994 年版第 87 页" }
      ]
    },
    {
      "key": "tongshui",
      "title": "东干渠通水",
      "claims": [
        { "precision": "month", "year": 1959, "month": 5, "source": "王秀兰口述，2021-08-02 访谈" }
      ]
    }
  ],
  "relations": [
    { "earlierKey": "dongyuan", "laterKey": "tongshui", "source": "二人口述一致" }
  ]
}
```

流程与保证：

1. **只读预览**：先调预览接口（或在编辑台选文件 / 粘贴 JSON 后点「只读预览待写入内容」）。响应列出规范化后的事件、主张（含精度、覆盖区间、出处）、关系，事件 / 主张 / 关系**数量**，当前草稿数量、草稿修订号 `draftRevisionNo` 与**内容指纹** `fingerprint`（对包内容做稳定序列化后的 SHA-256，与 JSON 字段书写顺序无关）。预览不写任何数据。
2. **整包校验**：出现下列任一问题，预览（及确认）返回 **422**，`errors` 数组**一次性列出全部问题**（带 `type`、位置 `location`、`eventKey` / 主张下标）并**整包拒绝**，不写入任何内容：
   - `duplicate_key`：事件键在包内重复；
   - `missing_reference`：关系的 `earlierKey` / `laterKey` 在包内事件中不存在；
   - `self_relation`：事件先于自身；
   - `invalid_date`：精度非法、年月日越界或与精度不符（如 2 月 30 日、13 月）；
   - `invalid_source`：主张缺少非空出处；另有 `invalid_key` / `invalid_title` / `invalid_claims` / `invalid_field` / `malformed_*` 等结构问题。
3. **确认导入**：必须提交**原包**、预览返回的 **`fingerprint`** 与 **`draftRevisionNo`**。以下情况返回 **409 冲突且不写入**：
   - `PACKAGE_FINGERPRINT_MISMATCH`：提交的原包与预览时不一致（内容被替换）；
   - `DRAFT_REVISION_CONFLICT`：预览后草稿被增删改过（修订号变化）；
   - `BATCH_ALREADY_IMPORTED`：该批次标识曾成功导入（数据库 UNIQUE 约束兜底）。
4. **一个事务追加整包**：确认成功后在单个事务内只做 INSERT 追加——不清空、不覆盖任何现有草稿；整包导入只推进**一次**草稿修订号。响应返回：
   - 包内键到草稿 id 的映射 `idMap`：`events:[{key, eventId, claims:[{index, claimId}]}]`、`relations:[{index, relationId, earlierKey, laterKey, earlierEventId, laterEventId}]`；
   - 新草稿修订号 `revisionNo`、导入数量 `counts`、批次标识与指纹。
5. **不影响已有内容**：历史版本快照与访客视图完全不触碰；导入的只是普通草稿，**仍须为每个事件选定主张、通过现有的缺主张 / 成环 / 时间无解校验后才能发布**（导入校验只保证结构与引用合法，不做时间求解，例如互相矛盾的时间主张允许导入，发布时仍会被拒）。

命令行调用示例（`X-Editor-Token` 为编辑者口令）：

```bash
# 1) 只读预览：把整理包包在 { "package": ... } 中提交，记下 fingerprint 与 draftRevisionNo
curl -s -X POST http://localhost:3000/api/editor/import-preview \
  -H 'Content-Type: application/json' -H 'X-Editor-Token: change-me-please' \
  -d "$(jq -c '{package: .}' interview-pack.json)" | jq .

# 2) 确认：原样回传 package，并带上预览返回的 fingerprint 与 draftRevisionNo
FP='粘贴预览返回的 fingerprint'
REV='粘贴预览返回的 draftRevisionNo'
jq -nc --arg fp "$FP" --argjson rev "$REV" \
  '{package: input, fingerprint: $fp, draftRevisionNo: $rev}' interview-pack.json \
| curl -s -X POST http://localhost:3000/api/editor/import \
    -H 'Content-Type: application/json' -H 'X-Editor-Token: change-me-please' -d @- | jq .
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
- 导入批次台账 `imported_batches` 同样只追加：登记每个成功导入的 `batch_id`（UNIQUE）、内容指纹、导入后修订号与数量，用于批次去重与溯源。

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
  importpack.js 采访整理包：整包校验（键/引用/日期/出处）+ 内容指纹 + 单事务追加（指纹/修订号/批次冲突检查）
  seed.js       演示数据
public/         访客页与编辑台（原生 HTML/CSS/JS）
test/           node:test 单元与端到端测试（含成环、无解、409 冲突、草稿恢复、整理包导入）
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
- `POST /api/editor/import-preview` — JSON 采访整理包只读预览；体为 `{package:{batchId,events,relations}}`
  - 200：`{ok,batchId,fingerprint,draftRevisionNo,alreadyImported,importedAt,counts,currentDraftCounts,events,relations}`（events/relations 为规范化后待写入内容）
  - 422：`{message, errors:[{type, location, eventKey?, claimIndex?, relationIndex?, message}]}`（键重复/引用缺失/自环/日期或出处非法等全部问题，整包拒绝）；结构非法 400
- `POST /api/editor/import` — 确认导入：单事务整包追加；体含 `package`（原包）、`fingerprint`、`draftRevisionNo`（后两者取预览返回值）
  - 201：`{ok,batchId,fingerprint,revisionNo,counts,idMap:{events:[{key,eventId,claims:[{index,claimId}]}],relations:[{index,relationId,earlierKey,laterKey,earlierEventId,laterEventId}]}}`
  - 409：`{code:"PACKAGE_FINGERPRINT_MISMATCH"|"DRAFT_REVISION_CONFLICT"|"BATCH_ALREADY_IMPORTED", ...}`（内容被替换、草稿已变化、批次标识曾成功导入，均不写入）；422：整包校验失败；参数非法 400
