'use strict';

// JSON 采访整理包导入：只读预览 + 单事务整包追加。
//
// 包格式（UTF-8 JSON 对象）：
//   {
//     batchId: "批次标识（非空字符串，全库唯一，成功导入后不可再次导入）",
//     events: [
//       {
//         key: "包内唯一键（非空字符串，关系按它引用事件）",
//         title: "事件标题（必填）",
//         description: "描述（可选）",
//         claims: [                       // 时间主张；可多条，可互相矛盾
//           { precision: "year|month|day", year: 1958, month: 9, day: 12,
//             source: "出处（必填：受访人/访谈时间/档案全宗/页码等）",
//             note: "考异备注（可选）" }
//         ]
//       }
//     ],
//     relations: [                        // 「先于」关系，按键引用；可省略，等价于 []
//       { earlierKey: "a", laterKey: "b", source: "出处（可选）", note: "备注（可选）" }
//     ]
//   }
//
// 预览（buildImportPreview）只读：整包校验，列出将追加的内容与数量、
// 规范化内容指纹 fingerprint 与当前草稿修订号；有任何问题返回 errors，整包拒绝、不写入。
//
// 确认（commitImport）在一个事务内整包追加到现有草稿（不清空、不覆盖任何现有内容）：
//   - 重新校验原包并重算指纹，与确认提交的 fingerprint 不符 → 409 PACKAGE_CHANGED；
//   - 草稿修订号与预览时不同（期间草稿被增删改）→ 409 DRAFT_REVISION_CONFLICT；
//   - 批次标识曾成功导入 → 409 BATCH_ALREADY_IMPORTED；
//   - 成功后修订号只推进一次（整包算一次草稿变更），
//     已有草稿、历史快照、访客视图均不受影响；新内容仍须经现有选择与先后校验后发布。

const crypto = require('crypto');
const { getDb } = require('./db');
const { parseClaimDate, claimInterval, formatClaimDate } = require('./dates');
const { latestVersionNo } = require('./publish');
const { draftRevisionNo } = require('./restore');

const LIMITS = {
  batchId: 200,
  key: 200,
  title: 200,
  description: 5000,
  source: 1000,
  note: 2000,
};

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

// 400 级错误：请求信封本身缺失/类型不对，无法作为“一个包”校验
function envelopeError(message) {
  return { status: 400, message };
}

