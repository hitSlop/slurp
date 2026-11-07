#!/usr/bin/env python3
"""Compare describe on one generated customers CSV, isolated temp home/library, p50 of five."""
import csv, datetime, json, os, pathlib, statistics, subprocess, tempfile, time, argparse
p = argparse.ArgumentParser()
p.add_argument('binaries', nargs='+', type=pathlib.Path)
p.add_argument('--out', type=pathlib.Path)
a = p.parse_args()
with tempfile.TemporaryDirectory(prefix='slurp-describe-', dir='/tmp') as scratch:
    root = pathlib.Path(scratch)
    (root/'user-home').mkdir()
    env = dict(os.environ, HOME=str(root/'user-home'), SLURP_HOME=str(root/'home'), SLURP_LIBRARY=str(root/'library'))
    binaries = [b.resolve() for b in a.binaries]
    def call(binary, *args):
        return json.loads(subprocess.check_output([str(binary), *map(str,args)],env=env))
    path=root/'customers.csv'
    with path.open('w',newline='') as f:
        w=csv.writer(f)
        w.writerow(['Index','Customer Id','First Name','Last Name','Company','City','Country','Phone 1','Phone 2','Email','Subscription Date','Website'])
        for i in range(500_000):
            w.writerow([i+1,f'C{i:015x}',f'First{i%1000}',f'Last{i%2000}',f'Company {i%10000}',f'City {i%2000}',f'Country {i%243}',f'+1-555-{i:07}',f'+1-556-{i:07}',f'customer{i}@example.test',datetime.date(2023,1,1)+datetime.timedelta(days=i%880),f'https://company{i%10000}.test'])
    call(binaries[0],'library','set',root/'library','--create')
    call(binaries[0],'import',path,'--name','customers')
    measurements={'rows':500_000,'columns':12,'csv_bytes':path.stat().st_size,'trials':5,'binaries':{}}
    for b in binaries:
        measurements['binaries'][str(b)]={'bytes':b.stat().st_size}
    for mode in [[],['--profile']]:
        args=['describe','customers','-o','json',*mode]
        trials={b:[] for b in binaries}
        for b in binaries: call(b,*args)
        for i in range(5):
            for b in binaries if i % 2 == 0 else reversed(binaries):
                start=time.perf_counter()
                call(b,*args)
                ms=1000*(time.perf_counter()-start)
                trials[b].append(ms)
                print(f"{b.name} {'full' if mode else 'default'} {i+1}/5: {ms:.1f} ms",file=__import__('sys').stderr,flush=True)
        for b in binaries:
            measurements['binaries'][str(b)]['full' if mode else 'default']={'ms':trials[b],'median_ms':statistics.median(trials[b])}
    output=json.dumps(measurements,indent=2)+'\n'
    print(output,end='')
    if a.out: a.out.write_text(output)
