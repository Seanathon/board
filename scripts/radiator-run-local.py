#!/usr/bin/env python3
"""Serial native-Herdr controller for already-authorized selected local research. No API/SDK."""
import json,os,re,subprocess,sys,time
from pathlib import Path
WORK=Path(__file__).resolve().parent.parent;ROOT=WORK
NODE=os.environ.get('RADIATOR_NODE_COMMAND','node')
PARENT=os.environ.get('HC_TERMINAL_ID')
def cmd(argv,timeout=280,cwd=WORK):
 p=subprocess.run(argv,cwd=cwd,text=True,capture_output=True,timeout=timeout)
 if p.returncode:raise RuntimeError('Command failed: '+argv[0]+' '+p.stderr[-1000:])
 return json.loads(p.stdout)
def emit(run,event):
 with (run/'execution-progress.jsonl').open('a') as f:f.write(json.dumps(event)+'\n');f.flush();os.fsync(f.fileno())
 os.chmod(run/'execution-progress.jsonl',0o600);print(json.dumps(event),flush=True)
def make_bundle(run):return cmd([NODE,str(WORK/'scripts/radiator-intel.mjs'),'bundle',str(run)])
def current_entry(run,iid):
 result=make_bundle(run);data=json.loads(Path(result['file']).read_text());return next(e for e in data['entries'] if e['id']==iid)
def pause_reason(entry):
 for error in entry.get('errors',[]):
  if 'finite ceiling' in error.get('error',''):return 'resource-limit'
  if error.get('category') in ['provider-usage','provider-auth','model-route','resource-limit','worker-setup']:return error['category']
 return None

def main():
 assert PARENT,'Run from a verified native Herdr terminal'
 run=Path(sys.argv[1]).resolve();manifest=json.loads((run/'run.json').read_text());pilot=json.loads((run/'pilot-quality-review.json').read_text())
 assert pilot['continueLocalBatch'] is True and pilot['productionApproved'] is False
 assert manifest['selection']['boardId']=='radiator-9k51' and len(manifest['jobs'])==119 and manifest['fixture'] is False
 pilot_ids={j['itemId'] for j in json.loads((run/'pilot-selection.json').read_text())['jobs']}
 remaining=[j for j in manifest['jobs'] if j['id'] not in pilot_ids];assert len(remaining)==116
 done=0;stopped=None
 for job in remaining:
  existing=current_entry(run,job['id'])
  if existing['status']=='validated-awaiting-human-review':done+=1;continue
  if pause_reason(existing):
   stopped='Paused for existing '+pause_reason(existing)+'; no budget-expanding retry';break
  try:
   collected=cmd([NODE,'--import','tsx',str(WORK/'scripts/radiator-sources.mjs'),str(run),job['key']],timeout=100,cwd=ROOT)
   emit(run,{'stage':'sources','itemId':job['id'],'sources':collected['sources'],'errors':collected['errors']})
   if not collected['sources']:raise RuntimeError('Current primary evidence unavailable; item remains blocked-evidence')
   for attempt in [1,2]:
    if (run/'responses'/f"{job['key']}.{attempt}.json").exists() or (run/'invocations'/f"{job['key']}.{attempt}.launch.json").exists():continue
    launch=cmd(['hc','run','--bg','--no-notify','--name',f"rad-sonnet-{job['key'][:12]}-a{attempt}",'--parent',PARENT,'--cwd',str(WORK),'python3','-I',str(WORK/'scripts/radiator-sonnet-worker.py'),str(run),job['key'],'--attempt',str(attempt)],timeout=20)
    terminal=launch['address'];emit(run,{'stage':'worker-start','itemId':job['id'],'attempt':attempt,'terminalId':terminal,'model':'claude-sonnet-5-5'})
    waited=cmd(['hc','wait',terminal,'--timeout','250'],timeout=270)
    if not waited.get('ended'):
     info=cmd(['hc','get',terminal],timeout=15);assert info.get('parent')==PARENT
     cmd(['hc','kill',terminal],timeout=20);raise RuntimeError('Native worker lifecycle ceiling exceeded; stopped owned worker')
    failed=run/'invocations'/f"{job['key']}.{attempt}.failure.json"
    if waited.get('exit_code') not in [0,None] and not failed.exists():
     failed.parent.mkdir(mode=0o700,exist_ok=True)
     with failed.open('x') as f:json.dump({'itemId':job['id'],'source':job['source'],'attempt':attempt,'category':'worker-setup','error':'Native worker exited before recording a result','terminalId':terminal},f)
     os.chmod(failed,0o600)
    entry=current_entry(run,job['id']);emit(run,{'stage':'validated','itemId':job['id'],'attempt':attempt,'terminalId':terminal,'status':entry['status']})
    if entry['status']=='validated-awaiting-human-review':break
    if pause_reason(entry):
     stopped='Paused for '+pause_reason(entry)+'; no budget-expanding retry';raise RuntimeError(stopped)
    raw=run/'invocations'/f"{job['key']}.{attempt}.cli.json"
    failed=run/'invocations'/f"{job['key']}.{attempt}.failure.json"
    if failed.exists():
     failure=json.loads(failed.read_text())
     if failure.get('category') in ['provider-usage','provider-auth','model-route','resource-limit','worker-setup']:
      stopped='Paused for '+failure['category']+'; no model/transport fallback';raise RuntimeError(stopped)
     error_text=failed.read_text()
     if raw.exists():
      try:
       value=json.loads(raw.read_text())
       if value.get('is_error'):error_text+=' '+str(value.get('result',''))
      except json.JSONDecodeError:pass
     if re.search(r'quota|usage.?limit|rate.?limit|unauthorized|authentication|\b401\b|\b403\b|\b429\b|model mismatch',error_text,re.I):
      stopped='Provider/model/usage blocker; no fallback';raise RuntimeError(stopped)
   done+=1
  except Exception as exc:
   emit(run,{'stage':'item-error','itemId':job['id'],'error':str(exc),'priorSavedDataTouched':False});done+=1
   if stopped:break
  if done and done%10==0:
   state=make_bundle(run);subprocess.run(['hc','send',PARENT,f"Sonnet local progress: {done}/116 remaining items processed; counts {json.dumps(state['counts'])}; no production writes."],capture_output=True,text=True)
 state=make_bundle(run);summary={'stage':'batch-complete' if not stopped else 'batch-paused','remainingItemsProcessed':done,'remainingItemsTotal':116,'stoppedReason':stopped,'bundle':state}
 emit(run,summary)
 subprocess.run(['hc','send',PARENT,'Sonnet local batch finished/paused: '+json.dumps(summary)],capture_output=True,text=True)
if __name__=='__main__':main()
