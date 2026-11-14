import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import { extractSource, fetchPublic, collect } from './radiator-sources.mjs';
test('public research parsing never executes scripts; unsafe URLs fail before HTTP',async()=>{
  globalThis.__boardUntrustedScript=false;
  const d=extractSource(Buffer.from('<title>Fixture</title><meta name="description" content="Documented facts"><script>globalThis.__boardUntrustedScript=true</script><style>body { --secret: 1; }</style><h1>Product</h1><p>A useful workflow.</p><a href="/pricing">Plans</a>'),'https://fixture.invalid/');
  assert.equal(globalThis.__boardUntrustedScript,false);assert(!d.text.includes('globalThis'));assert(!d.text.includes('secret'));
  assert(d.text.includes('A useful workflow.'));assert.equal(d.links[0].url,'https://fixture.invalid/pricing');
  assert.equal(extractSource(Buffer.from('<p>'+('x'.repeat(7000))+'</p>'),'https://fixture.invalid').truncated,true);
  await assert.rejects(fetchPublic('file:///etc/passwd'),/Unsupported/);
  await assert.rejects(fetchPublic('http://127.0.0.1/'),/blocked/);
  await assert.rejects(fetchPublic('https://user:pass@example.com/'),/Unsupported/);
});

test('resume reuses pinned source evidence byte-for-byte without a network request',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'board-source-pin-'));
 try{fs.mkdirSync(path.join(dir,'evidence'));fs.writeFileSync(path.join(dir,'run.json'),JSON.stringify({jobs:[{id:'fixture',key:'fixture',source:'https://fixture.invalid/'}]}));
 const p=path.join(dir,'evidence','fixture.json');fs.writeFileSync(p,JSON.stringify({itemId:'fixture',source:'https://fixture.invalid/',sources:[{id:'T1',text:'Pinned fixture only'}]}));
 const before=fs.readFileSync(p);assert.equal((await collect(dir,'fixture')).reused,true);assert.deepEqual(fs.readFileSync(p),before);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
