const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(__dirname + '/server.js', 'utf8');
const begin = source.indexOf('async function voiceHasPro(');
let depth = 0, end = source.indexOf('{\n', begin);
const startBody = end;
for (; end < source.length; end++) {
  if (source[end] === '{') depth++;
  if (source[end] === '}' && --depth === 0) { end++; break; }
  // count decrements only for closing braces
  if (source[end] !== '}') { /* no-op */ }
}
// Function declaration also has an options destructuring brace before its body;
// start from the newline-delimited body opener, preserving complete declaration.
const fnSource = source.slice(begin, end);
function verifier(status, body, project = 'acd-ai-community-staging') {
  const context = { process:{env:{REVENUECAT_SECRET_KEY:'fixture',REVENUECAT_PROJECT_ID:'fixture',FIREBASE_PROJECT_ID:project}},
    AbortSignal, fetch: async () => ({status,ok:status>=200&&status<300,json:async()=>body}) };
  return vm.runInNewContext('(' + fnSource + ')',context);
}
for(const status of [401,403,429,500,503]) {
  test('entitlement HTTP '+status+' fails closed',async()=>{
    await assert.rejects(verifier(status,{type:'resource_missing'})('fixture-user',{allowMissingCustomer:true}), /HTTP/);
  });
}
test('known absent Staging customer remains Free',async()=>{
  assert.equal(await verifier(404,{type:'resource_missing'})('fixture-user',{allowMissingCustomer:true}),false);
});
test('unrecognized 404 remains an error',async()=>{
  await assert.rejects(verifier(404,{type:'other'})('fixture-user',{allowMissingCustomer:true}),/HTTP 404/);
});
test('default Production behavior rejects missing customer',async()=>{
  await assert.rejects(verifier(404,{type:'resource_missing'},'acd-ai')('fixture-user'),/HTTP 404/);
});
test('real entitlement response retains Pro',async()=>{
  assert.equal(await verifier(200,{items:[{entitlement_id:'pro'}]})('fixture-user',{allowMissingCustomer:true}),true);
});
test('empty successful entitlements remain Free',async()=>{
  assert.equal(await verifier(200,{items:[]})('fixture-user',{allowMissingCustomer:true}),false);
});
for (const route of ['app.get("/voice/status"','app.post("/voice/session"']) {
  const at = source.indexOf(route);
  const after = source.slice(at);
  const match = after.match(/voiceHasPro\(uid,\s*(\{[\s\S]*?\})\);/);
  for (const project of ['acd-ai-community-staging','acd-ai','unrecognized']) {
    test(route+' missing-customer guard for '+project,()=>{
      assert.ok(match, 'expected guarded existing voiceHasPro call');
      const options = vm.runInNewContext('('+match[1]+')',{process:{env:{FIREBASE_PROJECT_ID:project}}});
      assert.equal(options.allowMissingCustomer,project==='acd-ai-community-staging');
    });
  }
}
