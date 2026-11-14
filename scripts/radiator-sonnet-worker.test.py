import contextlib,importlib.util,io,json,subprocess,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
sys.dont_write_bytecode=True
p=Path(__file__).with_name('radiator-sonnet-worker.py');spec=importlib.util.spec_from_file_location('worker',p);worker=importlib.util.module_from_spec(spec);spec.loader.exec_module(worker)
class WorkerTest(unittest.TestCase):
 def test_existing_cli_model_output_binding_and_no_sdk(self):
  with tempfile.TemporaryDirectory(prefix='board-cli-fixture-') as t:
   r=Path(t)
   for d in ['evidence','responses','receipts']:(r/d).mkdir()
   key='a'*64;job={'id':'fixture','source':'https://fixture.invalid/','key':key,'runKey':'fixture-run'}
   data={'run.json':{'jobs':[job]},'analysis-schema.json':{'enrichment_prompt':'Fixture only','fields':[{'key':'intel_v1.subject','type':'text','enrichable':True}]},'radiator-baseline.json':{'summary':'Fixture only','sources':[]},f'evidence/{key}.json':{'itemId':'fixture','source':job['source'],'sources':[{'id':'T1','text':'Fixture evidence only'}]}}
   for name,v in data.items():(r/name).write_text(json.dumps(v))
   settings_path=r/'trusted-settings.json';settings_path.write_text(json.dumps({'env':{'FIXTURE_LOCAL_SETTING':'private-fixture-value'},'apiKeyHelper':'fixture-helper','pluginConfigs':{'jev-model-router':{'options':{'enabled':True,'custom':1}}},'enabledPlugins':{'jev-model-router':True}}))
   settings_paths=[]
   response={'itemId':'fixture','source':job['source'],'fields':{'intel_v1.subject':'Fixture only'}}
   class Process:
    returncode=0
    def __init__(self,command,**kw):
     self.stdout=kw['stdout'];self.pid=1
     assert command[0]=='fixture-cli' and '--model' in command and worker.MODEL in command
     local=Path(command[command.index('--settings')+1]);settings_paths.append(local);config=json.loads(local.read_text())
     assert local.stat().st_mode & 0o777==0o600 and local.parent.stat().st_mode & 0o777==0o700
     assert config['env']['FIXTURE_LOCAL_SETTING']=='private-fixture-value' and config['disableAllHooks'] is True
     assert config['pluginConfigs']['jev-model-router']['options']['custom']==1
     for name in ['jev-model-router','jev-model-router@inline']:
      assert config['enabledPlugins'][name] is False
      assert all(config['pluginConfigs'][name]['options'][key] is False for key in ['enabled','routeMainModel','routeMainEffort','routeSubagentModel','classifyTurns'])
     assert 'private-fixture-value' not in ' '.join(command) and 'fixture-helper' not in ' '.join(command)
     assert kw['cwd']==str(local.parent) and kw['shell'] is False and kw['start_new_session'] is True
     assert '--no-session-persistence' in command and '--strict-mcp-config' in command
     assert json.loads(command[command.index('--mcp-config')+1])=={'mcpServers':{}}
     assert '--json-schema' not in command # Avoid CLI's extra structured regeneration.
     assert command[command.index('--tools')+1]==''
     assert callable(kw['preexec_fn'])
    def communicate(self,content,timeout):
     assert timeout==240 and b'INPUT DATA' in content
     json.dump({'result':json.dumps(response),'modelUsage':{worker.MODEL:{}},'usage':{'input_tokens':200,'output_tokens':100},'session_id':'fixture-session'},self.stdout);self.stdout.flush()
   output=io.StringIO()
   with contextlib.redirect_stdout(output),patch.object(worker.subprocess,'Popen',Process),patch.object(sys,'argv',['worker',str(r),key,'--command','fixture-cli','--settings-file',str(settings_path)]):worker.main()
   self.assertNotIn('private-fixture-value',output.getvalue());self.assertTrue(settings_paths);self.assertFalse(settings_paths[0].exists())
   receipt=json.loads((r/'receipts'/f'{key}.1.json').read_text())
   self.assertEqual(receipt['responseSha256'],worker.digest(response));self.assertEqual(receipt['effectiveModelsAsReported'],[worker.MODEL]);self.assertFalse((r/'worker.lock').exists());self.assertTrue(receipt['effectivePromptSha256']);self.assertEqual(json.loads(Path(receipt['effectivePromptFile']).read_text())['sha256'],receipt['effectivePromptSha256'])
 def test_settings_are_optional_bounded_objects_without_route_defaults(self):
  default=worker.cli_settings();self.assertNotIn('env',default);self.assertNotIn('apiKeyHelper',default)
  with tempfile.TemporaryDirectory(prefix='board-settings-fixture-') as t:
   source=Path(t)/'settings.json'
   for value in ['[]','{','x'*65537]:
    source.write_text(value)
    with self.assertRaisesRegex(ValueError,'Invalid local CLI settings file'):worker.cli_settings(source)
   with self.assertRaisesRegex(ValueError,'Invalid local CLI settings file'):worker.cli_settings(Path(t)/'missing.json')
   source.write_text(json.dumps({'pluginConfigs':[],'enabledPlugins':[],'env':{'FIXTURE':'kept'}}))
   value=worker.cli_settings(source);self.assertEqual(value['env'],{'FIXTURE':'kept'});self.assertFalse(value['enabledPlugins']['jev-model-router'])
 def test_provider_categories_and_live_os_file_bound(self):
  self.assertEqual(worker.failure_category('CLI exited1','Quota exhausted, retry later'),'provider-usage')
  self.assertEqual(worker.failure_category('CLI exited1','Authentication failed401'),'provider-auth')
  with tempfile.TemporaryDirectory(prefix='board-limit-fixture-') as t:
   output=Path(t)/'bounded.txt'
   with output.open('w') as f:
    child=subprocess.run([sys.executable,'-I','-c','import sys;sys.stdout.write("x"*(3*1024*1024));sys.stdout.flush()'],stdout=f,stderr=subprocess.DEVNULL,preexec_fn=worker.bound_output_files,timeout=10)
   self.assertNotEqual(child.returncode,0);self.assertLessEqual(output.stat().st_size,2*1024*1024)
 def test_preflight_failure_is_recorded_without_lock_or_cli(self):
  with tempfile.TemporaryDirectory(prefix='board-setup-fixture-') as t:
   r=Path(t);key='b'*64;job={'id':'fixture','source':'https://fixture.invalid/','key':key,'runKey':'fixture-run'}
   for d in ['evidence','responses','receipts']:(r/d).mkdir()
   data={'run.json':{'jobs':[job]},'analysis-schema.json':{'enrichment_prompt':'x'*110000,'fields':[]},'radiator-baseline.json':{'summary':'Fixture'},f'evidence/{key}.json':{'itemId':'fixture','source':job['source'],'sources':[{'id':'T1','text':'Fixture only'}]}}
   for name,value in data.items():(r/name).write_text(json.dumps(value))
   with patch.object(worker.subprocess,'Popen') as process,patch.object(sys,'argv',['worker',str(r),key]):
    self.assertEqual(worker.entry(),1);process.assert_not_called()
   self.assertFalse((r/'worker.lock').exists());failure=json.loads((r/'invocations'/f'{key}.1.failure.json').read_text());self.assertEqual(failure['category'],'worker-setup')
if __name__=='__main__':unittest.main()
