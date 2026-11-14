#!/usr/bin/env python3
"""Build the Radiator-only configuration proposal; test only a new disposable database.
No production/API/HTTP/CLI-model access, existing DB option or migration application.
"""
import argparse,copy,hashlib,json,os,sqlite3,tempfile
from pathlib import Path
BASE=Path(__file__).resolve().parent.parent
BOARD='radiator-9k51'
def sha(value):return hashlib.sha256(json.dumps(value,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
def build(selected):
 assert selected['format']=='board-radiator-selected-export/1' and selected['board']['id']==BOARD
 assert selected['selection']['boardId']==BOARD and selected['board']['name']=='Radiator'
 before=copy.deepcopy(selected['board']);old=before['descriptor']
 schema=json.loads((BASE/'docs/radiator-intel-schema-v1.json').read_text());rules=json.loads((BASE/'docs/radiator-intel-execution-rules-v1.json').read_text())
 protected=[copy.deepcopy(f) for f in old['fields'] if f.get('enrichable') is not True or f['type'] in ['tags','image','url']]
 assert {f['key'] for f in protected}=={'url','screenshot','aesthetic_tags','tone','my_notes'}
 for field in protected:field['enrichable']=False
 ordered=sorted(copy.deepcopy(schema['fields']),key=lambda f: 0 if f['key']=='intel_v1.relevance' else 1 if f['key']=='intel_v1.rationale' else 2)
 descriptor={**old,**schema,'view':before['view'],'ingest_mode':old['ingest_mode'],'fields':ordered+protected,
  'enrichment_prompt':schema['enrichment_prompt']+'\n\nSHARED EXECUTION RULES ('+rules['version']+'):\n'+'\n'.join(rules['rules'])}
 assert len(descriptor['fields'])==22 and len({f['key'] for f in descriptor['fields']})==22
 assert descriptor.get('archive_on_promote')==old.get('archive_on_promote') and descriptor.get('empty_state')==old.get('empty_state')
 generated=[f['key'] for f in old['fields'] if f['key'] not in {p['key'] for p in protected}]
 stamps=[f['key'] for f in schema['fields'] if not f.get('enrichable')]
 return {'format':'board-radiator-future-config/1','scope':{'boardId':BOARD,'name':before['name'],'otherBoardMutationsAllowed':False},
  'sourceArchiveSha256':selected['provenance']['archiveSha256'],'expectedBoardSha256':sha(before),'beforeBoard':before,
  'boardReplacement':{**before,'descriptor':descriptor},'baseSchemaVersion':'radiator-intel/1','basePromptVersion':'radiator-intel/1.1',
  'executionRulesVersion':rules['version'],'executionRulesSha256':sha(rules),
  'fieldMapping':{'preserveSameKeys':[f['key'] for f in protected],'preserveSystemColumns':['id','board_id','source','title','notes','favorite','created_at'],
   'preserveAssets':'All existing screenshot/image/snapshot rows and files; no recapture or replacement during migration',
   'archiveAndRetireOnlyOnValidatedItemCommit':generated,'newAnalysisKeys':[f['key'] for f in schema['fields']],
   'doNotConvertOldDesignProseIntoProductFacts':True,'runnerOwnedReadOnlyKeys':stamps},
  'presentation':{'view':before['view'],'cardBadge':'intel_v1.relevance','cardLead':'intel_v1.rationale','title':'existing item.title',
   'link':'unchanged item.source','image':'existing screenshot asset','detail':'One active product-intelligence analysis, ordered descriptor fields; original manual notes preserved',
   'provenanceFooter':stamps,'sourceLinks':'Safe supplied source URLs only; current evidence text renderer does not make a multi-source bibliography clickable',
   'legacyFallback':'For blocked/unmigrated items only, retain the old active analysis using beforeBoard descriptor; no parallel visible legacy sections for successful items',
   'requiresUiIntegration':['Per-item committed-profile selection and legacy descriptor/history access','Read-only runner stamps in UI/API instead of ordinary manual editors','Explicit missing/disabled/failed analysis states in actual card/detail code','Preserve orthogonal descriptor flags through ordinary board editor saves']},
  'newLinkTargets':{'collectionUi':{'method':'POST','path':'/api/collections/'+BOARD+'/items','body':{'url':'<saved URL>'}},
   'tokenApi':{'method':'POST','path':'/api/v1/items','body':{'url':'<saved URL>','boardId':BOARD}},
   'omittedApiBoardId':'Inbox, intentionally NOT Radiator','share':'Always Inbox; assignment requires fresh research stage, not just current enrich-only promotion'},
  'intendedExecution':{'model':'claude-sonnet-5-5','transport':'Existing owner-confirmed Claude Code -> VibeProxy subscription',
   'scope':BOARD,'sdkOrNewApiKey':False,'apiFallbackAllowed':False,'globalProviderChangeAllowed':False,
   'research':'Reuse current primary-source collector/evidence caps, pinned canon, shared execution rules and strict complete-field validation used by local backfill',
   'provenance':'Caller stamps versions/dates/baseline/actual model+session and commits guarded per item; not model-written provenance'},
  'activation':{'productionApplied':False,'readyForCurrentBoardRuntime':False,'automaticFutureSaveProof':False,
   'missingCapabilities':['Per-board exact-model/provider dispatch instead of global HTTP-precedence provider','Current bounded vendor research and pinned canon in actual add/promote pipeline','Mandatory field/citation/unknown validation and caller-owned stamps','No model title overwrite and commit-time home/input/abort/generation guards','Per-item active/fallback presentation and protected stamp ownership','Native Node22 SQLite ABI and representative add-URL end-to-end verification'],
   'doNotActivateByPromptOnly':True,'productionApplicationRequiresSeparateApproval':True}}

def apply_to_new_fixture(conn,proposal):
 # Used only by disposable_test; CLI deliberately has no existing-database apply option.
 with conn:
  row=conn.execute('SELECT id,name,view,descriptor FROM board WHERE id=?',(BOARD,)).fetchone()
  assert row is not None
  current={'id':row[0],'name':row[1],'view':row[2],'descriptor':json.loads(row[3])}
  after=proposal['boardReplacement']
  if sha(current)==sha(after):return 'already-proposed-state'
  assert sha(current)==proposal['expectedBoardSha256'],'Expected board guard failed'
  conn.execute('UPDATE board SET descriptor=?,view=? WHERE id=?',(json.dumps(after['descriptor'],ensure_ascii=False),after['view'],BOARD))

def disposable_test(proposal):
 with tempfile.TemporaryDirectory(prefix='board-config-disposable-') as t:
  root=Path(t);conn=sqlite3.connect(root/'fixture.db');conn.execute('PRAGMA foreign_keys=ON')
  conn.executescript('CREATE TABLE board(id TEXT PRIMARY KEY,name TEXT,view TEXT,descriptor TEXT); CREATE TABLE item(id TEXT PRIMARY KEY,board_id TEXT REFERENCES board(id),source TEXT,title TEXT,notes TEXT,favorite INTEGER,fields TEXT); CREATE TABLE asset(id TEXT PRIMARY KEY,item_id TEXT REFERENCES item(id),kind TEXT,path TEXT,hash TEXT);')
  before=proposal['beforeBoard'];other={'id':'fixture-other','name':'Untouched fixture','view':'list','descriptor':{'fields':[],'view':'list','ingest_mode':'manual-upload','enrichment_prompt':'Fixture unchanged'}}
  for b in [before,other]:conn.execute('INSERT INTO board VALUES(?,?,?,?)',(b['id'],b['name'],b['view'],json.dumps(b['descriptor'],ensure_ascii=False)))
  conn.execute('INSERT INTO item VALUES(?,?,?,?,?,?,?)',('fixture-item',BOARD,'https://fixture.invalid/','Original title','Original notes',1,json.dumps({'url':'https://fixture.invalid/','screenshot':'fixture.png','aesthetic_tags':['keep'],'tone':['calm'],'my_notes':'Manual','steal_this':'Old analysis still present until item success'})))
  image=root/'fixture.png';image.write_bytes(b'fixture image bytes');image_hash=hashlib.sha256(image.read_bytes()).hexdigest();conn.execute('INSERT INTO asset VALUES(?,?,?,?,?)',('fixture-asset','fixture-item','screenshot',str(image),image_hash));conn.commit()
  items=list(conn.execute('SELECT * FROM item'));assets=list(conn.execute('SELECT * FROM asset'));other_row=conn.execute('SELECT * FROM board WHERE id=?',('fixture-other',)).fetchone()
  apply_to_new_fixture(conn,proposal)
  assert list(conn.execute('SELECT * FROM item'))==items and list(conn.execute('SELECT * FROM asset'))==assets
  assert conn.execute('SELECT * FROM board WHERE id=?',('fixture-other',)).fetchone()==other_row
  assert hashlib.sha256(image.read_bytes()).hexdigest()==image_hash
  assert json.loads(conn.execute('SELECT descriptor FROM board WHERE id=?',(BOARD,)).fetchone()[0])==proposal['boardReplacement']['descriptor']
  assert apply_to_new_fixture(conn,proposal)=='already-proposed-state'
  conn.execute('UPDATE board SET name=? WHERE id=?',('Fixture concurrent edit',BOARD));conn.commit()
  try:apply_to_new_fixture(conn,proposal)
  except AssertionError:pass
  else:raise AssertionError('Stale expected-board guard was not enforced')
  conn.close()
 return {'configurationOnly':True,'disposableSqlitePassed':True,'staleGuardRejected':True,'identicalConfigurationNoOp':True,'otherBoardItemsNotesTagsAssetsUnchanged':True,'actualBoardNewLinkModelE2E':False,'reason':'Not a Fastify/capture/provider test; current runtime capability gaps remain explicit'}

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('selected_export',type=Path);parser.add_argument('new_output_dir',type=Path);args=parser.parse_args()
 selected=json.loads(args.selected_export.read_text());proposal=build(selected);checks=disposable_test(proposal)
 args.new_output_dir.mkdir(mode=0o700)
 for name,value in [('radiator-board-configuration-proposal.json',proposal),('configuration-disposable-check.json',checks)]:
  p=args.new_output_dir/name
  with p.open('x') as f:json.dump(value,f,ensure_ascii=False,indent=2);f.write('\n')
  os.chmod(p,0o600)
 print(json.dumps({'output':str(args.new_output_dir),'boardId':BOARD,'descriptorFields':22,'checks':checks,'productionApplied':False},indent=2))
