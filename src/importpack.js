'use strict';

// JSON 采访整理包导入：只读预览 + 单事务整包追加。
//
// 包结构：
//   {
//     batchId: '批次标识（同一标识成功导入后不可再次导入）',
//     events: [
//       {
//         key: '包内唯一键',
//         title: '事件标题',
//         description: '可选描述',
//         claims: [
//           { precision: 'year|month|day', year, month?, day?, source: '出处（必填）', note? }
//         ]
//       }
//     ],
//     relations: [ { earlierKey, laterKey, source?, note? } ]
//   }
//
// 预览（buildImportPreview）只读：完整校验整包，返回规范化后的待写入内容、
// 数量、草稿修订号与内容指纹；任一键重复 / 关系引用缺失 / 日期或出处非法，
// 都列出全部问题并拒绝（422），绝不写库。
//
// 确认（confirmImport）须提交：原包、预览返回的内容指纹、预览返回的草稿修订号。
// 在一个事务内：
//   1. 重算原包指纹，与预览指纹不一致 → 409 PACKAGE_FINGERPRINT_MISMATCH；
//   2. 重新完整校验整包（不信任预览步骤）；
//   3. 草稿修订号已变化 → 409 DRAFT_REVISION_CONFLICT；
//   4. 批次标识曾成功导入 → 409 BATCH_ALREADY_IMPORTED；
//   5. 仅做 INSERT 追加，不清空、不覆盖任何现有草稿；写批次台账；
//   6. 整包导入只算一次草稿变更，修订号校正为预览值 + 1。
// 历史快照与访客视图完全不触碰；导入内容仍是普通草稿，发布照旧走选择与先后校验。

const crypto = require('crypto');
const { getDb } = require('./db');
const { parseClaimDate, claimInterval, formatClaimDate } = require('./dates');
const { draftRevisionNo } = require('./restore');

const LIMITS = {
  batchId: 100,
  key: 100,
  title: 200,
  description: 5000,
  source: 1000,
  note: 2000,
};

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

function within(v, max) {
  return typeof v === 'string' && v.length <= max;
}

function location(eventKey, extra = {}) {
  return eventKey === undefined ? extra : { eventKey, ...extra };
}

// 稳定序列化：对象键递归排序，数组保序；遵循 JSON 语义
// （对象中值为 undefined 的键跳过，数组中的 undefined 记为 null）。
// 指纹只取决于内容，与键的书写顺序无关。
function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? 'null' : stableStringify(v))).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const parts = [];
    for (const k of Object.keys(value).sort()) {
      if (value[k] === undefined) continue;
      parts.push(`${JSON.stringify(k)}:${stableStringify(value[k])}`);
    }
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value);
}

function packageFingerprint(pkg) {
  return crypto.createHash('sha256').update(stableStringify(pkg), 'utf8').digest('hex');
}

