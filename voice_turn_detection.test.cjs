const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const source=fs.readFileSync(__dirname+'/server.js','utf8');
const begin=source.indexOf('function buildVoiceInputConfiguration(');
const end=source.indexOf('\nfunction buildVoiceInstructions(',begin);
const fn=vm.runInNewContext('('+source.slice(begin,end).trim()+')',{process:{env:{}}});
const serialize=project=>JSON.parse(JSON.stringify({audio:{input:fn(project),output:{voice:'unchanged-fixture'}}}));
test('Staging candidate changes one effective baseline value and keeps fast barge-in enabled',()=>{
  const baseline={type:'server_vad',threshold:.5,prefix_padding_ms:300,silence_duration_ms:500,create_response:true,interrupt_response:true};
  const candidate=JSON.parse(JSON.stringify(fn('acd-ai-community-staging'))).turn_detection;
  assert.deepEqual({...candidate,threshold:.5},baseline);
  assert.equal(candidate.threshold,.65);
  assert.equal(candidate.interrupt_response,true);
  assert.equal(candidate.create_response,true);
});
for(const project of ['acd-ai','unrecognized','']) {
 test('Production/default payload unchanged for '+project,()=>{
  assert.equal(fn(project),undefined);
  assert.deepEqual(serialize(project),{audio:{output:{voice:'unchanged-fixture'}}});
 });
}
test('candidate does not add audio filters or alter output voice',()=>{
 const audio=serialize('acd-ai-community-staging').audio;
 assert.deepEqual(Object.keys(audio.input),['turn_detection']);
 assert.deepEqual(audio.output,{voice:'unchanged-fixture'});
});
