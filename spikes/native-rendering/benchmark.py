#!/usr/bin/env python3
"""Rerun completed hosts without compiling; records per-process resources."""
import os,pathlib,subprocess,sys
root=pathlib.Path(__file__).resolve().parents[2];out=root/'target/native-rendering-results'
flag='-l' if sys.platform=='darwin' else '-v'
for mode,host in [('baseline','baseline-host'),('patched','patched-host'),('resvg2','baseline-host'),('resvg4','baseline-host')]:
 with (out/(mode+'-resources.txt')).open('w') as log:
  subprocess.run(['/usr/bin/time',flag,str(out/host),mode,str(out/mode)],check=True,cwd=root,stderr=log)
vl=root/'target/vl-spike/release/vl-spike-host'
with (out/'vl-resources.txt').open('w') as log:
 subprocess.run(['/usr/bin/time',flag,str(vl),str(out/'prepared'),str(out/'vl-svg'),str(root/'crates/slurp-render/assets')],check=True,cwd=root,stderr=log)
env=dict(os.environ,SPIKE_SVG_DIR=str(out/'vl-svg'))
with (out/'vl-resvg2-resources.txt').open('w') as log:
 subprocess.run(['/usr/bin/time',flag,str(out/'baseline-host'),'resvg2',str(out/'vl-resvg2')],check=True,cwd=root,env=env,stderr=log)
subprocess.run([sys.executable,str(root/'spikes/native-rendering/summarize.py')],check=True,cwd=root)