// ---------- 整包校验（收集全部问题；不写库） ----------
// 返回 { batchId, events:[{key,title,description,claims:[...]}], relations:[...], counts }
// 或 { errors: [...] }（422 级：包内条目非法）。
function validatePackage(raw) {
  if (!isPlainObject(raw)) throw envelopeError('请求体必须是 JSON 对象（采访整理包）');

  const errors = [];

  if (!isNonEmptyString(raw.batchId)) {
    errors.push({ type: 'invalid_batch', message: 'batchId 批次标识必须是非空字符串' });
  } else if (raw.batchId.length > LIMITS.batchId) {
    errors.push({
      type: 'invalid_batch',
      message: `batchId 长度不能超过 ${LIMITS.batchId}（当前 ${raw.batchId.length}）`,
    });
  }

  const events = [];
  const keys = new Map(); // key -> event 在包内序号

  if (!Array.isArray(raw.events)) {
    errors.push({ type: 'invalid_event', index: null, key: null, message: 'events 必须是事件数组' });
  } else {
    raw.events.forEach((ev, i) => {
      if (!isPlainObject(ev)) {
        errors.push({ type: 'invalid_event', index: i, key: null, message: `第 ${i + 1} 个事件必须是对象` });
        return;
      }
      if (!isNonEmptyString(ev.key)) {
        errors.push({ type: 'invalid_event', index: i, key: null, message: `第 ${i + 1} 个事件缺少非空字符串 key` });
        return;
      }
      if (ev.key.length > LIMITS.key) {
        errors.push({
          type: 'invalid_event',
          index: i,
          key: ev.key,
          message: `事件 ${ev.key} 的 key 长度不能超过 ${LIMITS.key}`,
        });
        return;
      }
      if (keys.has(ev.key)) {
        errors.push({
          type: 'duplicate_key',
          index: i,
          key: ev.key,
          firstIndex: keys.get(ev.key),
          message: `键「${ev.key}」重复：第 ${keys.get(ev.key) + 1} 个与第 ${i + 1} 个事件使用了同一 key`,
        });
        return; // 重复键不纳入合法集合，避免后续关系解析把重复定义当成有效目标
      }

      if (!isNonEmptyString(ev.title)) {
        errors.push({ type: 'invalid_event', index: i, key: ev.key, message: `事件「${ev.key}」缺少非空标题 title` });
        return;
      }
      if (ev.title.length > LIMITS.title) {
        errors.push({
          type: 'invalid_event',
          index: i,
          key: ev.key,
          message: `事件「${ev.key}」标题长度不能超过 ${LIMITS.title}`,
        });
        return;
      }
      const description = typeof ev.description === 'string' ? ev.description.slice(0, LIMITS.description) : '';

      if (ev.claims !== undefined && !Array.isArray(ev.claims)) {
        errors.push({ type: 'invalid_claim', index: i, key: ev.key, claimIndex: null, message: `事件「${ev.key}」的 claims 必须是数组` });
        return;
      }

      const claims = [];
      (Array.isArray(ev.claims) ? ev.claims : []).forEach((c, ci) => {
        if (!isPlainObject(c)) {
          errors.push({
            type: 'invalid_claim', index: i, key: ev.key, claimIndex: ci,
            message: `事件「${ev.key}」第 ${ci + 1} 条主张必须是对象`,
          });
          return;
        }
        // 日期与出处分别校验，两类问题都要列出
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
        } catch (err) {
          errors.push({
            type: 'invalid_date', index: i, key: ev.key, claimIndex: ci,
            message: `事件「${ev.key}」第 ${ci + 1} 条主张日期非法：${err.message}`,
          });
        }
        if (!isNonEmptyString(c.source)) {
          errors.push({
            type: 'invalid_source', index: i, key: ev.key, claimIndex: ci,
            message: `事件「${ev.key}」第 ${ci + 1} 条主张缺少非空出处 source`,
          });
        } else if (c.source.length > LIMITS.source) {
          errors.push({
            type: 'invalid_source', index: i, key: ev.key, claimIndex: ci,
            message: `事件「${ev.key}」第 ${ci + 1} 条主张出处长度不能超过 ${LIMITS.source}`,
          });
        }
        let note = '';
        if (c.note !== undefined && c.note !== null) {
          if (typeof c.note !== 'string') {
            errors.push({
              type: 'invalid_claim', index: i, key: ev.key, claimIndex: ci,
              message: `事件「${ev.key}」第 ${ci + 1} 条主张的 note 必须是字符串`,
            });
          } else if (c.note.length > LIMITS.note) {
            errors.push({
              type: 'invalid_claim', index: i, key: ev.key, claimIndex: ci,
              message: `事件「${ev.key}」第 ${ci + 1} 条主张备注长度不能超过 ${LIMITS.note}`,
            });
          } else {
            note = c.note;
          }
        }
        if (parts && isNonEmptyString(c.source) && c.source.length <= LIMITS.source) {
          claims.push({ index: ci, ...parts, source: c.source, note });
        }
      });

      keys.set(ev.key, i);
      events.push({ index: i, key: ev.key, title: ev.title, description, claims });
    });
  }

  const relations = [];
  if (raw.relations !== undefined && !Array.isArray(raw.relations)) {
    errors.push({ type: 'invalid_relation', relationIndex: null, message: 'relations 必须是数组' });
  } else if (Array.isArray(raw.relations)) {
    raw.relations.forEach((r, i) => {
      if (!isPlainObject(r)) {
        errors.push({ type: 'invalid_relation', relationIndex: i, message: `第 ${i + 1} 条关系必须是对象` });
        return;
      }
      const earlierKey = r.earlierKey;
      const laterKey = r.laterKey;
      if (!isNonEmptyString(earlierKey) || !isNonEmptyString(laterKey)) {
        errors.push({
          type: 'invalid_relation', relationIndex: i,
          message: `第 ${i + 1} 条关系必须以非空 earlierKey/laterKey 引用事件`,
        });
        return;
      }
      if (!keys.has(earlierKey)) {
        errors.push({
          type: 'missing_relation_key', relationIndex: i, key: earlierKey,
          message: `第 ${i + 1} 条关系引用了不存在的事件键 earlierKey「${earlierKey}」`,
        });
      }
      if (!keys.has(laterKey)) {
        errors.push({
          type: 'missing_relation_key', relationIndex: i, key: laterKey,
          message: `第 ${i + 1} 条关系引用了不存在的事件键 laterKey「${laterKey}」`,
        });
      }
      if (keys.has(earlierKey) && keys.has(laterKey) && earlierKey === laterKey) {
        errors.push({
          type: 'self_relation', relationIndex: i, key: earlierKey,
          message: `第 ${i + 1} 条关系自相引用：事件「${earlierKey}」不能先于自身`,
        });
        return;
      }
      let source = '';
      if (r.source !== undefined && r.source !== null) {
        if (typeof r.source !== 'string') {
          errors.push({
            type: 'invalid_relation', relationIndex: i,
            message: `第 ${i + 1} 条关系的 source 必须是字符串`,
          });
        } else if (r.source.length > LIMITS.source) {
          errors.push({
            type: 'invalid_relation', relationIndex: i,
            message: `第 ${i + 1} 条关系出处长度不能超过 ${LIMITS.source}`,
          });
        } else {
          source = r.source;
        }
      }
      let note = '';
      if (r.note !== undefined && r.note !== null) {
        if (typeof r.note !== 'string') {
          errors.push({
            type: 'invalid_relation', relationIndex: i,
            message: `第 ${i + 1} 条关系的 note 必须是字符串`,
          });
        } else if (r.note.length > LIMITS.note) {
          errors.push({
            type: 'invalid_relation', relationIndex: i,
            message: `第 ${i + 1} 条关系备注长度不能超过 ${LIMITS.note}`,
          });
        } else {
          note = r.note;
        }
      }
      if (keys.has(earlierKey) && keys.has(laterKey) && earlierKey !== laterKey) {
        relations.push({ index: i, earlierKey, laterKey, source, note });
      }
    });
  }

  if (errors.length) return { errors };

  // 包内至少一个事件，才值得作为“整包”追加
  if (events.length === 0) {
    return { errors: [{ type: 'invalid_event', index: null, key: null, message: '包内 events 为空：至少需要一个事件' }] };
  }

  const counts = {
    eventCount: events.length,
    claimCount: events.reduce((n, e) => n + e.claims.length, 0),
    relationCount: relations.length,
  };
  return { batchId: raw.batchId, events, relations, counts };
}

