"""Guard only zhub_ sessions. Never touches ordinary Hermes sessions."""
import json, os, re, shlex, time, urllib.request
from pathlib import Path
ROOT = None
READONLY = {'web_search','web_extract','read_file','file_read','search_files','list_directory','skills_list','skills_view','memory','todo','clarify','image_analyze'}
SAFE_COMMANDS = {'ls','pwd','cat','head','tail','wc','rg','grep','date','uptime','uname','whoami','df','du','echo','printf'}
def blocked(message):
    return {'action':'block','message':'Zalo Hub policy: '+message}
def evaluate(policy, tool_name, args):
    if policy.get('systemCommands',False) and not policy.get('denied'): return None
    name=str(tool_name).lower()
    if name in READONLY:
        return None
    if name not in {'terminal','terminal_tool','shell','execute_command'}:
        return blocked('Công cụ này không được phép trong phiên có chính sách lệnh hạn chế.')
    if not policy.get('systemCommands',False):
        return blocked('Nhóm/DM này đã tắt thực thi lệnh hệ thống.')
    command=str((args or {}).get('command') or (args or {}).get('cmd') or '')
    try: tokens=shlex.split(command)
    except ValueError: return blocked('Không phân tích được lệnh.')
    flat=' '.join(tokens).casefold()
    for entry in policy.get('denied',[]):
        try: needle=' '.join(shlex.split(str(entry))).casefold()
        except ValueError: needle=str(entry).strip().casefold()
        if needle and needle in flat: return blocked('Lệnh nằm trong danh sách cấm của hội thoại.')
    if policy.get('denied'):
        # Blacklist mode accepts only simple, direct, read-only commands; no shell/script bypass.
        if not tokens or Path(tokens[0]).name not in SAFE_COMMANDS or re.search(r'[;&|`\n\r<>]|\$\(',command):
            return blocked('Chế độ lệnh cấm chỉ hỗ trợ lệnh đọc trực tiếp; không chạy script, chuỗi shell hoặc chương trình trung gian.')
        if any(t in {'--pre','--pre-glob','--hostname-bin','-e','--eval'} or t.startswith(('--pre=','--pre-glob=','--hostname-bin=','--eval=')) for t in tokens):
            return blocked('Tham số có thể chạy chương trình khác không được phép.')
        # Pin executables instead of trusting PATH, aliases or a supplied /tmp/ls.
        name=Path(tokens[0]).name
        binary=next((Path(root)/name for root in ['/usr/bin','/bin','/opt/homebrew/bin','/usr/local/bin'] if (Path(root)/name).is_file()),None)
        if binary is None or ('/' in tokens[0] and Path(tokens[0]).resolve()!=binary.resolve()):
            return blocked('Chỉ dùng chương trình đọc đã được xác định trong thư mục công cụ tin cậy.')
        field='command' if 'command' in (args or {}) else 'cmd'
        return {'action':'modify','args':{**(args or {}),field:shlex.join([str(binary),*tokens[1:]])}}
    return None

def pre_tool_call(tool_name='', args=None, session_id='', **kwargs):
    if not str(session_id).startswith('zhub_'): return None
    try:
        if not re.fullmatch(r'zhub_[a-f0-9]{32}',str(session_id)): return blocked('Session không hợp lệ.')
        request=json.loads((ROOT/(str(session_id)+'.json')).read_text())
        if request.get('expires',0)<time.time() or not re.fullmatch(r'[a-f0-9]{64}',request.get('scope','')): return blocked('Chính sách đã hết hạn.')
        req=urllib.request.Request(request['policyUrl'],headers={'Authorization':'Bearer '+request['token']})
        with urllib.request.urlopen(req,timeout=3) as response:
            policy=json.loads(response.read(16384))
        return evaluate(policy,tool_name,args)
    except Exception:
        return blocked('Không đọc được chính sách. Công cụ bị chặn để tránh thực thi ngoài quyền.')

def register(ctx):
    global ROOT
    config=json.loads((Path(__file__).parent/'connection.json').read_text())
    ROOT=Path(config['policyDir']).resolve()
    ROOT.mkdir(parents=True,exist_ok=True)
    ctx.register_hook('pre_tool_call',pre_tool_call)
    tmp=ROOT/('ready-'+str(os.getpid())+'.tmp')
    tmp.write_text(json.dumps({'version':1,'pid':os.getpid(),'policyDir':str(ROOT)}))
    os.chmod(tmp,0o600)
    tmp.replace(ROOT/'hermes-ready.json')
