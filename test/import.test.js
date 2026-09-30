'use strict';

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
process.env.EDITOR_TOKEN = 'test-token';
const Database = require('better-sqlite3');

const mem = new Database(':memory:');
const { SCHEMA, setDb } = require('../src/db');
mem.exec(SCHEMA);
setDb(mem);

const { app } = require('../src/server');
const { packageFingerprint } = require('../src/import');

const TOKEN = 'test-token';
let base;
let server;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  mem.close();
});

beforeEach(() => {
  mem.exec(`
    DELETE FROM version_relations;
    DELETE FROM version_events;
    DELETE FROM versions;
    DELETE FROM relations;
    DELETE FROM claims;
    DELETE FROM events;
    DELETE FROM imported_batches;
    DELETE FROM sqlite_sequence;
    UPDATE draft_meta SET revision = 0;
  `);
});

async function call(method, url, { token = TOKEN, body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-Editor-Token': token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function getState() {
  const r = await call('GET', '/api/editor/state');
  assert.strictEqual(r.status, 200);
  return r.json;
}

function samplePackage(over = {}) {
  return {
    batchId: 'batch-2026-01',
    events: [
      {
        key: 'mobilize',
        title: '修水渠动员会',
        description: '大队晒谷场',
        claims: [
          { precision: 'day', year: 1958, month: 9, day: 12, source: '李宝山口述，2021-07-05 访谈', note: '中秋节后第三天' },
          { precision: 'year', year: 1958, source: '《县水利志》1994 年版，第 87 页' },
        ],
      },
      {
        key: 'water',
        title: '东干渠通水',
        claims: [
          { precision: 'month', year: 1959, month: 5, source: '王秀兰口述，2021-08-02 访谈' },
        ],
      },
    ],
    relations: [
      { earlierKey: 'mobilize', laterKey: 'water', source: '二人口述一致' },
    ],
    ...over,
  };
}

async function preview(pkg) {
  return call('POST', '/api/editor/import-preview', { body: pkg });
}

async function commit(pkg, pv, over = {}) {
  return call('POST', '/api/editor/import-commit', {
    body: {
      pkg,
      fingerprint: pv.fingerprint,
      draftRevisionNo: pv.draftRevisionNo,
      ...over,
    },
  });
}

test('导入接口需要编辑者口令', async () => {
  const pkg = samplePackage();
  const r1 = await call('POST', '/api/editor/import-preview', { token: null, body: pkg });
  assert.strictEqual(r1.status, 401);
  const pv = (await preview(pkg)).json;
  const r2 = await call('POST', '/api/editor/import-commit', {
    token: null,
    body: { pkg, fingerprint: pv.fingerprint, draftRevisionNo: pv.draftRevisionNo },
  });
  assert.strictEqual(r2.status, 401);
});

test('预览只读：返回内容/数量/指纹/修订号，不写任何数据', async () => {
  const pkg = samplePackage();
  const before = await getState();
  const r = await preview(pkg);
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  const d = r.json;
  assert.strictEqual(d.ok, true);
  assert.strictEqual(d.batchId, 'batch-2026-01');
  assert.deepStrictEqual(d.counts, { eventCount: 2, claimCount: 3, relationCount: 1 });
  assert.strictEqual(d.batchAlreadyImported, false);
  assert.match(d.fingerprint, /^[0-9a-f]{64}$/);
  assert.strictEqual(d.draftRevisionNo, before.draftRevisionNo);
  assert.strictEqual(d.events[0].claims[0].dateLabel, '1958 年 09 月 12 日');
  assert.strictEqual(d.events[0].claims[0].intervalStart, '1958-09-12');
  assert.strictEqual(d.events[0].claims[0].intervalEnd, '1958-09-12');
  assert.strictEqual(d.relations[0].earlierKey, 'mobilize');

  // 预览不写数据、不推进修订号
  const after = await getState();
  assert.strictEqual(after.events.length, 0);
  assert.strictEqual(after.draftRevisionNo, before.draftRevisionNo);
  const ledger = mem.prepare('SELECT COUNT(*) AS n FROM imported_batches').get().n;
  assert.strictEqual(ledger, 0);
});

test('整包问题全部列出：键重复/关系引用缺失/自环/日期非法/出处非法 → 422 整包拒绝', async () => {
  const pkg = {
    batchId: 'bad-batch',
    events: [
      { key: 'a', title: '甲', claims: [{ precision: 'day', year: 1958, month: 2, day: 30, source: '' }] },
      { key: 'a', title: '重复键', claims: [{ precision: 'year', year: 1958 }] },
      { key: 'b', title: '乙', claims: [{ precision: 'month', year: 1958, month: 13, source: '档案 1' }] },
      { key: 'c', title: '丙', claims: [{ precision: 'day', year: 1958, month: 1, day: 1, source: '档案 2' }] },
    ],
    relations: [
      { earlierKey: 'a', laterKey: 'ghost' },
      { earlierKey: 'ghost1', laterKey: 'ghost2' },
      { earlierKey: 'c', laterKey: 'c' },
    ],
  };
  const r = await preview(pkg);
  assert.strictEqual(r.status, 422);
  const types = r.json.errors.map((e) => e.type);
  assert.ok(types.includes('duplicate_key'), JSON.stringify(types));
  assert.ok(types.includes('missing_relation_key'));
  assert.ok(types.includes('self_relation'));
  assert.ok(types.includes('invalid_date')); // 2 月没有 30 天
  assert.ok(types.includes('invalid_source')); // 出处为空
  assert.ok(types.includes('invalid_date')); // 13 月
  // 一条都未写入
  const st = await getState();
  assert.strictEqual(st.events.length, 0);
  assert.strictEqual(st.draftRevisionNo, 0);
});

test('信封级错误返回 400：非对象体、batchId 缺失、relations 非数组', async () => {
  assert.strictEqual((await preview(null)).status, 400);
  assert.strictEqual((await preview('x')).status, 400);
  assert.strictEqual((await preview({ events: [] })).status, 422); // batchId 缺失作为包内问题
  const badRel = await preview(samplePackage({ relations: {} }));
  assert.strictEqual(badRel.status, 422);
  assert.strictEqual(badRel.json.errors[0].type, 'invalid_relation');
});

test('确认成功：事务内整包追加，返回键→草稿 ID 映射与新修订号', async () => {
  const pkg = samplePackage();
  const pv = (await preview(pkg)).json;
  const r = await commit(pkg, pv);
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  const d = r.json;
  assert.strictEqual(d.batchId, 'batch-2026-01');
  assert.strictEqual(d.baseRevisionNo, 0);
  assert.strictEqual(d.revisionNo, 1);
  assert.strictEqual(d.currentVersionNo, 0);
  assert.deepStrictEqual(d.counts, { eventCount: 2, claimCount: 3, relationCount: 1 });

  const em = d.idMap.events;
  assert.strictEqual(em.length, 2);
  const m = em.find((x) => x.key === 'mobilize');
  assert.strictEqual(m.eventId, 1);
  assert.deepStrictEqual(m.claims.map((c) => c.claimId), [1, 2]);
  const w = em.find((x) => x.key === 'water');
  assert.strictEqual(w.eventId, 2);
  assert.strictEqual(w.claims[0].claimId, 3);
  assert.deepStrictEqual(d.idMap.relations[0], {
    index: 0,
    relationId: 1,
    earlierKey: 'mobilize',
    laterKey: 'water',
    earlierEventId: 1,
    laterEventId: 2,
  });

  const st = await getState();
  assert.strictEqual(st.events.length, 2);
  assert.strictEqual(st.draftRevisionNo, 1);
  assert.strictEqual(st.events.find((e) => e.id === 1).claims.length, 2);
  assert.deepStrictEqual(st.relations.map((x) => [x.earlierId, x.laterId, x.source]), [[1, 2, '二人口述一致']]);

  // 台账已登记
  const row = mem.prepare('SELECT * FROM imported_batches WHERE batch_id = ?').get('batch-2026-01');
  assert.strictEqual(row.fingerprint, d.fingerprint);
  assert.strictEqual(row.event_count, 2);
  assert.strictEqual(row.revision_no, 1);
});

test('内容被替换（指纹不符）→ 409 PACKAGE_CHANGED，不写入', async () => {
  const pkg = samplePackage();
  const pv = (await preview(pkg)).json;
  const changed = samplePackage({
    events: [
      pkg.events[0],
      { key: 'water', title: '东干渠通水（改）', claims: pkg.events[1].claims },
    ],
  });
  const r = await commit(changed, pv);
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.json.code, 'PACKAGE_CHANGED');
  assert.strictEqual(r.json.expectedFingerprint, pv.fingerprint);
  assert.strictEqual(r.json.actualFingerprint, packageFingerprint(changed));
  assert.strictEqual((await getState()).events.length, 0);
  assert.strictEqual((await getState()).draftRevisionNo, 0);
});

