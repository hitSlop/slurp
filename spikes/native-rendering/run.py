#!/usr/bin/env python3
"""Build and run isolated native candidates; no production source is modified."""
import os,pathlib,subprocess,shutil,glob,hashlib,sys
root=pathlib.Path(__file__).resolve().parents[2]
spike=root/'spikes/native-rendering';out=root/'target/native-rendering-results';out.mkdir(parents=True,exist_ok=True)
env=dict(os.environ,PATH='/usr/bin:/bin:/usr/sbin:/sbin:'+os.environ['PATH'],CARGO_TARGET_DIR=str(root/'target/render-spike'))
time_flag='-l' if sys.platform=='darwin' else '-v'
node=shutil.which('node',path=env['PATH'])
if not node:raise RuntimeError('Node is required to prepare shared chart fixtures')
def run(args,**kw):subprocess.run(list(map(str,args)),cwd=root,env=env,check=True,**kw)
run(['cargo','build','--release','--locked','--manifest-path',spike/'Cargo.toml'])
binary=root/'target/render-spike/release/native-rendering-spike'
shutil.copy2(binary,out/'baseline-host')
for mode in ['baseline','resvg2','resvg4']:
 with (out/(mode+'-resources.txt')).open('w') as log:run(['/usr/bin/time',time_flag,out/'baseline-host',mode,out/mode],stderr=log)
registry=pathlib.Path(glob.glob(os.path.expanduser('~/.cargo/registry/src/*/takumi-core-0.35.0'))[0])
vendor=out/'takumi-core'
stamp=out/'takumi-patch.sha256';digest=hashlib.sha256((spike/'takumi-dpr.patch').read_bytes()).hexdigest()
if not stamp.exists() or stamp.read_text()!=digest:
 shutil.copytree(registry,vendor,dirs_exist_ok=True)
 run(['/usr/bin/patch','-p1','-d',vendor,'-i',spike/'takumi-dpr.patch'])
 stamp.write_text(digest)
lock=spike/'Cargo.lock';original_lock=lock.read_bytes()
try:
 run(['cargo','build','--release','--offline','--manifest-path',spike/'Cargo.toml','--config',f'patch.crates-io.takumi-core.path="{vendor}"'])
finally:
 lock.write_bytes(original_lock)
shutil.copy2(binary,out/'patched-host');
with (out/'patched-resources.txt').open('w') as log:run(['/usr/bin/time',time_flag,out/'patched-host','patched',out/'patched'],stderr=log)
run([node,spike/'prepare.mjs',out/'prepared'])
print('Results:',out)

vl_env=dict(env,CARGO_TARGET_DIR=str(root/'target/vl-spike'))
subprocess.run(['cargo','build','--release','--locked','--manifest-path',str(spike/'vl-host/Cargo.toml')],cwd=root,env=vl_env,check=True)
vl_binary=root/'target/vl-spike/release/vl-spike-host'
with (out/'vl-resources.txt').open('w') as log:run(['/usr/bin/time',time_flag,vl_binary,out/'prepared',out/'vl-svg',root/'crates/slurp-render/assets'],stderr=log)
vl_env=dict(env,SPIKE_SVG_DIR=str(out/'vl-svg'))
subprocess.run([str(out/'baseline-host'),'resvg2',str(out/'vl-resvg2')],env=vl_env,cwd=root,check=True)

run([sys.executable,spike/'summarize.py'])
