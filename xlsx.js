'use strict';

const zlib = require('node:zlib');

const crcTable = Array.from({ length:256 }, (_, value) => {
  let crc=value;
  for(let bit=0;bit<8;bit+=1) crc=(crc&1)?0xedb88320^(crc>>>1):crc>>>1;
  return crc>>>0;
});

function crc32(buffer) {
  let crc=0xffffffff;
  for(const byte of buffer) crc=crcTable[(crc^byte)&0xff]^(crc>>>8);
  return (crc^0xffffffff)>>>0;
}

function zip(files) {
  const local=[],central=[]; let offset=0;
  for(const file of files) {
    const name=Buffer.from(file.name),source=Buffer.from(file.content),compressed=zlib.deflateRawSync(source),crc=crc32(source);
    const header=Buffer.alloc(30); header.writeUInt32LE(0x04034b50,0);header.writeUInt16LE(20,4);header.writeUInt16LE(0x0800,6);header.writeUInt16LE(8,8);
    header.writeUInt32LE(crc,14);header.writeUInt32LE(compressed.length,18);header.writeUInt32LE(source.length,22);header.writeUInt16LE(name.length,26);
    local.push(header,name,compressed);
    const directory=Buffer.alloc(46);directory.writeUInt32LE(0x02014b50,0);directory.writeUInt16LE(20,4);directory.writeUInt16LE(20,6);directory.writeUInt16LE(0x0800,8);directory.writeUInt16LE(8,10);
    directory.writeUInt32LE(crc,16);directory.writeUInt32LE(compressed.length,20);directory.writeUInt32LE(source.length,24);directory.writeUInt16LE(name.length,28);directory.writeUInt32LE(offset,42);
    central.push(directory,name); offset+=header.length+name.length+compressed.length;
  }
  const centralSize=central.reduce((sum,item)=>sum+item.length,0),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(centralSize,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,...central,end]);
}

function xml(value) {
  return String(value??'').replace(/[&<>"']/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[char]));
}
function columnName(index) {
  let name='';
  for(let value=index+1;value;value=Math.floor((value-1)/26)) name=String.fromCharCode(65+((value-1)%26))+name;
  return name;
}
function cell(value,column,row,header=false,numeric=false) {
  const ref=`${columnName(column)}${row}`;
  if(numeric&&Number.isFinite(Number(value))) return `<c r="${ref}"${header?' s="1"':''}><v>${Number(value)}</v></c>`;
  return `<c r="${ref}" t="inlineStr"${header?' s="1"':''}><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
}

function createOrdersXlsx(rows,businessDate) {
  const headers=['營業日','訂單編號','建立時間','客戶','商品條碼','商品名稱','單位','數量','備註','狀態'];
  const keys=['businessDate','orderNumber','createdAt','memberName','barcode','productName','unit','quantity','note','status'];
  const rowXml=[`<row r="1">${headers.map((value,index)=>cell(value,index,1,true)).join('')}</row>`];
  rows.forEach((item,index)=>{const row=index+2;rowXml.push(`<row r="${row}">${keys.map((key,column)=>cell(item[key],column,row,false,key==='quantity')).join('')}</row>`);});
  const lastRow=Math.max(1,rows.length+1);
  const sheet=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:J${lastRow}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${[13,14,21,24,20,42,10,10,32,12].map((width,index)=>`<col min="${index+1}" max="${index+1}" width="${width}" customWidth="1"/>`).join('')}</cols><sheetData>${rowXml.join('')}</sheetData><autoFilter ref="A1:J${lastRow}"/></worksheet>`;
  const files=[
    {name:'[Content_Types].xml',content:'<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'},
    {name:'_rels/.rels',content:'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'},
    {name:'xl/workbook.xml',content:`<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xml(`訂單 ${businessDate}`)}" sheetId="1" r:id="rId1"/></sheets></workbook>`},
    {name:'xl/_rels/workbook.xml.rels',content:'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'},
    {name:'xl/styles.xml',content:'<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="10"/><name val="Arial"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="10"/><name val="Arial"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF222A40"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf fontId="0" fillId="0" borderId="0" xfId="0"/><xf fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'},
    {name:'xl/worksheets/sheet1.xml',content:sheet}
  ];
  return zip(files);
}

module.exports={createOrdersXlsx};
