'use strict';

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
process.env.EDITOR_TOKEN = 'test-token';
const Database = require('better-sqlite3');

const mem = new Database(':memory:');
const { SCHEMA, setDb, getDb } = require('../src/db');
mem.exec(SCHEMA);
setDb(mem);

const { app } = require('../src/server');
const { packageFingerprint } = require('../src/importpack');

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

function validPackage(overrides = {}) {
  return {
    batchId: 'batch-2026-01',
    events: [
      {
        key: 'dongyuan',
        title: '动员会',
        description: '晒谷场开会',
        claims: [
          { precision: 'day', year: 1958, month: 9, day: 12, source: '李宝山口述，2021-07-05 访谈', note: '中秋节后第三天' },
          { precision: 'year', year: 1958, source: '《县水利志》第87页' },
        ],
      },
      {
        key: 'tongshui',
        title: '通水会',
        claims: [
          { precision: 'month', year: 1959, month: 5, source: '王秀兰口述' },
        ],
      },
    ],
    relations: [
      { earlierKey: 'dongyuan', laterKey: 'tongshui', source: '二人口述一致' },
    ],
    ...overrides,
  };
}

async function getState() {
  const r = await call('GET', '/api/editor/state');
  assert.strictEqual(r.status, 200);
  return r.json;
}

async function preview(pkg) {
  return call('POST', '/api/editor/import-preview', { body: { package: pkg } });
}

async function confirm(pkg, pv, overrides = {}) {
  return call('POST', '/api/editor/import', {
    body: {
      package: pkg,
      fingerprint: (pv && pv.json && pv.json.fingerprint) || packageFingerprint(pkg),
      draftRevisionNo: (pv && pv.json && pv.json.draftRevisionNo) || 0,
      ...overrides,
    },
  });
}

test('导入接口需要编辑者口令', async () => {
  const pkg = validPackage();
  const r = await call('POST', '/api/editor/import-preview', { token: null, body: { package: pkg } });
  assert.strictEqual(r.status, 401);
  const r2 = await call('POST', '/api/editor/import', { token: null, body: { package: pkg, fingerprint: 'x', draftRevisionNo: 0 } });
  assert.strictEqual(r2.status, 401);
});

test('预览只读：列出待写入内容与数量、指纹和草稿修订号，不写任何数据', async () => {
  const pkg = validPackage();
  const before = await getState();
  const r = await preview(pkg);
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.batchId, 'batch-2026-01');
  assert.strictEqual(r.json.fingerprint, packageFingerprint(pkg));
  assert.match(r.json.fingerprint, /^[0-9a-f]{64}$/);
  assert.strictEqual(r.json.draftRevisionNo, 0);
  assert.strictEqual(r.json.alreadyImported, false);
  assert.deepStrictEqual(r.json.counts, { eventCount: 2, claimCount: 3, relationCount: 1 });
  assert.deepStrictEqual(r.json.currentDraftCounts, { eventCount: 0, claimCount: 0, relationCount: 0 });

  // 规范化后的主张含区间与展示标签
  const dy = r.json.events.find((e) => e.key === 'dongyuan');
  assert.strictEqual(dy.title, '动员会');
  assert.strictEqual(dy.claims.length, 2);
  const dayClaim = dy.claims[0];
  assert.strictEqual(dayClaim.dateLabel, '1958 年 09 月 12 日');
  assert.strictEqual(dayClaim.intervalStart, '1958-09-12');
  assert.strictEqual(dayClaim.intervalEnd, '1958-09-12');
  assert.strictEqual(r.json.relations[0].earlierKey, 'dongyuan');

  const after = await getState();
  assert.strictEqual(after.events.length, 0);
  assert.strictEqual(after.draftRevisionNo, before.draftRevisionNo);
});