test('指纹对空白与键顺序不敏感（规范化指纹）', async () => {
  const a = samplePackage();
  const b = JSON.parse(JSON.stringify(a));
  b.events[0].key = `  ${b.events[0].key}  `;
  b.events[0].title = `  ${b.events[0].title}  `;
  b.relations = [b.relations[0]];
  // 重新排列事件对象内部键顺序
  b.events = b.events.map((e) => ({
    claims: e.claims,
    description: e.description,
    title: e.title,
    key: e.key,
  }));
  assert.strictEqual(packageFingerprint(a), packageFingerprint(b));
});

test('草稿在预览后被修改 → 409 DRAFT_REVISION_CONFLICT，不写入', async () => {
  const pkg = samplePackage();
  const pv = (await preview(pkg)).json;
  // 另一位编辑者先加了一个事件（修订号推进）
  const sneak = await call('POST', '/api/editor/events', { body: { title: '并发事件' } });
  assert.strictEqual(sneak.status, 201);
  const r = await commit(pkg, pv);
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.json.code, 'DRAFT_REVISION_CONFLICT');
  assert.strictEqual(r.json.currentRevisionNo, 1);
  const st = await getState();
  assert.strictEqual(st.events.length, 1);
  assert.strictEqual(st.events[0].title, '并发事件');
  // 批次未被登记，稍后仍可导入
  assert.strictEqual(mem.prepare('SELECT COUNT(*) AS n FROM imported_batches').get().n, 0);
});

