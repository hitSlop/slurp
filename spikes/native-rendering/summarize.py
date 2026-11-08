#!/usr/bin/env python3
import json,pathlib,statistics,html,re
root=pathlib.Path(__file__).resolve().parents[2];out=root/'target/native-rendering-results'
rows=[]
for mode in ['baseline','patched','resvg2','resvg4','vl-resvg2']:
 directory=out/mode
 if not (directory/'measurements.json').exists():continue
 data=json.loads((directory/'measurements.json').read_text())
 checks=json.loads((directory/'checks.json').read_text())
 samples=[t for case in data['cases'] for t in case['render_ms'][1:]]
 rows.append({'mode':mode,'cases':len(data['cases']),'warm_composition_median_ms':round(statistics.median(samples),2),'chart_prepare_median_ms':round(statistics.median(c.get('chart_prepare_ms',0) for c in data['cases']),2),'checks':checks,'png_bytes':sum(f.stat().st_size for f in directory.glob('*.png')),'pdf_bytes':sum(f.stat().st_size for f in directory.glob('*.pdf'))})
for row in rows:
 mode=row['mode'];resource=out/(mode+'-resources.txt')
 if resource.exists():
  text=resource.read_text();match=re.search(r'(\d+)\s+maximum resident set size',text)
  if match:row['peak_rss_bytes']=int(match.group(1))
  else:
   match=re.search(r'Maximum resident set size \(kbytes\):\s*(\d+)',text)
   if match:row['peak_rss_bytes']=int(match.group(1))*1024
 files=[f.stat().st_size for f in (out/mode).glob('*.pdf') if f.name!='gallery.pdf']
 if files:row['median_chart_pdf_bytes']=statistics.median(files)
 if mode=='vl-resvg2' and (out/'vl-svg/timings.json').exists():
  conversions=json.loads((out/'vl-svg/timings.json').read_text())
  row['compiler_median_ms']=round(statistics.median(c['compile_ms'] for c in conversions if not c['case'].startswith('font-probe')),2)
 else:
  conversions=json.loads((out/mode/'measurements.json').read_text())['cases']
  row['compiler_median_ms']=round(statistics.median(c['compile_ms'] for c in conversions),2)
(out/'summary.json').write_text(json.dumps(rows,indent=2))
parts=['<!doctype html><meta charset="utf-8"><title>Native renderer comparison</title><style>body{font:16px system-ui;margin:24px;background:#eee}article{background:white;padding:16px;margin:20px 0}img{max-width:100%;height:auto}section{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}</style><h1>Native renderer comparison</h1><p>Experimental outputs. Compare complete marks, labels, legends, and PDF files before selecting an architecture.</p><pre>'+html.escape(json.dumps(rows,indent=2))+'</pre>']
files=sorted({f.name for row in rows for f in (out/row['mode']).glob('*.png') if f.name!='gallery.png'})
for file in files:
 parts.append('<h2>'+html.escape(file)+'</h2><section>')
 for row in rows:
  mode=row['mode'];png=out/mode/file
  if png.exists():parts.append(f'<article><b>{mode}</b> <a href="{mode}/{file[:-4]}.pdf">PDF</a><br><img loading="lazy" src="{mode}/{file}"></article>')
 parts.append('</section>')
(out/'comparison.html').write_text(''.join(parts))
print(json.dumps(rows,indent=2))
