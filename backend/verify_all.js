const BASE='http://localhost:4000/api'; let T='';
async function api(m,p,b){const r=await fetch(BASE+p,{method:m,headers:{'Content-Type':'application/json',...(T?{Authorization:'Bearer '+T}:{})},body:b?JSON.stringify(b):undefined});const j=await r.json().catch(()=>({}));if(!r.ok||j.success===false)throw new Error(`${m} ${p} -> ${r.status} ${JSON.stringify(j).slice(0,200)}`);return j.data;}
const today=new Date().toISOString().slice(0,10);
(async()=>{
  T=(await api('POST','/auth/login',{login:'admin',password:'admin123'})).token;
  // fresh batch: AAR-001 (item 11), qty 20
  const batch=await api('POST','/casting/batches',{batchDate:today,notes:'verify 15-min + receipt + wip',items:[{itemId:11,quantity:20}]});
  let b=await api('GET',`/casting/batches/${batch.id}`);
  const cast=b.items.find(s=>s.processCode==='CASTING');
  await api('POST','/casting/receipts',{batchId:batch.id,vendorId:cast.vendorId,receiptDate:today,items:[{batchItemId:cast.id,receivedQty:20,receivedWeight:240}]});

  // get plating colour 'Gold' (3rd colour on AAR) vendor
  const it=await api('GET','/items/11');
  const plating=it.processes.find(p=>p.code==='PLATING');
  const gold=plating.vendors.find(v=>v.color==='Gold') || plating.vendors[0];
  // Forward #1: 8 pcs Gold
  await api('POST',`/casting/batch-items/${cast.id}/forward`,{processId:plating.processId,quantity:8,vendorId:gold.vendorId,color:gold.color,weight:12,costPerKg:gold.costPerPiece});
  // Forward #2 (within 15 min, same process+vendor): 5 more Gold -> should JOIN same slip
  await api('POST',`/casting/batch-items/${cast.id}/forward`,{processId:plating.processId,quantity:5,vendorId:gold.vendorId,color:gold.color,weight:12,costPerKg:gold.costPerPiece});

  b=await api('GET',`/casting/batches/${batch.id}`);
  const plats=b.items.filter(s=>s.processCode==='PLATING');
  console.log('=== 15-MIN GROUPING ===');
  plats.forEach(s=>console.log(`  stage ${s.id} qty=${s.quantity} colour=${s.color} issueSlipId=${s.issueSlipId}`));
  const sameSlip = new Set(plats.map(s=>s.issueSlipId)).size===1;
  console.log(`  -> both forwards share one slip: ${sameSlip}  (slip id ${plats[0].issueSlipId})`);

  // receive plating gold, then a receipt to check internal slip fields
  const rec=await api('POST','/casting/receipts',{batchId:batch.id,vendorId:gold.vendorId,receiptDate:today,items:plats.map(s=>({batchItemId:s.id,receivedQty:s.quantity,receivedWeight:s.quantity*12}))});
  console.log('\n=== VENDOR WIP (gold vendor ledger underProcess) ===');
  // nothing pending now (received all). Instead check casting vendor has 0, and create a pending: forward leftover 7 to plating gold but don't receive
  await api('POST',`/casting/batch-items/${cast.id}/forward`,{processId:plating.processId,quantity:7,vendorId:gold.vendorId,color:gold.color,weight:12,costPerKg:gold.costPerPiece});
  const led=await api('GET',`/casting/vendor-ledger/${gold.vendorId}`);
  console.log(`  underProcess summary: qty=${led.summary.underProcess.qty} wt=${led.summary.underProcess.weight}`);
  led.underProcess.slice(0,4).forEach(u=>console.log(`   - ${u.processName} ${u.itemNumber} ${u.color} pending=${u.pendingQty}`));

  // receipt PDF id
  console.log('\nRECEIPT_ID', rec.id);
  console.log('BATCH_ID', batch.id);
})().catch(e=>{console.error('FAIL',e.message);process.exit(1);});
