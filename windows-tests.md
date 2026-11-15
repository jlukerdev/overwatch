node -e "const fs=require('fs'),p=require('path');const o='scripts/perf/output';const d=fs.readdirSync(o).filter(n=>n.endsWith('-high')).sort().pop();const l=fs.readFileSync(p.join(o,d,'samples.jsonl'),'utf8').trim().split('\n').map(JSON.parse);console.log(d);l.filter((s,i)=>i%60==0||i==l.length-1).forEach(s=>console.log('t',s.t,'total',Math.round(s.rssTotalMb),'gpu',Math.round(s.rssMb.gpu),'renderer',Math.round(s.rssMb.renderer),'main',Math.round(s.rssMb.main)))"


2026-11-14T19-30-49Z-high
t 5 total 972 gpu 513 renderer 199 main 119
t 305 total 1614 gpu 1106 renderer 244 main 123
t 605 total 1655 gpu 1106 renderer 283 main 125
t 905 total 1684 gpu 1106 renderer 309 main 127
t 1205 total 1709 gpu 1106 renderer 333 main 129
t 1505 total 1625 gpu 1018 renderer 337 main 128
t 1800 total 1825 gpu 1203 renderer 351 main 129