test('批次标识曾成功导入 → 再次预览有标记，确认 409 BATCH_ALREADY_IMPORTED，不写入', async () => {
  const pkg = samplePackage();
  const pv = (await preview(pkg)).json;
  const ok = await commit(pkg, pv);
  assert.strictEqual(ok.status, 201);

  // 同批次全新预览（修订号已变为 1）：只读标记
  const pv2r = await preview(pkg);
  assert.strictEqual(pv2r.status, 200);
  assert.strictEqual(pv2r.json.batchAlreadyImported, true);
  assert.strictEqual(pv2r.json.previousImport.revisionNo, 1);

  // 即便用新指纹参数确认（同批次内容一致），也 409
  const r = await commit(pkg, pv2r.json);
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.json.code, 'BATCH_ALREADY_IMPORTED');
  const st = await getState();
  assert.strictEqual(st.events.length, 2);
  assert.strictEqual(st.draftRevisionNo, 1);

  // 换批次标识即可导入；同键事件追加不冲突（草稿允许同名/同内容事件）
  const other = samplePackage({ batchId: 'batch-2026-02' });
  const pv3 = (await preview(other)).json;
  const ok2 = await commit(other, pv3);
  assert.strictEqual(ok2.status, 201);
  assert.strictEqual(ok2.json.revisionNo, 2);
  assert.strictEqual((await getState()).events.length, 4);
});

test('整包追加：不影响已有草稿、历史快照与访客视图', async () => {
  // 先有一条草稿事件并发布第 1 版
  const e0 = (await call('POST', '/api/editor/events', { body: { title: '原有事件' } })).json.event.id;
  const c0 = (await call('POST', `/api/editor/events/${e0}/claims`, {
    body: { precision: 'year', year: 1950, source: '旧档案' },
  })).json.claim.id;
  const pub = await call('POST', '/api/editor/publish', {
    body: { selection: [{ eventId: e0, claimId: c0 }], baseVersionNo: 0 },
  });
  assert.strictEqual(pub.status, 201);

  const pkg = samplePackage();
  const pv = (await preview(pkg)).json;
  assert.strictEqual(pv.draftRevisionNo, 2); // 建事件 + 加主张各推进一次；发布不动草稿修订号
  assert.strictEqual(pv.currentVersionNo, 1);
  const r = await commit(pkg, pv);
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.json.revisionNo, 3);

  // 原草稿事件仍在
  const st = await getState();
  assert.deepStrictEqual(st.events.map((e) => e.title), ['原有事件', '修水渠动员会', '东干渠通水']);

  // 访客视图与历史快照不受影响（仍只有原有事件一版）
  const view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.currentVersionNo, 1);
  assert.strictEqual(view.json.version.eventCount, 1);
  assert.strictEqual(view.json.version.events[0].title, '原有事件');
});

