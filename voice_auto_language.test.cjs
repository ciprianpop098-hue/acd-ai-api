const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(__dirname+'/server.js','utf8');
const begin=source.indexOf('const ACD_VOICE_BRAND_PRONUNCIATION =');
const end=source.indexOf('// ACD AI — VOICE SESSION ENDPOINTS',begin);
const names={en:'English',ro:'Romanian',hu:'Hungarian',es:'Spanish',fr:'French',de:'German',it:'Italian',pt:'Portuguese'};
const build=vm.runInNewContext(source.slice(begin,end)+'; buildVoiceInstructions',{languageName:x=>names[x]});
for (const [code,name] of Object.entries(names)) {
 test(name+' initial greeting does not lock subsequent turns',()=>{
  const text=build(code);
  assert.ok(text.includes('Begin the conversation in '+name));
  assert.ok(text.includes('language of EVERY new user turn'));
  assert.ok(text.includes('including a clear single word'));
  assert.ok(text.includes('controls ONLY the first greeting'));
  assert.ok(text.includes('Switch on that same turn'));
  assert.ok(text.includes('ask a brief clarification'));
  assert.equal((text.match(/Ay-See-Dee Ay-Eye/g)||[]).length,1);
  assert.ok(text.includes('Do not repeat the introduction when switching'));
 });
}
test('final appended policy cannot reinstate selected application language lock',()=>{
 const at=source.indexOf('instructions: [\n  buildVoiceInstructions(language),');
 const tail=source.slice(at,source.indexOf('].join("\\n")',at));
 assert.ok(!tail.includes("natural in the user's selected language"));
 assert.ok(tail.includes('latest\nclear spoken user turn'));
 assert.ok(tail.includes('/tʃiˈprjan pop/'));
});
test('keeps VAD and brand policies independent of switching',()=>{
 assert.ok(source.includes('threshold: 0.65'));
 assert.ok(build('en').includes('fixed English\npronunciation of ACD AI alone is not a language-switching signal'));
 assert.ok(build('ro').includes('get_local_datetime'));
});
