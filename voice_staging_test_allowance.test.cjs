const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const crypto=require('node:crypto');
const source=fs.readFileSync(__dirname+'/server.js','utf8');
const start=source.indexOf('function isVoiceStagingTestUser(');
const end=source.indexOf('// Staging-only single-variable comparison;',start);
const allow=vm.runInNewContext('('+source.slice(start,end).trim()+')',{crypto,process:{env:{}}});
const uid='fixture-owned-staging-user';
const hash=crypto.createHash('sha256').update(uid).digest('hex');
const env={FIREBASE_PROJECT_ID:'acd-ai-community-staging',VOICE_STAGING_TEST_UID_SHA256S:hash};
test('only exact owned Staging account receives QA time',()=>{
 assert.equal(allow(uid,env),true);assert.equal(allow('different-user',env),false);
});
for(const project of ['acd-ai','unrecognized','']) {
 test('QA allowance disabled for '+project,()=>assert.equal(allow(uid,{...env,FIREBASE_PROJECT_ID:project}),false));
}
test('missing/malformed allowlist and missing UID fail closed',()=>{
 for(const value of ['',uid,'*','all','true']) assert.equal(allow(uid,{...env,VOICE_STAGING_TEST_UID_SHA256S:value}),false);
 for(const value of [null,undefined,'',42]) assert.equal(allow(value,env),false);
});
test('comma-separated hashes are normalized without wildcard matching',()=>{
 assert.equal(allow(uid,{...env,VOICE_STAGING_TEST_UID_SHA256S:'invalid, '+hash.toUpperCase()}),true);
});
test('only status/session consult allowance after authenticated requireVoiceUser',()=>{
 for(const route of ['app.get("/voice/status"','app.post("/voice/session"']) {
  const section=source.slice(source.indexOf(route));
  assert.ok(section.indexOf('requireVoiceUser(req, res)')<section.indexOf('isVoiceStagingTestUser(uid)'));
  assert.ok(section.includes('"staging_test"'));
 }
 assert.ok(source.includes('unlimited: isUnlimited'));
 assert.ok(source.includes('if (!isUnlimited) {\n      reservation = await reserveFreeVoice(uid)'));
});