// ---------- 内容指纹：规范化原包后取 SHA-256 ----------
// 与现有录入路径保持一致：key/title 去除首尾空白；source 原样保留（现有主张录入亦保留原样）。
// 只纳入业务字段；多余字段不影响指纹（但 claims/relations 中的多余字段同样被忽略）。
function normalizePackage(raw) {
  return {
    batchId: typeof raw.batchId === 'string' ? raw.batchId.trim() : raw.batchId,
    events: (Array.isArray(raw.events) ? raw.events : []).map((ev) => ({
      key: ev.key.trim(),
      title: ev.title.trim(),
      description: typeof ev.description === 'string' ? ev.description : '',
      claims: (Array.isArray(ev.claims) ? ev.claims : []).map((c) => {
        const p = parseClaimDate(c);
        return {
          precision: p.precision,
          year: p.year,
          month: p.month,
          day: p.day,
          source: c.source,
          note: typeof c.note === 'string' ? c.note : '',
        };
      }),
    })),
    relations: (Array.isArray(raw.relations) ? raw.relations : []).map((r) => ({
      earlierKey: r.earlierKey.trim(),
      laterKey: r.laterKey.trim(),
      source: typeof r.source === 'string' ? r.source : '',
      note: typeof r.note === 'string' ? r.note : '',
    })),
  };
}