// 校验并规范化整包。返回 { normalized, errors }（errors 非空时 normalized 不可用）。
function validatePackage(pkg) {
  const errors = [];

  if (pkg === null || typeof pkg !== 'object' || Array.isArray(pkg)) {
    throw { status: 400, message: '请求体必须是一个 JSON 采访整理包对象 {batchId, events, relations}' };
  }

  if (!isNonEmptyString(pkg.batchId) || !within(pkg.batchId, LIMITS.batchId)) {
    throw { status: 400, message: `batchId 必须是非空字符串且长度不超过 ${LIMITS.batchId}` };
  }

  if (!Array.isArray(pkg.events)) {
    throw { status: 400, message: 'events 必须是事件数组' };
  }
  if (pkg.events.length === 0) {
    throw { status: 400, message: 'events 不能为空：采访整理包至少包含一个事件' };
  }
  if (pkg.relations !== undefined && !Array.isArray(pkg.relations)) {
    throw { status: 400, message: 'relations 必须是数组（缺省视为无关系）' };
  }

  const seenKeys = new Set();
  const events = [];

  pkg.events.forEach((ev, i) => {
    const at = `events[${i}]`;
    if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) {
      errors.push({ type: 'malformed_event', location: at, message: `${at} 必须是事件对象` });
      return;
    }

    let key = ev.key;
    if (!isNonEmptyString(key) || !within(key, LIMITS.key)) {
      errors.push({ type: 'invalid_key', location: at, message: `${at}.key 必须是非空字符串且长度不超过 ${LIMITS.key}` });
      key = null;
    } else if (seenKeys.has(key)) {
      errors.push({ type: 'duplicate_key', location: at, ...location(key), message: `事件键「${key}」在包内重复，每个事件键必须唯一` });
    }
    if (key) seenKeys.add(key);

    let title = null;
    if (!isNonEmptyString(ev.title) || !within(ev.title, LIMITS.title)) {
      errors.push({ type: 'invalid_title', location: at, ...location(key), message: `事件${key ? `「${key}」` : `（${at}）`}的 title 必须是非空字符串且长度不超过 ${LIMITS.title}` });
    } else {
      title = ev.title.trim();
    }

    let description = '';
    if (ev.description !== undefined && ev.description !== null) {
      if (typeof ev.description !== 'string' || !within(ev.description, LIMITS.description)) {
        errors.push({ type: 'invalid_field', location: `${at}.description`, ...location(key), message: `事件「${key || at}」的 description 必须是字符串且长度不超过 ${LIMITS.description}` });
      } else {
        description = ev.description;
      }
    }

    const claims = [];
    if (!Array.isArray(ev.claims) || ev.claims.length === 0) {
      errors.push({ type: 'invalid_claims', location: `${at}.claims`, ...location(key), message: `事件「${key || at}」必须包含至少一条时间主张（claims 非空数组）` });
    } else {
      ev.claims.forEach((c, j) => {
        const cat = `${at}.claims[${j}]`;
        if (c === null || typeof c !== 'object' || Array.isArray(c)) {
          errors.push({ type: 'invalid_claim', location: cat, ...location(key), claimIndex: j, message: `${cat} 必须是主张对象` });
          return;
        }

        // 日期精度校验：复用与手工录入完全一致的规则
        let parts = null;
        try {
          const parsed = parseClaimDate(c);
          const iv = claimInterval(parsed.precision, parsed.year, parsed.month, parsed.day);
          parts = {
            precision: parsed.precision,
            year: parsed.year,
            month: parsed.month,
            day: parsed.day,
            dateLabel: formatClaimDate(parsed.precision, parsed.year, parsed.month, parsed.day),
            intervalStart: iv.start,
            intervalEnd: iv.end,
          };
        } catch (e) {
          errors.push({ type: 'invalid_date', location: cat, ...location(key), claimIndex: j, message: `事件「${key || at}」第 ${j + 1} 条主张日期非法：${e.message}` });
        }

        // 出处必填（与手工录入一致）
        let source = null;
        if (!isNonEmptyString(c.source) || !within(c.source, LIMITS.source)) {
          errors.push({ type: 'invalid_source', location: `${cat}.source`, ...location(key), claimIndex: j, message: `事件「${key || at}」第 ${j + 1} 条主张缺少合法出处（source 为非空字符串，长度不超过 ${LIMITS.source}）` });
        } else {
          source = c.source;
        }

        let note = '';
        if (c.note !== undefined && c.note !== null) {
          if (typeof c.note !== 'string' || !within(c.note, LIMITS.note)) {
            errors.push({ type: 'invalid_field', location: `${cat}.note`, ...location(key), claimIndex: j, message: `事件「${key || at}」第 ${j + 1} 条主张的 note 必须是字符串且长度不超过 ${LIMITS.note}` });
          } else {
            note = c.note;
          }
        }

        if (parts && source !== null) {
          claims.push({ ...parts, source, note });
        }
      });
    }

    if (key && title !== null) {
      events.push({ key, title, description, claims });
    }
  });

  const relations = [];
  (pkg.relations || []).forEach((r, i) => {
    const at = `relations[${i}]`;
    if (r === null || typeof r !== 'object' || Array.isArray(r)) {
      errors.push({ type: 'malformed_relation', location: at, message: `${at} 必须是关系对象` });
      return;
    }
    const earlierKey = isNonEmptyString(r.earlierKey) ? r.earlierKey : null;
    const laterKey = isNonEmptyString(r.laterKey) ? r.laterKey : null;
    if (!earlierKey) {
      errors.push({ type: 'invalid_relation_key', location: `${at}.earlierKey`, relationIndex: i, message: `${at}.earlierKey 必须是非空字符串` });
    } else if (!seenKeys.has(earlierKey)) {
      errors.push({ type: 'missing_reference', location: `${at}.earlierKey`, relationIndex: i, earlierKey, message: `第 ${i + 1} 条关系引用的 earlierKey「${earlierKey}」在包内事件中不存在` });
    }
    if (!laterKey) {
      errors.push({ type: 'invalid_relation_key', location: `${at}.laterKey`, relationIndex: i, message: `${at}.laterKey 必须是非空字符串` });
    } else if (!seenKeys.has(laterKey)) {
      errors.push({ type: 'missing_reference', location: `${at}.laterKey`, relationIndex: i, laterKey, message: `第 ${i + 1} 条关系引用的 laterKey「${laterKey}」在包内事件中不存在` });
    }
    if (earlierKey && laterKey && earlierKey === laterKey) {
      errors.push({ type: 'self_relation', location: at, relationIndex: i, earlierKey, laterKey, message: `第 ${i + 1} 条关系中事件「${earlierKey}」不能先于自身` });
    }

    let source = '';
    if (r.source !== undefined && r.source !== null) {
      if (typeof r.source !== 'string' || !within(r.source, LIMITS.source)) {
        errors.push({ type: 'invalid_field', location: `${at}.source`, relationIndex: i, message: `${at}.source 必须是字符串且长度不超过 ${LIMITS.source}` });
      } else {
        source = r.source;
      }
    }
    let note = '';
    if (r.note !== undefined && r.note !== null) {
      if (typeof r.note !== 'string' || !within(r.note, LIMITS.note)) {
        errors.push({ type: 'invalid_field', location: `${at}.note`, relationIndex: i, message: `${at}.note 必须是字符串且长度不超过 ${LIMITS.note}` });
      } else {
        note = r.note;
      }
    }

    if (earlierKey && laterKey && earlierKey !== laterKey && seenKeys.has(earlierKey) && seenKeys.has(laterKey)) {
      relations.push({ earlierKey, laterKey, source, note });
    }
  });

  if (errors.length) return { ok: false, errors, normalized: null };

  const claimCount = events.reduce((n, e) => n + e.claims.length, 0);
  return {
    ok: true,
    errors: [],
    normalized: {
      batchId: pkg.batchId,
      events,
      relations,
      counts: { eventCount: events.length, claimCount, relationCount: relations.length },
    },
  };
}