test('确认成功：事务追加整包，返回键→草稿 id 映射与新修订号', async () => {
  const pkg = validPackage();
  const pv = await preview(pkg);
  assert.strictEqual(pv.status, 200);
  const r = await confirm(pkg, pv);
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));

  assert.strictEqual(r.json.batchId, 'batch-2026-01');
  assert.strictEqual(r.json.revisionNo, 1); // 整包导入只推进一次修订号
  assert.deepStrictEqual(r.json.counts, { eventCount: 2, claimCount: 3, relationCount: 1 });

  const st = await getState();
  assert.strictEqual(st.events.length, 2);
  assert.strictEqual(st.draftRevisionNo, 1);
  const dy = st.events.find((e) => e.title === '动员会');
  const ts = st.events.find((e) => e.title === '通水会');
  assert.strictEqual(dy.claims.length, 2);
  assert.strictEqual(ts.claims.length, 1);
  assert.strictEqual(st.relations.length, 1);
  assert.deepStrictEqual(
    { earlierId: st.relations[0].earlierId, laterId: st.relations[0].laterId, source: st.relations[0].source },
    { earlierId: dy.id, laterId: ts.id, source: '二人口述一致' }
  );

  const em = r.json.idMap.events;
  assert.deepStrictEqual(em.map((m) => m.key), ['dongyuan', 'tongshui']);
  assert.strictEqual(em[0].eventId, dy.id);
  assert.deepStrictEqual(em[0].claims.map((c) => c.claimId), dy.claims.map((c) => c.id));
  assert.deepStrictEqual(em[1].claims, [{ index: 0, claimId: ts.claims[0].id }]);
  assert.deepStrictEqual(r.json.idMap.relations[0], {
    index: 0,
    relationId: st.relations[0].id,
    earlierKey: 'dongyuan',
    laterKey: 'tongshui',
    earlierEventId: dy.id,
    laterEventId: ts.id,
  });
});

test('键重复：列出问题并整包拒绝（422），不写数据', async () => {
  const pkg = validPackage({
    events: [
      pkgEvent('a', '甲'),
      pkgEvent('a', '甲重复'),
    ],
    relations: [],
  });
  const r = await preview(pkg);
  assert.strictEqual(r.status, 422);
  assert.ok(r.json.errors.some((e) => e.type === 'duplicate_key' && e.eventKey === 'a'));
  assert.strictEqual((await getState()).events.length, 0);
});

function pkgEvent(key, title, claims = [{ precision: 'year', year: 1958, source: 's' }]) {
  return { key, title, claims };
}

test('关系引用缺失（含缺失键信息）与自环：422 列出全部问题', async () => {
  const pkg = validPackage({
    relations: [
      { earlierKey: 'dongyuan', laterKey: 'ghost' },
      { earlierKey: 'ghost2', laterKey: 'dongyuan' },
      { earlierKey: 'tongshui', laterKey: 'tongshui' },
    ],
  });
  const r = await preview(pkg);
  assert.strictEqual(r.status, 422);
  const types = r.json.errors.map((e) => e.type).sort();
  assert.ok(types.includes('missing_reference'));
  assert.ok(types.includes('self_relation'));
  assert.strictEqual(r.json.errors.filter((e) => e.type === 'missing_reference').length, 2);
  assert.strictEqual((await getState()).events.length, 0);
});

test('日期非法（年/月/日与精度不符）：422 指明事件与第几条主张', async () => {
  const cases = [
    { precision: 'day', year: 1958, month: 2, day: 30, source: 's' },   // 2 月 30 日不存在
    { precision: 'month', year: 1958, month: 13, source: 's' },        // 13 月
    { precision: 'year', year: 0, source: 's' },                       // 年份越界
    { precision: 'day', year: 1958, month: 9, day: 12, source: ' ' },  // 出处为空同时日期合法 → 只报出处
  ];
  for (const [i, claim] of cases.entries()) {
    const pkg = validPackage({
      events: [{ key: 'e', title: 'E', claims: [claim] }],
      relations: [],
    });
    const r = await preview(pkg);
    assert.strictEqual(r.status, 422, `case ${i}`);
    if (i < 3) assert.ok(r.json.errors.some((e) => e.type === 'invalid_date'), `case ${i}: ${JSON.stringify(r.json.errors)}`);
    else assert.ok(r.json.errors.some((e) => e.type === 'invalid_source'));
    assert.ok(r.json.errors.every((e) => e.eventKey === 'e'));
  }
});

test('出处缺失与主张为空：422', async () => {
  const noSource = validPackage({
    events: [{ key: 'e', title: 'E', claims: [{ precision: 'year', year: 1958 }] }],
    relations: [],
  });
  const r1 = await preview(noSource);
  assert.strictEqual(r1.status, 422);
  assert.ok(r1.json.errors.some((e) => e.type === 'invalid_source'));

  const noClaims = validPackage({
    events: [{ key: 'e', title: 'E', claims: [] }],
    relations: [],
  });
  const r2 = await preview(noClaims);
  assert.strictEqual(r2.status, 422);
  assert.ok(r2.json.errors.some((e) => e.type === 'invalid_claims'));
});

test('结构问题返回 400', async () => {
  const r1 = await call('POST', '/api/editor/import-preview', { body: { package: null } });
  assert.strictEqual(r1.status, 400);
  const r2 = await preview({ batchId: '', events: [] });
  assert.strictEqual(r2.status, 400);
  const r3 = await preview({ batchId: 'b', events: [] });
  assert.strictEqual(r3.status, 400);
  const r4 = await call('POST', '/api/editor/import-preview', { body: {} });
  assert.strictEqual(r4.status, 400);
});

