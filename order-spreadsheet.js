'use strict';

const XLSX = require('xlsx');

const ORDER_EXPORT_HEADERS = ['條碼', '名稱', '數量', '單位', '說明'];

function formatTaipeiTime(value = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone:'Asia/Taipei', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23'
  }).formatToParts(value).reduce((result, part) => ({ ...result, [part.type]:part.value }), {});
  return `${parts.hour}:${parts.minute}:${parts.second}`;
}

function customerIdentity(row) {
  return String(row.customerId ?? row.customerCode ?? row.memberUsername ?? row.memberName ?? '');
}

function groupOrderRows(rows) {
  const customers = new Map();
  for (const row of rows) {
    const key = customerIdentity(row);
    if (!customers.has(key)) {
      customers.set(key, {
        customerCode:String(row.customerCode || row.memberUsername || ''),
        memberName:String(row.memberName || ''),
        taxId:String(row.taxId || row.memberUsername || row.phone || ''),
        items:new Map()
      });
    }
    const customer = customers.get(key);
    const itemKey = [row.barcode, row.productName, row.specification, row.note].map((value) => String(value ?? '')).join('\u0000');
    const quantity = Number(row.quantity || 0);
    if (customer.items.has(itemKey)) customer.items.get(itemKey).quantity += quantity;
    else customer.items.set(itemKey, {
      barcode:String(row.barcode || ''),
      productName:String(row.productName || ''),
      quantity,
      specification:String(row.specification || ''),
      note:String(row.note || '')
    });
  }
  return [...customers.values()].map((customer) => ({ ...customer, items:[...customer.items.values()] }));
}

function replaceZipEntry(container, path, value) {
  const fullPath = `Root Entry/${path}`;
  if (!container.FullPaths.includes(fullPath)) throw new Error(`Excel 內容缺少 ${path}`);
  const content = Buffer.from(value, 'utf8');
  XLSX.CFB.utils.cfb_del(container, fullPath);
  XLSX.CFB.utils.cfb_add(container, fullPath, content);
}

function applyLegacyStyles(buffer, customerRows, headerRows) {
  const container = XLSX.CFB.read(buffer, { type:'buffer' });
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="0"/><fonts count="2"><font><name val="Calibri"/><sz val="11"/><color rgb="FF000000"/></font><font><name val="Calibri"/><sz val="11"/><b/><color rgb="FF000000"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf xfId="0" numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf xfId="0" numFmtId="49" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/><xf xfId="0" numFmtId="0" fontId="1" fillId="0" borderId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium9" defaultPivotStyle="PivotStyleMedium4"/></styleSheet>`;
  const sheetIndex = container.FullPaths.indexOf('Root Entry/xl/worksheets/sheet1.xml');
  let sheet = Buffer.from(container.FileIndex[sheetIndex].content).toString('utf8');
  sheet = sheet.replace(/(<col\b[^>]*\bwidth=")[^"]+("[^>]*>)/g, '$120$2');
  const boldAddresses = customerRows.map((row) => `A${row + 1}`);
  for (const row of headerRows) for (const column of ['A', 'B', 'C', 'D', 'E']) boldAddresses.push(`${column}${row + 1}`);
  for (const address of boldAddresses) {
    const pattern = new RegExp(`<c r="${address}"(?: s="\\d+")?`);
    sheet = sheet.replace(pattern, `<c r="${address}" s="2"`);
  }
  replaceZipEntry(container, 'xl/styles.xml', styles);
  replaceZipEntry(container, 'xl/worksheets/sheet1.xml', sheet);
  return XLSX.CFB.write(container, { fileType:'zip', type:'buffer', compression:true });
}

function createOrdersExportBuffer(rows, { businessDate, exportedAt = new Date() } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(businessDate || ''))) throw new Error('匯出日期格式不正確');
  const data = [['訂單存檔時間', `${businessDate} ${formatTaipeiTime(exportedAt)}`, null, null, null]];
  const customerRows = [];
  const headerRows = [];
  const blankRows = [];

  for (const customer of groupOrderRows(rows)) {
    customerRows.push(data.length);
    data.push(['訂購廠商', customer.customerCode, customer.memberName, customer.taxId, null]);
    headerRows.push(data.length);
    data.push(ORDER_EXPORT_HEADERS);
    for (const item of customer.items) {
      data.push([item.barcode, item.productName, item.quantity, item.specification || null, item.note || null]);
    }
    blankRows.push(data.length);
    data.push([null, null, null, null, null]);
  }

  const worksheet = XLSX.utils.aoa_to_sheet(data);
  for (const rowIndex of blankRows) {
    for (const column of ['A', 'B', 'C', 'D', 'E']) worksheet[`${column}${rowIndex + 1}`] = { t:'z' };
  }
  worksheet['!ref'] = `A1:E${data.length}`;
  worksheet['!cols'] = Array.from({ length:5 }, () => ({ width:20 }));
  for (let rowIndex = 0; rowIndex < data.length; rowIndex += 1) {
    for (const column of ['A', 'B', 'C', 'D', 'E']) {
      const cell = worksheet[`${column}${rowIndex + 1}`];
      if (!cell) continue;
      if (column === 'A' && rowIndex > 0 && !headerRows.includes(rowIndex)) cell.t = 's';
      if (column === 'B' && customerRows.includes(rowIndex)) cell.t = 's';
      if (column === 'D' && customerRows.includes(rowIndex)) cell.t = 's';
      if (column === 'A' && !customerRows.includes(rowIndex) && !headerRows.includes(rowIndex)) cell.z = '@';
    }
  }
  const workbook = XLSX.utils.book_new();
  workbook.Props = { Title:'orders', Creator:'housekey' };
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Worksheet');
  const buffer = XLSX.write(workbook, { type:'buffer', bookType:'xlsx', compression:true, cellStyles:true });
  return applyLegacyStyles(buffer, customerRows, headerRows);
}

module.exports = { ORDER_EXPORT_HEADERS, formatTaipeiTime, groupOrderRows, createOrdersExportBuffer };
