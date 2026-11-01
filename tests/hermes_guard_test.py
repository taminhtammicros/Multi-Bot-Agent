"""Run with python3 -m unittest discover -s tests -p '*_test.py'. No Hermes runtime needed."""
import importlib.util, json, tempfile, time, unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('zhub_guard',Path(__file__).resolve().parents[1]/'integrations/hermes-guard/__init__.py')
guard=importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)

class GuardTests(unittest.TestCase):
    def test_off_blocks_terminal_and_code_and_delegate(self):
        for tool in ['terminal','execute_code','delegate_task','write_file']:
            self.assertEqual(guard.evaluate({'systemCommands':False},tool,{'command':'echo test'})['action'],'block')
        self.assertIsNone(guard.evaluate({'systemCommands':False},'web_search',{}))

    def test_denylist_blocks_normalized_and_shell_bypasses(self):
        p={'systemCommands':True,'denied':['cat /private','rm -rf']}
        for command in ['cat   /private/key','rm "-rf" tmp','sh -c "echo test"','echo x; whoami','echo $(whoami)','python3 -c print(1)','rg --pre=sh x','rg --hostname-bin=sh x','/tmp/ls']:
            self.assertEqual(guard.evaluate(p,'terminal',{'command':command})['action'],'block',command)
        allowed=guard.evaluate(p,'terminal',{'command':'ls -la'})
        self.assertEqual(allowed['action'],'modify')
        self.assertIn(allowed['args']['command'],['/usr/bin/ls -la','/bin/ls -la'])

    def test_ordinary_sessions_are_unaffected(self):
        self.assertIsNone(guard.pre_tool_call('terminal',{'command':'echo test'},'ordinary'))
        self.assertIsNone(guard.evaluate({'systemCommands':True,'denied':[]},'terminal',{'command':'echo test'}))

    def test_hook_fetches_live_policy_for_every_tool_and_fails_closed(self):
        sid='zhub_'+'a'*32
        class Reply:
            def __init__(self,p): self.p=p
            def __enter__(self): return self
            def __exit__(self,*args): pass
            def read(self,n): return json.dumps(self.p).encode()
        with tempfile.TemporaryDirectory() as folder:
            guard.ROOT=Path(folder)
            (guard.ROOT/(sid+'.json')).write_text(json.dumps({'scope':'b'*64,'expires':time.time()+60,'policyUrl':'http://127.0.0.1/policy','token':'private'}))
            with patch.object(guard.urllib.request,'urlopen',return_value=Reply({'systemCommands':True,'denied':[]})) as fetch:
                self.assertIsNone(guard.pre_tool_call('terminal',{'command':'echo test'},sid))
                self.assertEqual(fetch.call_count,1)
            with patch.object(guard.urllib.request,'urlopen',return_value=Reply({'systemCommands':False})):
                self.assertEqual(guard.pre_tool_call('terminal',{'command':'echo test'},sid)['action'],'block')
            with patch.object(guard.urllib.request,'urlopen',side_effect=OSError('offline')):
                self.assertEqual(guard.pre_tool_call('terminal',{},sid)['action'],'block')
            self.assertEqual(guard.pre_tool_call('terminal',{},'zhub_bad')['action'],'block')

if __name__=='__main__': unittest.main()
