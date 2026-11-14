// Current first-party source collector: no model, script execution, browser, cookies or credentials.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const ROOT=fileURLToPath(new URL('../',import.meta.url));
const { assertCapturableUrl } = await import(pathToFileURL(path.join(ROOT,'src/capture/net-guard.ts')));
const { JSDOM } = createRequire(path.join(ROOT,'package.json'))('jsdom');
const sha=s=>createHash('sha256').update(s).digest('hex');
const load=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const write=(p,o)=>fs.writeFileSync(p,JSON.stringify(o,null,2)+'\n',{flag:'wx',mode:0o600});

export async function fetchPublic(raw, redirects=0) {
  const u=new URL(raw);
  assert(['http:','https:'].includes(u.protocol) && !u.username && !u.password && (!u.port || ['80','443'].includes(u.port)), 'Unsupported public source URL');
  assert(redirects<=5,'Redirect bound exceeded');
  const host=u.hostname.replace(/^\[|\]$/g,'');
  // IPv4-only is deliberate: fail closed for IPv6-only sites; pin validated DNS to avoid rebinding.
  const addresses=await dns.lookup(host,{family:4,all:true});assert(addresses.length,'No public IPv4 address');
  await assertCapturableUrl(u.href,{lookup:async()=>addresses});
  const a=addresses[0];
  const response=await new Promise((resolve,reject)=>{
    const req=(u.protocol==='https:'?https:http).get(u,{signal:AbortSignal.timeout(30000),headers:{'user-agent':'Board local product research/1','accept-encoding':'identity'},lookup:(_h,o,cb)=>o.all?cb(null,[a]):cb(null,a.address,a.family)},res=>{
      if([301,302,303,307,308].includes(res.statusCode)&&res.headers.location){res.destroy();resolve({redirect:new URL(res.headers.location,u).href});return;}
      if(res.statusCode<200||res.statusCode>=300){res.destroy();reject(new Error(`HTTP${res.statusCode}`));return;}
      const encoding=String(res.headers['content-encoding']??'identity').toLowerCase();
      if(encoding!=='identity'){res.destroy();reject(new Error('Compressed response refused; identity requested'));return;}
      const mime=String(res.headers['content-type']??'').toLowerCase();
      if(!(mime.startsWith('text/')||mime.includes('application/xhtml+xml'))){res.destroy();reject(new Error('Not a text/HTML source'));return;}
      const chunks=[];let bytes=0;
      res.on('data',chunk=>{bytes+=chunk.length;if(bytes>1048576)res.destroy(new Error('Source exceeds1MiB'));else chunks.push(chunk);});
      res.on('error',reject);res.on('end',()=>resolve({url:u.href,bytes:Buffer.concat(chunks),mime}));
    });req.on('error',reject);
  });
  return response.redirect?fetchPublic(response.redirect,redirects+1):response;
}
export function extractSource(bytes,url) {
  const dom=new JSDOM(bytes.toString('utf8'),{url}); // default: no JS execution or remote resources
  const doc=dom.window.document;const links=[...doc.querySelectorAll('a[href]')].map(a=>({url:a.href,label:a.textContent.trim()}));
  const title=doc.title;const description=doc.querySelector('meta[name="description"]')?.getAttribute('content')??'';
  doc.querySelectorAll('script,style,noscript,svg').forEach(e=>e.remove());
  doc.querySelectorAll('p,div,li,section,h1,h2,h3,h4,tr,br').forEach(e=>e.prepend(doc.createTextNode('\n')));
  const full=(title+'\n'+description+'\n'+(doc.body?.textContent??'')).replace(/[ \t]+/g,' ').replace(/\n\s*\n+/g,'\n').trim();
  dom.window.close();return {title,text:full.slice(0,6000),fullTextChars:full.length,truncated:full.length>6000,links};
}
export async function collect(runDir,key,{refresh=false}={}) {
  const manifest=load(path.join(runDir,'run.json'));const job=manifest.jobs.find(j=>j.key===key);assert(job,'Unselected job');
  const existing=path.join(runDir,'evidence',key+'.json');
  if(fs.existsSync(existing)&&!refresh){const pinned=load(existing);assert(pinned.itemId===job.id&&pinned.source===job.source,'Pinned evidence identity mismatch');return {itemId:job.id,key,sources:pinned.sources.length,errors:pinned.collectionErrors??[],reused:true};}
  const downloads=path.join(runDir,'source-downloads');fs.mkdirSync(downloads,{recursive:true,mode:0o700});
  const sources=[],errors=[];let links=[];
  const allowed=new Set([new URL(job.source).hostname.replace(/^www\./,'')]);
  for(let n=0;n<2;n++){
    let requested=job.source;
    if(n){
      const next=links.filter(l=>{try{const u=new URL(l.url);const h=u.hostname.replace(/^www\./,'');return [...allowed].some(a=>h===a||h.endsWith('.'+a))&&/\/(pricing|product|platform|docs|features|enterprise)(?:\/|$)/i.test(u.pathname)&&!sources.some(s=>s.url===u.href);}catch{return false;}}).sort((a,b)=>(/pricing/i.test(b.url)?1:0)-(/pricing/i.test(a.url)?1:0))[0];
      if(!next)break;requested=next.url;
    }
    try{
      const r=await fetchPublic(requested);allowed.add(new URL(r.url).hostname.replace(/^www\./,''));
      const data=extractSource(r.bytes,r.url);if(data.text.trim().length<80)throw new Error('Thin/no readable source');
      if(/verify (?:that )?you are human|checking your browser|enable javascript and cookies|cloudflare ray id|just a moment.*cloudflare/i.test(data.text))throw new Error('Human-verification/challenge page, not product evidence');
      const dir=fs.mkdtempSync(path.join(downloads,'source-'));fs.chmodSync(dir,0o700);
      const rawPath=path.join(dir,'body.html');fs.writeFileSync(rawPath,r.bytes,{flag:'wx',mode:0o600});
      sources.push({id:`T${sources.length+1}`,url:r.url,requestedUrl:requested,title:data.title,kind:'primary',retrievedOn:new Date().toISOString().slice(0,10),text:data.text,fullTextChars:data.fullTextChars,truncated:data.truncated,rawSha256:sha(r.bytes),excerptSha256:sha(data.text),rawFile:rawPath,collectionMethod:'Direct public HTTP; pinned validated IPv4; HTML parsed without scripts/resources; explicit6000char excerpt cap'});
      if(!n)links=data.links;
    }catch(e){errors.push({url:requested,error:e.message});if(!n)break;}
  }
  const evidence={itemId:job.id,source:job.source,sources,collectionErrors:errors,analysisPerformed:false};
  const dest=path.join(runDir,'evidence',key+'.json');
  if(fs.existsSync(dest)){
    const history=path.join(runDir,'evidence-history');fs.mkdirSync(history,{recursive:true,mode:0o700});
    const prior=fs.readFileSync(dest);const backup=path.join(history,`${key}.${sha(prior)}.json`);if(!fs.existsSync(backup))fs.writeFileSync(backup,prior,{flag:'wx',mode:0o600});
  }
  const tmp=dest+'.tmp';write(tmp,evidence);fs.renameSync(tmp,dest);
  return {itemId:job.id,key,sources:sources.length,errors};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const [run,key,flag]=process.argv.slice(2);assert(run&&key&&(!flag||flag==='--refresh'),'Usage: radiator-sources.mjs RUN_DIR KEY [--refresh]');console.log(JSON.stringify(await collect(run,key,{refresh:flag==='--refresh'})));}
  catch(e){console.error(e.message);process.exitCode=1;}
}
