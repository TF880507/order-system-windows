'use strict';

const XLSX = require('xlsx');

const MAX_PRODUCT_IMPORT_ROWS = 8000;
const PRODUCT_IMPORT_COLUMNS = [
  { dbColumn:'barcode', header:'商品條碼', aliases:['商品條碼', '條碼', 'barcode'], required:true },
  { dbColumn:'name', header:'商品名稱', aliases:['商品名稱', '品名', 'name'], required:true },
  { dbColumn:'specification', header:'規格／備註', aliases:['規格／備註', '規格/備註', '規格', '備註', 'specification'] },
  { dbColumn:'active', header:'狀態', aliases:['狀態', '啟用狀態', 'active'] }
];

function normalizeHeader(value) {
  return String(value ?? '').replace(/^\uFEFF/, '').replace(/[\s　]/g, '').replaceAll('/', '／').toLowerCase();
}

function cellValue(sheet, row, column) {
  const cell = sheet[XLSX.utils.encode_cell({ r:row, c:column })];
  return cell ? cell.v : '';
}

function barcodeValue(cell, rowNumber) {
  if (!cell || cell.v === null || cell.v === undefined) return '';
  if (cell.t === 'n') {
    if (!Number.isSafeInteger(cell.v)) throw new Error(`第 ${rowNumber} 列商品條碼已被 Excel 轉成不精確數字，請將該欄設為文字後重新貼上原始條碼`);
    return String(cell.v);
  }
  const value = String(cell.v).trim();
  if (/^[+-]?\d+(?:\.\d+)?e[+-]?\d+$/i.test(value)) {
    throw new Error(`第 ${rowNumber} 列商品條碼是科學記號，請使用下載範本並以文字格式填寫條碼`);
  }
  return value;
}

function parseActive(value, rowNumber) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized || ['啟用', '是', 'true', '1', 'active'].includes(normalized)) return true;
  if (['停用', '已刪除', '否', 'false', '0', 'inactive'].includes(normalized)) return false;
  throw new Error(`第 ${rowNumber} 列狀態只能填「啟用」或「停用」`);
}

function createProductTemplateBuffer() {
  const headers = PRODUCT_IMPORT_COLUMNS.map((column) => column.header);
  const sheet = XLSX.utils.aoa_to_sheet([headers]);
  for (let row = 1; row <= MAX_PRODUCT_IMPORT_ROWS; row += 1) {
    sheet[XLSX.utils.encode_cell({ r:row, c:0 })] = { t:'s', v:'', z:'@' };
  }
  sheet['!ref'] = `A1:D${MAX_PRODUCT_IMPORT_ROWS + 1}`;
  sheet['!cols'] = [{ wch:24 }, { wch:38 }, { wch:28 }, { wch:12 }];
  sheet['!autofilter'] = { ref:`A1:D${MAX_PRODUCT_IMPORT_ROWS + 1}` };
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, '商品匯入');
  return XLSX.write(workbook, { type:'buffer', bookType:'xlsx', compression:true });
}

function createProductsExportBuffer(products) {
  const data = [
    ['商品條碼', '商品名稱', '規格／備註', '狀態', '建檔時間'],
    ...products.map((product) => [
      String(product.barcode ?? ''), product.name ?? '', product.specification ?? '',
      product.active ? '啟用' : '停用', product.createdAt?.toISOString?.() || String(product.createdAt ?? '')
    ])
  ];
  const sheet = XLSX.utils.aoa_to_sheet(data);
  for (let row = 1; row < data.length; row += 1) {
    const address = XLSX.utils.encode_cell({ r:row, c:0 });
    sheet[address] = { t:'s', v:String(products[row - 1].barcode ?? ''), z:'@' };
  }
  sheet['!cols'] = [{ wch:24 }, { wch:38 }, { wch:28 }, { wch:12 }, { wch:24 }];
  sheet['!autofilter'] = { ref:`A1:E${Math.max(1, data.length)}` };
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, '商品資料');
  return XLSX.write(workbook, { type:'buffer', bookType:'xlsx', compression:true });
}

function parseProductImportBuffer(buffer) {
  let workbook;
  try {
    workbook = XLSX.read(buffer, { type:'buffer', raw:true, cellDates:false });
  } catch (_error) {
    throw new Error('檔案格式無法解析，請使用範本 XLSX，或提供 CSV／XLS 檔案');
  }
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet?.['!ref']) throw new Error('匯入檔案沒有資料');
  const range = XLSX.utils.decode_range(sheet['!ref']);
  const headerMap = new Map();
  for (let column = range.s.c; column <= range.e.c; column += 1) {
    headerMap.set(normalizeHeader(cellValue(sheet, range.s.r, column)), column);
  }
  const resolved = {};
  for (const definition of PRODUCT_IMPORT_COLUMNS) {
    const aliases = definition.aliases.map(normalizeHeader);
    const match = aliases.find((alias) => headerMap.has(alias));
    if (match) resolved[definition.dbColumn] = headerMap.get(match);
    else if (definition.required) throw new Error(`匯入檔案缺少「${definition.header}」欄位`);
  }

  const products = [];
  const seen = new Set();
  for (let row = range.s.r + 1; row <= range.e.r; row += 1) {
    const rowNumber = row + 1;
    const barcodeCell = sheet[XLSX.utils.encode_cell({ r:row, c:resolved.barcode })];
    const barcode = barcodeValue(barcodeCell, rowNumber);
    const name = String(cellValue(sheet, row, resolved.name) ?? '').trim();
    const specification = resolved.specification === undefined ? '' : String(cellValue(sheet, row, resolved.specification) ?? '').trim();
    const active = resolved.active === undefined ? true : parseActive(cellValue(sheet, row, resolved.active), rowNumber);
    if (!barcode && !name && !specification) continue;
    if (!barcode) throw new Error(`第 ${rowNumber} 列缺少商品條碼`);
    if (!name) throw new Error(`第 ${rowNumber} 列缺少商品名稱`);
    if (barcode.length > 512) throw new Error(`第 ${rowNumber} 列商品條碼超過 512 字`);
    if (name.length > 120) throw new Error(`第 ${rowNumber} 列商品名稱超過 120 字`);
    if (specification.length > 300) throw new Error(`第 ${rowNumber} 列規格／備註超過 300 字`);
    if (seen.has(barcode)) throw new Error(`第 ${rowNumber} 列商品條碼「${barcode}」在檔案中重複`);
    seen.add(barcode);
    products.push({ row:rowNumber, barcode, name, specification, active });
    if (products.length > MAX_PRODUCT_IMPORT_ROWS) throw new Error(`單次最多匯入 ${MAX_PRODUCT_IMPORT_ROWS.toLocaleString()} 筆商品`);
  }
  if (!products.length) throw new Error('匯入檔案沒有商品資料');
  return products;
}

module.exports = {
  MAX_PRODUCT_IMPORT_ROWS,
  PRODUCT_IMPORT_COLUMNS,
  createProductTemplateBuffer,
  createProductsExportBuffer,
  parseProductImportBuffer
};