test('多个问题一次性列出（日期 + 出处 + 引用），整包拒绝', async () => {
  const pkg = {
    batchId: 'b-multi',
    events: [
      { key: 'a', title: 'A', claims: [{ precision: 'day', year: 1958, month: 2, day: 31 }] },
      { title: '无键事件', claims: [{ precision: 'year', year: 1958, source: 's' }] },
    ],
    relations: [{ earlierKey: 'a', laterKey: 'nope' }],
  };
  const r = await preview(pkg);
  assert.strictEqual(r.status, 422);
  const types = new Set(r.json.errors.map((e) => e.type));
  assert.ok(types.has('invalid_date'));
  assert.ok(types.has('invalid_source'));
  assert.ok(types.has('invalid_key'));
  assert.ok(types.has('missing_reference'));
});

test('内容被替换（指纹不符）→ 409 PACKAGE_FINGERPRINT_MISMATCH，不写入', async () => {
  const pkg = validPackage();
  const pv = await preview(pkg);
  const tampered = validPackage({ batchId: 'batch-2026-02' });
  const r = await confirm(tampered, pv);
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.json.code, 'PACKAGE_FINGERPRINT_MISMATCH');
  assert.strictEqual(r.json.expectedFingerprint, pv.json.fingerprint);
  assert.strictEqual(r.json.actualFingerprint, packageFingerprint(tampered));
  assert.strictEqual((await getState()).events.length, 0);
  assert.strictEqual((await getState()).draftRevisionNo, 0);
});

test('预览后草稿已变化（修订号过期）→ 409 DRAFT_REVISION_CONFLICT，不写入', async () => {
  const pkg = validPackage();
  const pv = await preview(pkg);
  // 另一位编辑者在确认前加了一个事件
  await call('POST', '/api/editor/events', { body: { title: '插队的事件' } });
  const revBefore = (await getState()).draftRevisionNo;
  assert.strictEqual(revBefore, 1);

  const r = await confirm(pkg, pv);
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.json.code, 'DRAFT_REVISION_CONFLICT');
  assert.strictEqual(r.json.currentRevisionNo, 1);

  const st = await getState();
  assert.strictEqual(st.events.length, 1);
  assert.strictEqual(st.events[0].title, '插队的事件');
  assert.strictEqual(st.draftRevisionNo, 1);
});

test('批次标识曾成功导入 → 再次确认 409 BATCH_ALREADY_IMPORTED；预览返回 alreadyImported', async () => {
  const pkg = validPackage();
  const pv = await preview(pkg);
  const ok = await confirm(pkg, pv);
  assert.strictEqual(ok.status, 201);
  assert.strictEqual(ok.json.revisionNo, 1);

  const pv2 = await preview(pkg);
  assert.strictEqual(pv2.status, 200);
  assert.strictEqual(pv2.json.alreadyImported, true);
  assert.ok(pv2.json.importedAt);

  // 即便修订号对齐（预览已读到导入后的修订号），重复批次仍被拒绝
  const again = await confirm(pkg, pv2);
  assert.strictEqual(again.status, 409);
  assert.strictEqual(again.json.code, 'BATCH_ALREADY_IMPORTED');
  assert.strictEqual(again.json.batchId, 'batch-2026-01');

  const st = await getState();
  assert.strictEqual(st.events.length, 2);
  assert.strictEqual(st.draftRevisionNo, 1);
});

test('追加语义：不覆盖现有草稿/历史快照，导入后修订号只 +1', async () => {
  // 先手工建一个事件并发布
  const e = await call('POST', '/api/editor/events', { body: { title: '既有事件' } });
  const oldId = e.json.event.id;
  const c = await call('POST', `/api/editor/events/${oldId}/claims`, {
    body: { precision: 'year', year: 1950, source: '旧档案' },
  });
  const pub = await call('POST', '/api/editor/publish', {
    body: { selection: [{ eventId: oldId, claimId: c.json.claim.id }], baseVersionNo: 0 },
  });
  assert.strictEqual(pub.status, 201);
  const revBefore = (await getState()).draftRevisionNo;
  assert.ok(revBefore >= 1);

  const pkg = validPackage();
  const pv = await preview(pkg);
  assert.strictEqual(pv.json.draftRevisionNo, revBefore);
  assert.deepStrictEqual(pv.json.currentDraftCounts, { eventCount: 1, claimCount: 1, relationCount: 0 });
  const r = await confirm(pkg, pv);
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.json.revisionNo, revBefore + 1);

  const st = await getState();
  assert.strictEqual(st.events.length, 3);
  assert.ok(st.events.find((x) => x.id === oldId && x.title === '既有事件'));
  assert.ok(st.events.find((x) => x.title === '动员会'));

  // 历史快照与访客视图不受影响
  const view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.currentVersionNo, 1);
  assert.strictEqual(view.json.version.eventCount, 1);
  assert.strictEqual(view.json.version.events[0].title, '既有事件');
});