// 稳定序列化：对象键排序（递归），数组保序；无空白
function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function packageFingerprint(raw) {
  return crypto.createHash('sha256').update(stableStringify(normalizePackage(raw)), 'utf8').digest('hex');
}

// ---------- 只读预览 ----------
function buildImportPreview(raw) {
  const result = validatePackage(raw);
  if (result.errors) return { ok: false, errors: result.errors };

  const db = getDb();
  const imported = db.prepare('SELECT * FROM imported_batches WHERE batch_id = ?').get(result.batchId);
  const revision = draftRevisionNo();

  const previewEvents = result.events.map((e) => ({
    key: e.key,
    title: e.title,
    description: e.description,
    claims: e.claims.map((c) => ({
      index: c.index,
      precision: c.precision,
      year: c.year,
      month: c.month,
      day: c.day,
      dateLabel: c.dateLabel,
      intervalStart: c.intervalStart,
      intervalEnd: c.intervalEnd,
      source: c.source,
      note: c.note,
    })),
  }));
  const previewRelations = result.relations.map((r) => ({
    index: r.index,
    earlierKey: r.earlierKey,
    laterKey: r.laterKey,
    source: r.source,
    note: r.note,
  }));

  return {
    ok: true,
    batchId: result.batchId,
    fingerprint: packageFingerprint(raw),
    counts: result.counts,
    draftRevisionNo: revision,
    currentVersionNo: latestVersionNo(),
    batchAlreadyImported: !!imported,
    previousImport: imported
      ? {
          batchId: imported.batch_id,
          revisionNo: imported.revision_no,
          importedAt: imported.imported_at,
          eventCount: imported.event_count,
          claimCount: imported.claim_count,
          relationCount: imported.relation_count,
        }
      : null,
    events: previewEvents,
    relations: previewRelations,
  };
}