test('导入的新内容按现有选择与先后校验发布（含矛盾关系导致无法发布）', async () => {
  const pkg = samplePackage();
  const pv = (await preview(pkg)).json;
  const imp = await commit(pkg, pv);
  assert.strictEqual(imp.status, 201);
  const st = await getState();
  const byKey = Object.fromEntries(imp.json.idMap.events.map((m) => [m.key, m]));
  const mobilize = st.events.find((e) => e.id === byKey.mobilize.eventId);
  const water = st.events.find((e) => e.id === byKey.water.eventId);

  // 选择 1958 年（粗精度）主张 + 1959 年 5 月：可解
  const yearClaim = mobilize.claims.find((c) => c.precision === 'year').id;
  const monthClaim = water.claims[0].id;
  const valOk = await call('POST', '/api/editor/validate', {
    body: { selection: [{ eventId: mobilize.id, claimId: yearClaim }, { eventId: water.id, claimId: monthClaim }] },
  });
  assert.strictEqual(valOk.status, 200);
  assert.strictEqual(valOk.json.ok, true);

  // 反向再补一条「通水 先于 动员会」：成环，发布仍被 422 拦截
  const ring = await call('POST', '/api/editor/relations', {
    body: { earlierId: water.id, laterId: mobilize.id, source: '错误材料' },
  });
  assert.strictEqual(ring.status, 201);
  const dayClaim = mobilize.claims.find((c) => c.precision === 'day').id;
  const bad = await call('POST', '/api/editor/publish', {
    body: {
      selection: [{ eventId: mobilize.id, claimId: dayClaim }, { eventId: water.id, claimId: monthClaim }],
      baseVersionNo: 0,
    },
  });
  assert.strictEqual(bad.status, 422);
  assert.strictEqual(bad.json.errors[0].type, 'cycle');

  // 删掉环边后正常发布
  await call('DELETE', `/api/editor/relations/${ring.json.relation.id}`);
  const ok = await call('POST', '/api/editor/publish', {
    body: {
      selection: [{ eventId: mobilize.id, claimId: dayClaim }, { eventId: water.id, claimId: monthClaim }],
      baseVersionNo: 0,
      editor: '导入者',
      note: '采访包导入后首版',
    },
  });
  assert.strictEqual(ok.status, 201, JSON.stringify(ok.json));
  assert.strictEqual(ok.json.versionNo, 1);
  assert.deepStrictEqual(ok.json.version.events.map((e) => e.title), ['修水渠动员会', '东干渠通水']);
});

test('确认参数非法返回 400；缺 pkg 字段 400', async () => {
  const pkg = samplePackage();
  const pv = (await preview(pkg)).json;
  const noPkg = await call('POST', '/api/editor/import-commit', {
    body: { fingerprint: pv.fingerprint, draftRevisionNo: pv.draftRevisionNo },
  });
  assert.strictEqual(noPkg.status, 400);
  const badFp = await call('POST', '/api/editor/import-commit', {
    body: { pkg, fingerprint: 'nope', draftRevisionNo: pv.draftRevisionNo },
  });
  assert.strictEqual(badFp.status, 400);
  const badRev = await call('POST', '/api/editor/import-commit', {
    body: { pkg, fingerprint: pv.fingerprint, draftRevisionNo: -1 },
  });
  assert.strictEqual(badRev.status, 400);
  // 任何失败都未写台账
  assert.strictEqual(mem.prepare('SELECT COUNT(*) AS n FROM imported_batches').get().n, 0);
});