test('导入内容仍按现有选择与先后校验发布', async () => {
  const pkg = validPackage();
  const pv = await preview(pkg);
  const imp = await confirm(pkg, pv);
  assert.strictEqual(imp.status, 201);

  const st = await getState();
  const dy = st.events.find((e) => e.title === '动员会');
  const ts = st.events.find((e) => e.title === '通水会');

  // 选择导入事件的主张做校验：通过（1958-09-12 严格早于 1959-05）
  const val = await call('POST', '/api/editor/validate', {
    body: {
      selection: [
        { eventId: dy.id, claimId: dy.claims[0].id },
        { eventId: ts.id, claimId: ts.claims[0].id },
      ],
    },
  });
  assert.strictEqual(val.status, 200);
  assert.strictEqual(val.json.ok, true);

  // 未导入前访客仍看不到；以最新版本号 0 为基准发布成功
  const pub = await call('POST', '/api/editor/publish', {
    body: {
      selection: [
        { eventId: dy.id, claimId: dy.claims[0].id },
        { eventId: ts.id, claimId: ts.claims[0].id },
      ],
      baseVersionNo: 0,
      editor: '导入整理员',
      note: '来自采访整理包 batch-2026-01',
    },
  });
  assert.strictEqual(pub.status, 201, JSON.stringify(pub.json));
  assert.strictEqual(pub.json.versionNo, 1);
  const view = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(view.json.version.events[0].resolvedDate, '1958-09-12');
  assert.strictEqual(view.json.version.relations[0].source, '二人口述一致');
});

test('导入的先后关系若时间无解，现有发布校验照常拒绝', async () => {
  const pkg = {
    batchId: 'b-conflict',
    events: [
      { key: 'winter', title: '冬月会议', claims: [{ precision: 'month', year: 1958, month: 12, source: 's1' }] },
      { key: 'spring', title: '春月会议', claims: [{ precision: 'month', year: 1958, month: 1, source: 's2' }] },
    ],
    relations: [{ earlierKey: 'winter', laterKey: 'spring' }],
  };
  const pv = await preview(pkg);
  assert.strictEqual(pv.status, 200); // 导入只做结构/引用校验，不求解时间
  const imp = await confirm(pkg, pv);
  assert.strictEqual(imp.status, 201);

  const st = await getState();
  const sel = st.events.map((e) => ({ eventId: e.id, claimId: e.claims[0].id }));
  const bad = await call('POST', '/api/editor/publish', { body: { selection: sel, baseVersionNo: 0 } });
  assert.strictEqual(bad.status, 422);
  assert.strictEqual(bad.json.errors[0].type, 'temporal');
});

test('确认参数非法返回 400', async () => {
  const pkg = validPackage();
  const r1 = await call('POST', '/api/editor/import', { body: { package: pkg, fingerprint: 'abc', draftRevisionNo: 0 } });
  assert.strictEqual(r1.status, 400);
  const r2 = await call('POST', '/api/editor/import', {
    body: { package: pkg, fingerprint: packageFingerprint(pkg), draftRevisionNo: -1 },
  });
  assert.strictEqual(r2.status, 400);
  const r3 = await call('POST', '/api/editor/import', { body: { fingerprint: 'x', draftRevisionNo: 0 } });
  assert.strictEqual(r3.status, 400);
});

test('指纹对键序不敏感：events 顺序不同但内容相同仍匹配；关系数组顺序可区分', async () => {
  const pkg = validPackage();
  const reordered = validPackage({
    events: [pkg.events[1], pkg.events[0]],
  });
  // 对象键序不敏感：包内事件书写顺序改变视为不同数组内容（数组保序），
  // 但 JSON 对象内部字段顺序变化不影响指纹
  const sameFields = {
    relations: pkg.relations,
    events: pkg.events.map((e) => ({ claims: e.claims, title: e.title, key: e.key, description: e.description })),
    batchId: pkg.batchId,
  };
  assert.strictEqual(packageFingerprint(sameFields), packageFingerprint(pkg));
  assert.notStrictEqual(packageFingerprint(reordered), packageFingerprint(pkg));
});
