const BASE='http://localhost:4000/api'; let T='';
async function api(m,p,b){const r=await fetch(BASE+p,{method:m,headers:{'Content-Type':'application/json',...(T?{Authorization:'Bearer '+T}:{})},body:b?JSON.stringify(b):undefined});const j=await r.json().catch(()=>({}));if(!r.ok||j.success===false)throw new Error(`${m} ${p} -> ${r.status} ${JSON.stringify(j).slice(0,150)}`);return j.data;}
(async()=>{
  T=(await api('POST','/auth/login',{login:'admin',password:'admin123'})).token;
  // batches list
  const list=await api('GET','/casting/batches');
  const rows=Array.isArray(list)?list:list.rows||list;
  console.log('Batches:', rows.map(b=>`${b.batchNumber}(id${b.id})`).join(', '));
  // open first batch, inspect issueSlipId on stages + find a receipt
  const b=await api('GET',`/casting/batches/${rows[0].id}`);
  console.log(`\nBatch ${b.batchNumber}: stages have issueSlipId?`, b.items.slice(0,4).map(s=>`${s.processCode}:slip${s.issueSlipId}`).join(', '));
  const rec = (b.receipts||[])[0];
  if (rec) {
    console.log('Receipt', rec.id, rec.receiptNumber);
    console.log('RECEIPT_ID='+rec.id);
  } else console.log('(no receipts in this batch)');
  // vendor ledger underProcess for first vendor
  const v = b.items[0].vendorId;
  const led = await api('GET',`/casting/vendor-ledger/${v}`);
  console.log('\nVendor ledger underProcess:', JSON.stringify(led.summary.underProcess), 'rows:', (led.underProcess||[]).length);
})().catch(e=>{console.error('FAIL',e.message);process.exit(1);});