// ---------- 确认：整包追加（单事务） ----------
// expectedRevision：预览时草稿修订号；expectedFingerprint：预览时内容指纹。
function commitImport({ raw, expectedFingerprint, expectedRevision }) {
  if (typeof expectedFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(expectedFingerprint)) {
    throw envelopeError('fingerprint 必须是预览返回的 64 位十六进制内容指纹');
  }
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw envelopeError('draftRevisionNo 必须是非负整数（取预览时返回的值）');
  }

  const result = validatePackage(raw);
  if (result.errors) {
    throw { status: 422, message: '采访整理包校验未通过，整包拒绝、未写入任何数据', errors: result.errors };
  }

  // 内容被替换：以服务器重算的规范化指纹为准
  const fingerprint = packageFingerprint(raw);
  if (fingerprint !== expectedFingerprint) {
    throw {
      status: 409,
      code: 'PACKAGE_CHANGED',
      message: '内容冲突：提交的原包与预览时不一致（内容指纹不符）。请重新预览后再确认，本次未写入任何数据。',
      expectedFingerprint,
      actualFingerprint: fingerprint,
    };
  }

  const db = getDb();

  const tx = db.transaction(() => {
    // 事务内再次确认草稿修订号，避免并发下的静默追加
    const revision = draftRevisionNo();
    if (Number(expectedRevision) !== revision) {
      throw {
        status: 409,
        code: 'DRAFT_REVISION_CONFLICT',
        message: `草稿冲突：你预览导入时草稿修订号为 ${expectedRevision}，现在已变为 ${revision}（期间草稿被修改过）。请重新预览后再确认，本次未写入任何数据。`,
        currentRevisionNo: revision,
        expectedRevisionNo: Number(expectedRevision),
      };
    }

    // 批次标识曾成功导入（UNIQUE 约束是最后一道防线，这里先给清晰错误）
    const dup = db.prepare('SELECT id, imported_at AS importedAt, revision_no AS revisionNo FROM imported_batches WHERE batch_id = ?').get(result.batchId);
    if (dup) {
      throw {
        status: 409,
        code: 'BATCH_ALREADY_IMPORTED',
        message: `批次标识「${result.batchId}」曾成功导入（修订号 ${dup.revisionNo}，时间 ${dup.importedAt}），同一批次不可重复导入。本次未写入任何数据。`,
        batchId: result.batchId,
        previousImport: dup,
      };
    }

    const insEvent = db.prepare('INSERT INTO events (title, description) VALUES (?, ?)');
    const insClaim = db.prepare(`
      INSERT INTO claims
        (event_id, precision, year, month, day, date_label, interval_start, interval_end, source, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insRel = db.prepare('INSERT INTO relations (earlier_id, later_id, source, note) VALUES (?, ?, ?, ?)');

    const idMap = { events: [], relations: [] };
    const newIdByKey = new Map();

    for (const ev of result.events) {
      const evInfo = insEvent.run(ev.title, ev.description);
      const newEventId = evInfo.lastInsertRowid;
      const claimIds = [];
      for (const c of ev.claims) {
        const cInfo = insClaim.run(
          newEventId,
          c.precision, c.year, c.month, c.day, c.dateLabel,
          c.intervalStart, c.intervalEnd, c.source, c.note
        );
        claimIds.push({ index: c.index, claimId: cInfo.lastInsertRowid });
      }
      newIdByKey.set(ev.key, newEventId);
      idMap.events.push({ key: ev.key, eventId: newEventId, claims: claimIds });
    }

    for (const r of result.relations) {
      const info = insRel.run(newIdByKey.get(r.earlierKey), newIdByKey.get(r.laterKey), r.source, r.note);
      idMap.relations.push({
        index: r.index,
        relationId: info.lastInsertRowid,
        earlierKey: r.earlierKey,
        laterKey: r.laterKey,
        earlierEventId: newIdByKey.get(r.earlierKey),
        laterEventId: newIdByKey.get(r.laterKey),
      });
    }

    // 整包作为一次原子草稿变更：上面每条 INSERT 都触发了修订号自增，
    // 最终校正为预览时的值 + 1（与恢复草稿同样的“整包只算一次修订”约定）。
    db.prepare('UPDATE draft_meta SET revision = ? WHERE id = 1').run(Number(expectedRevision) + 1);

    // 只追加台账：登记成功批次，使 batchId 永久不可再次导入
    db.prepare(`
      INSERT INTO imported_batches
        (batch_id, fingerprint, event_count, claim_count, relation_count, base_revision, revision_no)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      result.batchId,
      fingerprint,
      result.counts.eventCount,
      result.counts.claimCount,
      result.counts.relationCount,
      Number(expectedRevision),
      Number(expectedRevision) + 1
    );

    return idMap;
  });

  let idMap;
  try {
    idMap = tx();
  } catch (err) {
    // UNIQUE(batch_id) 竞态：另一请求已抢先导入同批次
    if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      throw {
        status: 409,
        code: 'BATCH_ALREADY_IMPORTED',
        message: `批次标识「${result.batchId}」已被另一请求成功导入，同一批次不可重复导入。本次未写入任何数据。`,
        batchId: result.batchId,
      };
    }
    throw err;
  }

  return {
    ok: true,
    batchId: result.batchId,
    fingerprint,
    counts: result.counts,
    baseRevisionNo: Number(expectedRevision),
    revisionNo: Number(expectedRevision) + 1,
    currentVersionNo: latestVersionNo(),
    idMap,
  };
}

module.exports = {
  validatePackage,
  packageFingerprint,
  buildImportPreview,
  commitImport,
};
