import fs from 'node:fs'
import * as Y from 'yjs'
import WS from 'ws'
import { Provider } from '../src/provider.js'
import { Workbook, FIRST_SHEET } from '../src/sheet/model.js'
const BASE='http://127.0.0.1:8485'
let cookie=''
globalThis.WebSocket=class extends WS{constructor(u){super(u,{headers:{cookie}})}}
async function api(p,o={}){const r=await fetch(BASE+p,{...o,headers:{...(o.headers||{}),cookie}});const sc=r.headers.get('set-cookie');if(sc)cookie=sc.split(';')[0];if(!r.ok)throw new Error(p+': '+r.status+await r.text());return r}
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms))
const email=`runner-${Date.now()}@test.local`
await api('/api/signup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,name:'Runner',password:'password123'})})
const doc=await(await api('/api/docs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'runner test',kind:'sheet'})})).json()
const d=new Y.Doc(), wb=new Workbook(d)
const p=new Provider(d,doc.id,{wsUrl:`ws://127.0.0.1:8485/ws/${doc.id}`,onSynced:()=>(p.synced=true)})
for(let i=0;i<100 && !p.synced;i++) await sleep(50)
const m=wb.sheet(FIRST_SHEET)
m.setCell(0,0,'File'); m.setCell(0,2,'Size')
m.setCell(1,0,'a.iso'); m.setCell(1,2,'2048')
m.setCell(2,0,'b.tar'); m.setCell(2,2,'1048576')
m.setCell(3,0,'c.log'); m.setCell(3,2,'0.5')
wb.addScript('Convert sizes', fs.readFileSync(process.argv[2],'utf8'))
await sleep(1500)
p.destroy()
console.log(JSON.stringify({docId:doc.id,email}))
