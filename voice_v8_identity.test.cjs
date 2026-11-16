const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(__dirname+'/server.js','utf8');
const begin=source.indexOf('const ACD_VOICE_BRAND_PRONUNCIATION =');
const end=source.indexOf('// ACD AI — VOICE SESSION ENDPOINTS',begin);
const names={en:'English',ro:'Romanian',hu:'Hungarian',es:'Spanish',fr:'French',de:'German',it:'Italian',pt:'Portuguese'};
const build=vm.runInNewContext(source.slice(begin,end)+'; buildVoiceInstructions',{languageName:x=>names[x]});
for(const code of Object.keys(names)) {
 test('general identity in '+code+' retains initial language and English brand',()=>{
  const text=build(code);
  assert.ok(text.includes('versatile, intelligent and natural AI assistant'));
  assert.ok(text.includes('open-ended conversations'));
  assert.ok(text.includes('Decision analysis is one available capability, not your primary identity'));
  assert.ok(!text.includes('assistant and decision coach'));
  assert.ok(!text.includes('\nDECISION COACHING\n'));
  assert.ok(text.includes('Begin the conversation in '+names[code]));
  assert.equal((text.match(/Ay-See-Dee Ay-Eye/g)||[]).length,1);
 });
}
test('general topics are not forced into an A/B verdict; explicit comparison remains',()=>{
 const t=build('en');
 assert.ok(t.includes('When the user explicitly asks to compare options'));
 assert.ok(t.includes('Ask for the options if they are missing'));
 assert.ok(t.includes('without redirecting it into a comparison'));
 assert.ok(t.includes('Offer a recommendation only if requested or helpful for that decision'));
});
test('tool truthfulness, current information and unsupported integrations remain bounded',()=>{
 const t=build('ro');
 assert.ok(t.includes('only tools actually available and authorized'));
 assert.ok(t.includes('web search or weather when relevant and available'));
 assert.ok(t.includes('never claim an external action completed'));
 assert.ok(t.includes('Do not claim access to Life Intelligence, Calendar, AI Studio'));
 assert.ok(t.includes('get_local_datetime'));
 assert.ok(t.includes('Answer direct technology questions truthfully'));
 assert.ok(t.includes('Do not claim to be human'));
});