function currentDraftCounts() {
  const db = getDb();
  return {
    eventCount: db.prepare('SELECT COUNT(*) AS n FROM events').get().n,
    claimCount: db.prepare('SELECT COUNT(*) AS n FROM claims').get().n,
    relationCount: db.prepare('SELECT COUNT(*) AS n FROM relations').get().n,
  };
}

function batchAlreadyImported(batchId) {
  return getDb().prepare('SELECT * FROM imported_batches WHERE batch_id = ?').get(batchId) || null;
}

// 只读预览，不写任何数据。结构性问题抛 400；内容问题抛 422（errors 列出全部问题）。
function buildImportPreview(pkg) {
  const result = validatePackage(pkg);
  if (!result.ok) {
    throw { status: 422, message: '采访整理包校验失败，已整包拒绝（未写入任何内容）', errors: result.errors };
  }
  const { normalized } = result;
  const ledger = batchAlreadyImported(normalized.batchId);
  return {
    batchId: normalized.batchId,
    fingerprint: packageFingerprint(pkg),
    draftRevisionNo: draftRevisionNo(),
    alreadyImported: Boolean(ledger),
    importedAt: ledger ? ledger.imported_at : null,
    counts: normalized.counts,
    currentDraftCounts: currentDraftCounts(),
    events: normalized.events,
    relations: normalized.relations,
  };
}

