const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(__dirname+'/server.js','utf8');
const begin=source.indexOf('const ACD_VOICE_BRAND_PRONUNCIATION =');
const end=source.indexOf('// ACD AI — VOICE SESSION ENDPOINTS',begin);
const names={en:'English',ro:'Romanian',hu:'Hungarian',es:'Spanish',fr:'French',de:'German',it:'Italian',pt:'Portuguese'};
const build=vm.runInNewContext(source.slice(begin,end)+'; buildVoiceInstructions',{languageName:x=>names[x]});
for(const [code,name] of Object.entries(names)) {
 test(name+' opening default accepts greetings and short turns in every subsequent language',()=>{
  const text=build(code);
  assert.ok(text.includes('Use '+name+' only as the default for the opening greeting'));
  assert.ok(text.includes('A clear greeting, ordinary short phrase or question counts as a real turn'));
  assert.ok(text.includes('Any supported language\nmay follow any other, in any order'));
  assert.ok(text.includes('preserve the conversation context'));
  assert.ok(text.includes('Do not restart the conversation or repeat your introduction'));
  assert.ok(!text.includes('meaningful spoken utterances'));
 });
}
test('mixed and ambiguous speech is contextual; English brand is not a language lock',()=>{
 const t=build('en');
 assert.ok(t.includes('If the user mixes languages within one turn'));
 assert.ok(t.includes('genuinely\nambiguous short words'));
 assert.ok(t.includes('must never lock the reply to English'));
 assert.ok(t.includes('versatile, intelligent and natural AI assistant'));
 assert.ok(t.includes('OPTIONAL DECISION SUPPORT'));
});
test('final appended policy cannot override short-turn language with app selection',()=>{
 const at=source.indexOf('instructions: [\n  buildVoiceInstructions(language),');
 const tail=source.slice(at,source.indexOf('].join("\\n")',at));
 assert.ok(!tail.includes("natural in the user's selected language"));
 assert.ok(tail.includes('latest clear spoken turn'));
 assert.ok(tail.includes('including a greeting or short question'));
});
