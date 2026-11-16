const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(__dirname+'/server.js','utf8');
const begin=source.indexOf('const ACD_VOICE_BRAND_PRONUNCIATION =');
const end=source.indexOf('// ACD AI — VOICE SESSION ENDPOINTS',begin);
const part=source.slice(begin,end);
const names={en:'English',ro:'Romanian',hu:'Hungarian',es:'Spanish',fr:'French',de:'German',it:'Italian',pt:'Portuguese'};
const build=vm.runInNewContext(part+'; buildVoiceInstructions',{languageName:x=>names[x]});
const at=source.indexOf('instructions: [\n  buildVoiceInstructions(language),');
const tail=source.slice(at,source.indexOf('].join("\\n")',at));
for(const [code,name] of Object.entries(names)) {
 test('one canonical English brand definition with '+name+' surroundings',()=>{
  const text=build(code);
  assert.equal((text.match(/Ay-See-Dee Ay-Eye/g)||[]).length,1);
  assert.equal((text.match(/\/eɪ siː diː eɪ aɪ\//g)||[]).length,1);
  assert.ok(text.includes('Begin the conversation in '+name));
  assert.ok(text.includes('immediately return to Romanian'));
  assert.ok(!text.includes('Ei Si Di Ei Ai'));
  assert.ok(!tail.includes('Romanian pronunciation guide'));
 });
}
test('preserves developer rule and unrelated voice tooling policy',()=>{
 assert.ok(tail.includes('/tʃiˈprjan pop/'));
 assert.ok(build('ro').includes('get_local_datetime'));
 assert.ok(build('ro').includes('Do not claim to be human'));
 assert.ok(tail.includes('ACD AI — GLOBAL IDENTITY AND PRONUNCIATION RULES'));
});