// 确认导入：原包 + 预览指纹 + 预览草稿修订号；一个事务内整包追加。
function confirmImport({ pkg, fingerprint, expectedRevision }) {
  if (typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint)) {
    throw { status: 400, message: 'fingerprint 必须是预览返回的 64 位十六进制内容指纹' };
  }
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw { status: 400, message: 'draftRevisionNo 必须是非负整数（取预览返回的值）' };
  }

  const db = getDb();

  // 指纹可对任意 JSON 值计算：先比对内容是否被替换
  const actualFingerprint = packageFingerprint(pkg);
  if (actualFingerprint !== fingerprint) {
    throw {
      status: 409,
      code: 'PACKAGE_FINGERPRINT_MISMATCH',
      message: '内容冲突：提交的原包与预览时不一致（内容已被替换）。请重新预览后再确认，本次未写入任何内容。',
      expectedFingerprint: fingerprint,
      actualFingerprint,
    };
  }

  // 防御性完整重校验（客户端可能未经过预览直接确认）
  const result = validatePackage(pkg);
  if (!result.ok) {
    throw { status: 422, message: '采访整理包校验失败，已整包拒绝（未写入任何内容）', errors: result.errors };
  }
  const { normalized } = result;

  const tx = db.transaction(() => {
    const revision = draftRevisionNo();
    if (Number(expectedRevision) !== revision) {
      throw {
        status: 409,
        code: 'DRAFT_REVISION_CONFLICT',
        message: `草稿冲突：你预览导入时草稿修订号为 ${expectedRevision}，现在已变为 ${revision}（期间草稿被修改过）。请重新预览后再确认，本次未写入任何内容。`,
        currentRevisionNo: revision,
        expectedRevisionNo: Number(expectedRevision),
      };
    }

    const ledger = batchAlreadyImported(normalized.batchId);
    if (ledger) {
      throw {
        status: 409,
        code: 'BATCH_ALREADY_IMPORTED',
        message: `批次标识「${normalized.batchId}」曾于 ${ledger.imported_at} 成功导入，同一批次不能重复导入。`,
        batchId: normalized.batchId,
        importedAt: ledger.imported_at,
      };
    }

    const insEvent = db.prepare('INSERT INTO events (title, description) VALUES (?, ?)');
    const insClaim = db.prepare(`
      INSERT INTO claims
        (event_id, precision, year, month, day, date_label, interval_start, interval_end, source, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insRel = db.prepare(
      'INSERT INTO relations (earlier_id, later_id, source, note) VALUES (?, ?, ?, ?)'
    );
    const insLedger = db.prepare(`
      INSERT INTO imported_batches
        (batch_id, fingerprint, revision, event_count, claim_count, relation_count)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    // 纯追加：不动任何现有事件 / 主张 / 关系
    const eventIdByKey = new Map();
    const eventMap = [];
    for (const ev of normalized.events) {
      const eventId = insEvent.run(ev.title, ev.description).lastInsertRowid;
      eventIdByKey.set(ev.key, eventId);
      const claimMap = [];
      ev.claims.forEach((c, j) => {
        const claimId = insClaim.run(
          eventId,
          c.precision,
          c.year,
          c.month,
          c.day,
          c.dateLabel,
          c.intervalStart,
          c.intervalEnd,
          c.source,
          c.note
        ).lastInsertRowid;
        claimMap.push({ index: j, claimId });
      });
      eventMap.push({ key: ev.key, eventId, claims: claimMap });
    }

    const relationMap = [];
    normalized.relations.forEach((r, i) => {
      const earlierEventId = eventIdByKey.get(r.earlierKey);
      const laterEventId = eventIdByKey.get(r.laterKey);
      const relationId = insRel.run(earlierEventId, laterEventId, r.source, r.note).lastInsertRowid;
      relationMap.push({
        index: i,
        relationId,
        earlierKey: r.earlierKey,
        laterKey: r.laterKey,
        earlierEventId,
        laterEventId,
      });
    });

    insLedger.run(
      normalized.batchId,
      actualFingerprint,
      Number(expectedRevision) + 1,
      normalized.counts.eventCount,
      normalized.counts.claimCount,
      normalized.counts.relationCount
    );

    // 每条 INSERT 都触发了修订号自增；整包追加作为一次原子操作只算一次草稿变更
    db.prepare('UPDATE draft_meta SET revision = ? WHERE id = 1').run(Number(expectedRevision) + 1);

    return { eventMap, relationMap };
  });

  const { eventMap, relationMap } = tx();

  return {
    batchId: normalized.batchId,
    fingerprint: actualFingerprint,
    revisionNo: draftRevisionNo(),
    counts: normalized.counts,
    idMap: { events: eventMap, relations: relationMap },
  };
}

module.exports = {
  buildImportPreview,
  confirmImport,
  packageFingerprint,
  validatePackage,
};
