'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
process.env.EDITOR_TOKEN='test-token';
const Database = require('better-sqlite3');
const mem = new Database(':memory:');
const { SCHEMA, setDb } = require('./src/db');
mem.exec(SCHEMA); setDb(mem);
const { app } = require('./src/server');
let base, server;
test('start', async () => {
  await new Promise(r => server = app.listen(0,'127.0.0.1',r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test('append after publish', async () => {
  const call = async (m,u,b) => { const res=await fetch(base+u,{method:m,headers:{'Content-Type':'application/json','X-Editor-Token':'test-token'},body:b?JSON.stringify(b):undefined}); return {status:res.status,json:await res.json()}; };
  mem.exec("DELETE FROM version_relations;DELETE FROM version_events;DELETE FROM versions;DELETE FROM relations;DELETE FROM claims;DELETE FROM events;DELETE FROM imported_batches;DELETE FROM sqlite_sequence;UPDATE draft_meta SET revision=0;");
  const e=(await call('POST','/api/editor/events',{title:'原有事件'})).json.event.id;
  const c=(await call('POST',`/api/editor/events/${e}/claims`,{precision:'year',year:1950,source:'旧档案'})).json.claim.id;
  const pub=await call('POST','/api/editor/publish',{selection:[{eventId:e,claimId:c}],baseVersionNo:0});
  console.log('pub status', pub.status);
  const pkg={batchId:'batch-2026-01',events:[{key:'mobilize',title:'修水渠动员会',description:'x',claims:[{precision:'day',year:1958,month:9,day:12,source:'s1'},{precision:'year',year:1958,source:'s2'}]},{key:'water',title:'东干渠通水',claims:[{precision:'month',year:1959,month:5,source:'s3'}]}],relations:[{earlierKey:'mobilize',laterKey:'water',source:'二人口述一致'}]};
  const pv=(await call('POST','/api/editor/import-preview',pkg)).json;
  console.log('pv rev', pv.draftRevisionNo, pv.currentVersionNo);
  const r=await call('POST','/api/editor/import-commit',{pkg,fingerprint:pv.fingerprint,draftRevisionNo:pv.draftRevisionNo});
  console.log('commit status', r.status);
  console.log(JSON.stringify(r.json).slice(0,300));
  assert.strictEqual(r.json.revisionNo,3);
});
