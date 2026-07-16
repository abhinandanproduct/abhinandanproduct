const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const COL = ['PLATING','MEENA','FITTING','MALA','STICKING'];
  // colours currently used per process across items
  const items = await p.item.findMany({ include:{ processes:{ include:{ process:true, vendors:{ include:{vendor:true} } } } }, orderBy:{id:'asc'} });
  const byProc = {};
  for (const it of items) for (const pr of it.processes) {
    if (!COL.includes(pr.process.code)) continue;
    byProc[pr.process.code] = byProc[pr.process.code] || {};
    for (const v of pr.vendors) { const c=(v.color||'-'); byProc[pr.process.code][c]=(byProc[pr.process.code][c]||0)+1; }
  }
  console.log('=== colour usage per process (colour: #items) ===');
  for (const c of COL) console.log(`  ${c}:`, byProc[c]);

  // vendors available per colour process (who can do it)
  const procs = await p.process.findMany({ where:{ code:{ in: COL } }, include:{ vendors:{ include:{vendor:true} } } });
  console.log('\n=== vendors available per colour process ===');
  for (const pr of procs) console.log(`  ${pr.code}: ${pr.vendors.map(v=>v.vendor.vendorCode+' '+v.vendor.vendorName).join(' | ')}`);
  await p.$disconnect();
})();
