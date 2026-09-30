const test=require('node:test');
const assert=require('node:assert/strict');
const {createOrdersXlsx}=require('./xlsx');

test('creates a real XLSX zip with an Excel worksheet',()=>{
  const output=createOrdersXlsx([{businessDate:'2026-09-29',orderNumber:'110674',createdAt:'2026-09-29 10:00:00',memberName:'測試客戶',barcode:'471',productName:'商品',unit:'個',quantity:2,note:'測試',status:'已鎖定'}],'2026-09-29');
  assert.equal(output.subarray(0,2).toString(),'PK');
  assert.ok(output.includes(Buffer.from('[Content_Types].xml')));
  assert.ok(output.includes(Buffer.from('xl/worksheets/sheet1.xml')));
  assert.ok(output.length>1000);
});
