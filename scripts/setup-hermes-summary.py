"""Create an isolated, API-only Hermes synthesis service. Run with Hermes' Python."""
import copy, json, os, plistlib, re, secrets, subprocess
from pathlib import Path
import yaml
from dotenv import dotenv_values
root=Path.cwd()/'data/hermes-summary'
root.mkdir(parents=True,exist_ok=True,mode=0o700)
for folder in ['skills','plugins','workspace','logs']:(root/folder).mkdir(exist_ok=True,mode=0o700)
source=Path.home()/'.hermes'
config=yaml.safe_load((source/'config.yaml').read_text())
model=copy.deepcopy(config['model'])
if model.get('provider')!='custom': raise SystemExit('Setup currently requires the configured custom provider; no main config changed.')
source_env=dotenv_values(source/'.env')
profile_env=dotenv_values(root/'.env') if (root/'.env').exists() else {}
token=profile_env.get('API_SERVER_KEY') or secrets.token_hex(32)
env={'API_SERVER_KEY':token,'API_SERVER_PORT':'8643','API_SERVER_HOST':'127.0.0.1','API_SERVER_MODEL_NAME':'hermes-synthesis'}
ref=re.fullmatch(r'\$\{([^}]+)\}',str(model.get('api_key','')))
if ref:
    key=ref.group(1)
    if not source_env.get(key): raise SystemExit('Configured provider credential is unavailable.')
    env[key]=source_env[key]
model['context_length']=65536
summary={
    'model':model,
    'model_overrides':copy.deepcopy(config.get('model_overrides',{})),
    'custom_providers':copy.deepcopy(config.get('custom_providers',[])),
    'agent':{'max_turns':2,'reasoning_effort':'low'},
    'platform_toolsets':{'api_server':[]},'mcp_servers':{},
    'memory':{'memory_enabled':False,'user_profile_enabled':False},
    'auxiliary':{'title_generation':{'enabled':False},'background_review':{'enabled':False}},
    'gateway':{'multiplex_profiles':False},
}
for provider in summary['custom_providers']:
    key=provider.get('key_env')
    if key and source_env.get(key):env[key]=source_env[key]
def private(path,content):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
    with os.fdopen(fd,'w') as out: out.write(content)
private(root/'config.yaml',yaml.safe_dump(summary,allow_unicode=True,sort_keys=False))
private(root/'.env',''.join(k+'='+json.dumps(v)+'\n' for k,v in env.items()))
private(root/'SOUL.md','You are Hermes synthesis. Organize only supplied evidence. No tools, independent research, code execution or delegation. Preserve uncertainty and source URLs.\n')
private(root/'endpoint.json',json.dumps({'baseUrl':'http://127.0.0.1:8643/v1','model':'hermes-synthesis','mainAlias':source_env.get('API_SERVER_MODEL_NAME') or 'hermes-agent'}))
label='com.zalo-agent-hub.hermes-summary'
plist=Path.home()/'Library/LaunchAgents'/f'{label}.plist'
for file in ['gateway.log','gateway.error.log']:
    with open(root/'logs'/file,'a'):pass
    os.chmod(root/'logs'/file,0o600)
job={'Label':label,'ProgramArguments':[str(source/'hermes-agent/venv/bin/python'),str(source/'hermes-agent/hermes'),'gateway','run'],
     'WorkingDirectory':str(root/'workspace'),'EnvironmentVariables':{'HERMES_HOME':str(root),'PATH':'/Users/MacBook/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin'},
     'RunAtLoad':True,'KeepAlive':True,'ThrottleInterval':10,'StandardOutPath':str(root/'logs/gateway.log'),'StandardErrorPath':str(root/'logs/gateway.error.log')}
private(plist,plistlib.dumps(job).decode())
domain='gui/'+str(os.getuid())
loaded=subprocess.run(['launchctl','print',domain+'/'+label],capture_output=True).returncode==0
if not loaded:subprocess.run(['launchctl','bootstrap',domain,str(plist)],check=True,capture_output=True)
print(json.dumps({'service':label,'baseUrl':'http://127.0.0.1:8643/v1','tools':[],'mainProfileChanged':False}))
