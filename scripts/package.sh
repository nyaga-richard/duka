#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Source archives NEVER contain databases, uploads, backups, runtime secrets or .git.
python3 - <<'PY'
from pathlib import Path
import subprocess,json,hashlib,zipfile,datetime,re,os
root=Path.cwd()
status=subprocess.check_output(['git','status','--porcelain'],text=True)
if status.strip() and os.environ.get('ALLOW_DIRTY_RELEASE')!='1':
 raise SystemExit('Refusing a dirty source release. Commit a verified checkpoint first, or explicitly set ALLOW_DIRTY_RELEASE=1 for a non-release diagnostic archive.')
commit=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()
version=json.loads((root/'package.json').read_text())['version']
if not re.fullmatch(r'[0-9A-Za-z.+_-]+',version):raise SystemExit('Unsafe package version')
files=subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard','-z']).decode().split('\0')
blocked={'.git','.cache','.npm','.local','.config','node_modules','.next','artifacts','backups','uploads','secrets','release'}
manifest={}
for name in sorted(set(filter(None,files))):
 p=Path(name)
 allowed_dirs={'apps','packages','scripts','tests','database','docs','deploy','.github'}
 allowed_root={'README.md','package.json','package-lock.json','tsconfig.json','playwright.config.ts','.gitignore','.gitattributes','.dockerignore','.prettierignore','.prettierrc','.prettierrc.json','.nvmrc','.node-version','.env.example','security-audit.json','LICENSE','LICENSE.md'}
 if (len(p.parts)>1 and p.parts[0] not in allowed_dirs) or (len(p.parts)==1 and name not in allowed_root):continue
 if p.is_absolute() or '..' in p.parts or any(part in blocked for part in p.parts):continue
 if any(part.startswith('.env') and part!='.env.example' for part in p.parts):continue
 if p.name in {'.npmrc','.netrc','.git-credentials'} or p.suffix in {'.pem','.key','.enc','.dump','.log'}:continue
 f=root/p
 if not f.is_file() or f.is_symlink():continue
 manifest[name]=hashlib.sha256(f.read_bytes()).hexdigest()
output=root/'release';output.mkdir(exist_ok=True)
archive=output/f'duka-business-os-{version}-{commit[:12]}.zip'
if archive.exists():raise SystemExit('Refusing to overwrite an existing checkpoint archive')
with zipfile.ZipFile(archive,'x',zipfile.ZIP_DEFLATED,compresslevel=9) as z:
 for name in manifest:z.write(root/name,'duka-business-os/'+name)
 z.writestr('duka-business-os/SOURCE_MANIFEST.json',json.dumps({'version':version,'git_commit':commit,'dirty':bool(status.strip()),'created_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'files':manifest},indent=2))
digest=hashlib.sha256(archive.read_bytes()).hexdigest()
Path(str(archive)+'.sha256').write_text(f'{digest}  {archive.name}\n')
print(json.dumps({'file':str(archive),'sha256':digest,'source_files':len(manifest),'git_commit':commit,'production_approval':False},indent=2))
PY
