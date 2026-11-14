import importlib.util,json,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
sys.dont_write_bytecode=True
p=Path(__file__).with_name('radiator-run-local.py');spec=importlib.util.spec_from_file_location('batch',p);batch=importlib.util.module_from_spec(spec);spec.loader.exec_module(batch)
class BatchTest(unittest.TestCase):
 def test_portable_checkout_node_and_actual_native_parent(self):
  with patch.dict(batch.os.environ,{'RADIATOR_NODE_COMMAND':'fixture-node','HC_TERMINAL_ID':'fixture-parent'},clear=True):
   spec=importlib.util.spec_from_file_location('configured_batch',p);configured=importlib.util.module_from_spec(spec);spec.loader.exec_module(configured)
  self.assertEqual(configured.ROOT,p.resolve().parent.parent);self.assertEqual(configured.NODE,'fixture-node');self.assertEqual(configured.PARENT,'fixture-parent')
  with patch.object(batch,'PARENT',None):
   with self.assertRaisesRegex(AssertionError,'verified native Herdr'):batch.main()
 def test_every_selected_failure_is_counted_without_model_or_network(self):
  with tempfile.TemporaryDirectory(prefix='board-batch-fixture-') as t:
   r=Path(t);jobs=[{'id':str(i),'key':str(i),'source':'https://fixture.invalid/'} for i in range(119)]
   (r/'run.json').write_text(json.dumps({'selection':{'boardId':'radiator-9k51'},'jobs':jobs,'fixture':False}))
   (r/'pilot-quality-review.json').write_text(json.dumps({'continueLocalBatch':True,'productionApproved':False}))
   (r/'pilot-selection.json').write_text(json.dumps({'jobs':[{'itemId':str(i)} for i in range(3)]}))
   bundlefile=r/'bundle.json';bundlefile.write_text(json.dumps({'entries':[{'id':str(i),'status':'blocked-evidence'} for i in range(119)]}))
   def fake(argv,**kw):
    self.assertNotEqual(argv[0],'hc') # No analysis worker may launch without evidence.
    if 'radiator-sources.mjs' in ' '.join(argv):return {'sources':0,'errors':[{'error':'Fixture missing evidence'}]}
    return {'file':str(bundlefile),'counts':{'blocked-evidence':119}}
   with patch.object(batch,'PARENT','fixture-parent'),patch.object(batch,'cmd',side_effect=fake),patch.object(batch.subprocess,'run'),patch.object(batch,'emit') as emitted,patch.object(sys,'argv',['batch',str(r)]):batch.main()
   final=emitted.call_args.args[1];self.assertEqual(final['remainingItemsProcessed'],116);self.assertEqual(final['stage'],'batch-complete')
   self.assertEqual(sum(c.args[1]['stage']=='item-error' for c in emitted.call_args_list),116)
   data=json.loads(bundlefile.read_text());data['entries'][3]={'id':'3','status':'invalid-output','errors':[{'error':'Token usage over finite ceiling'}]};bundlefile.write_text(json.dumps(data))
   def paused(argv,**kw):
    self.assertNotIn('radiator-sources.mjs',' '.join(argv));self.assertNotEqual(argv[0],'hc')
    return {'file':str(bundlefile),'counts':{'invalid-output':1,'blocked-evidence':118}}
   with patch.object(batch,'PARENT','fixture-parent'),patch.object(batch,'cmd',side_effect=paused),patch.object(batch.subprocess,'run'),patch.object(batch,'emit') as emitted,patch.object(sys,'argv',['batch',str(r)]):batch.main()
   final=emitted.call_args.args[1];self.assertEqual(final['stage'],'batch-paused');self.assertEqual(final['remainingItemsProcessed'],0)
if __name__=='__main__':unittest.main()
