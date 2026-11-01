"""Pin an operational context cap for custom model aliases that lack metadata.
Run using Hermes' Python environment (PyYAML required). No model/key is changed.
"""
import argparse, datetime, json, os, tempfile
from pathlib import Path
import yaml

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--model', action='append', help='Exact alias; default is configured custom model')
parser.add_argument('--context-window', type=int, default=65536)
args = parser.parse_args()
if not 32768 <= args.context_window <= 1048576:
    parser.error('context-window must be between 32768 and 1048576')
config_path = Path.home()/'.hermes/config.yaml'
original = config_path.read_bytes()
config = yaml.safe_load(original)
if config.get('model', {}).get('provider') != 'custom':
    raise SystemExit('Expected custom provider; no changes made')
models = args.model or [config['model']['default']]
overrides = config.setdefault('model_overrides', {}).setdefault('custom', {})
for model in models:
    if not isinstance(model, str) or not model.strip(): raise SystemExit('Invalid alias')
    overrides.setdefault(model, {})['context_window'] = args.context_window
backups = Path('data/hermes-config-backups')
backups.mkdir(parents=True, exist_ok=True, mode=0o700)
backup = backups/(datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%f')+'.yaml')
fd = os.open(backup, os.O_WRONLY|os.O_CREAT|os.O_EXCL, 0o600)
with os.fdopen(fd,'wb') as out: out.write(original)
fd, tmp = tempfile.mkstemp(prefix='zhub-context-', dir=config_path.parent)
try:
    with os.fdopen(fd,'w') as out: yaml.safe_dump(config,out,allow_unicode=True,sort_keys=False)
    if config_path.read_bytes() != original: raise RuntimeError('Config changed concurrently; refusing overwrite')
    os.replace(tmp, config_path)
finally:
    Path(tmp).unlink(missing_ok=True)
print(json.dumps({'models':models,'context_window':args.context_window,'backup':str(backup)}))
