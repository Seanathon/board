#!/usr/bin/env python3
"""Render local review files from a validated data bundle. Never applies or executes it."""
import hashlib,html,json,os,re,sys
from pathlib import Path

def text(value):return re.sub(r'([\\`*_{}\[\]#!|])',r'\\\1',html.escape(str(value),quote=False))
def save(path,value):
 with path.open('x') as f:f.write(value)
 os.chmod(path,0o600)
def export(run,bundle_path):
 raw=bundle_path.read_bytes();bundle=json.loads(raw)
 assert bundle['format']=='board-radiator-replacement-bundle/1' and bundle['appliesToProduction'] is False
 entries=bundle['entries'];assert len({e['id'] for e in entries})==bundle['selectionCount']
 key=hashlib.sha256(raw).hexdigest();out=run/('review-export-v2-'+key[:16])
 if out.exists():return out
 out.mkdir(mode=0o700);(out/'pages').mkdir(mode=0o700)
 values=[];blocked=[];index=['# Radiator local analysis review','',f"Selected: {len(entries)}. Counts: `{json.dumps(bundle['counts'],sort_keys=True)}`.",'','Local review drafts only. No production changes. Original IDs/source URLs preserved; no apply/import command.','']
 for entry in entries:
  record={'itemId':entry['id'],'source':entry['source'],'status':entry['status']}
  if entry['status']!='validated-awaiting-human-review':
   record['priorAnalysisRetained']=True;record['validationErrors']=entry.get('errors',[]);record['error']=entry.get('error')
   evidence=run/'evidence'/(hashlib.sha256(entry['id'].encode()).hexdigest()+'.json')
   if evidence.exists():record['sourceCollectionErrors']=json.loads(evidence.read_text()).get('collectionErrors',[])
   blocked.append(record);index.append(f"- **{text(entry['status'])}** — {text(entry['source'])} — ID `{text(entry['id'])}`; previous analysis retained.");continue
  fields=entry['setAnalysisFields'];receipt=entry['controllerReceipt'];page=hashlib.sha256(entry['id'].encode()).hexdigest()+'.md'
  record.update({'fields':fields,'guards':entry['guards'],'expectedOldGeneratedValues':entry['expectedOldGeneratedValues'],'deleteGeneratedKeys':entry['deleteGeneratedKeys'],'activeProfile':entry['activeProfile'],'idempotencyKey':entry['idempotencyKey'],'rawModelOutputSha256':entry['outputSha256'],'fieldKeyNormalizations':entry.get('fieldKeyNormalizations',[]),'evidence':entry['evidence'],'controllerReceipt':receipt,'productionApplied':False})
  values.append(record)
  lines=['# '+text(fields['intel_v1.subject']),'',f"**Relation:** {text(fields['intel_v1.relevance'])} · **Saved URL:** {text(entry['source'])}",f"**ID:** `{text(entry['id'])}` · **Reviewed:** {text(fields['intel_v1.reviewed_on'])}",f"**Model:** `{text(receipt['modelId'])}` · native `{text(receipt.get('nativeTerminalId','unrecorded'))}` · session `{text(receipt.get('sessionId','unrecorded'))}`",'', '**Draft, not production replacement.** Sources are documentary, not independent runtime verification.','']
  for field in bundle['schema']['fields']:
   if field.get('enrichable') and field['key'] not in ['intel_v1.subject','intel_v1.relevance']:
    lines.extend(['## '+text(field['label']),text(fields[field['key']]),''])
  lines.extend(['## Provenance',f"Schema `{text(fields['intel_v1.schema_version'])}` · base prompt `{text(fields['intel_v1.prompt_version'])}`.",f"Expected export-record SHA256: `{entry['guards']['expectedExportRecordSha256']}`.",f"Raw model output SHA256: `{entry['outputSha256']}`.",f"Effective prompt SHA256: `{text(receipt.get('effectivePromptSha256','not recorded in early pilot; base/evidence/CLI logs retained'))}`.",f"Namespace normalization: `{text(json.dumps(entry.get('fieldKeyNormalizations',[])))}`."])
  save(out/'pages'/page,'\n'.join(lines)+'\n')
  index.append(f"- [{text(fields['intel_v1.subject'])}](pages/{page}) — **{text(fields['intel_v1.relevance'])}** — ID `{text(entry['id'])}`")
 assert len(values)+len(blocked)==len(entries)
 save(out/'index.md','\n'.join(index)+'\n')
 save(out/'new-analysis-values.jsonl',''.join(json.dumps(v,ensure_ascii=True)+'\n' for v in values))
 save(out/'blocked-items.json',json.dumps(blocked,ensure_ascii=False,indent=2)+'\n')
 save(out/'migration-bundle.json',raw.decode())
 save(out/'review-summary.json',json.dumps({'selected':len(entries),'validatedDrafts':len(values),'blockedOrFailed':len(blocked),'sourceBundleSha256':key,'modelIds':sorted({v['controllerReceipt']['modelId'] for v in values}),'appliedToProduction':False},indent=2)+'\n')
 return out

def check():
 assert '<script>' not in text('<script>alert(1)</script>')
 assert '[click]' not in text('[click](javascript:bad)')
 assert json.loads(json.dumps({'id':'unchanged','source':'https://example.invalid/'}))['id']=='unchanged'
 encoded=json.dumps({'text':'before\u2028after'},ensure_ascii=True);assert len(encoded.splitlines())==1 and json.loads(encoded)['text']=='before\u2028after'

if __name__=='__main__':
 check()
 if sys.argv[1:]==['--check']:print('PASS: review text escaping and JSON data-only identity check; no network/model/application.');sys.exit(0)
 assert len(sys.argv)==3,'Usage: radiator-review-export.py RUN_DIR BUNDLE_JSON | --check'
 print(export(Path(sys.argv[1]).resolve(),Path(sys.argv[2]).resolve()))
