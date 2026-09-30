'use strict';

const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const { getBusinessClock, shiftDate } = require('./schedule');
const { createOrdersXlsx } = require('./xlsx');

const app = express();
const port = Number(process.env.PORT || 3000);
const sessionHours = Number(process.env.SESSION_HOURS || 12);
const initialAdminPassword = process.env.ADMIN_PASSWORD || 'test123';
const mysqlHost = process.env.MYSQL_HOST || '127.0.0.1';
const mysqlSsl = String(process.env.MYSQL_SSL || 'false').toLowerCase() === 'true';
const allowInsecureRemote = String(process.env.MYSQL_ALLOW_INSECURE_REMOTE || 'false').toLowerCase() === 'true';
const pool = mysql.createPool({
  host:mysqlHost, port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || 'order_app', password: process.env.MYSQL_PASSWORD || 'order_dev_password',
  database: process.env.MYSQL_DATABASE || 'order_system', waitForConnections:true,
  connectionLimit:Number(process.env.MYSQL_CONNECTION_LIMIT || 10), charset:'utf8mb4', timezone:'+08:00',
  dateStrings:true, supportBigNumbers:true, bigNumberStrings:true, multipleStatements:true,
  ssl:mysqlSsl ? { rejectUnauthorized:String(process.env.MYSQL_SSL_REJECT_UNAUTHORIZED || 'true').toLowerCase() === 'true' } : undefined
});

app.use(express.json({ limit:'100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

async function assertLegacyTables() {
  const expected=['administrator','customer','detail','goods','order','roots','timer'];
  const [rows]=await pool.query('SELECT table_name AS name FROM information_schema.tables WHERE table_schema=DATABASE()');
  const names=new Set(rows.map((row)=>row.name)); const missing=expected.filter((name)=>!names.has(name));
  if(missing.length) throw new Error(`客戶資料庫缺少必要資料表：${missing.join(', ')}`);
}

async function addIndexIfMissing(tableName,indexName,columns) {
  const [rows]=await pool.execute('SELECT 1 FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name=? AND index_name=? LIMIT 1',[tableName,indexName]);
  if(!rows.length) await pool.query(`ALTER TABLE \`${tableName}\` ADD INDEX \`${indexName}\` (${columns})`);
}

async function initializeDatabase() {
  if(!['localhost','127.0.0.1','mysql'].includes(mysqlHost)&&!mysqlSsl&&!allowInsecureRemote) {
    throw new Error('拒絕未加密的遠端MySQL連線；請啟用MYSQL_SSL或使用同主機／安全通道');
  }
  await assertLegacyTables();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orderflow_accounts (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, username VARCHAR(64) NOT NULL, password_hash VARCHAR(255) NOT NULL,
      display_name VARCHAR(80) NOT NULL, role ENUM('admin','member') NOT NULL DEFAULT 'member', customer_id INT NULL,
      active TINYINT(1) NOT NULL DEFAULT 1, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id), UNIQUE KEY uq_orderflow_accounts_username (username), UNIQUE KEY uq_orderflow_accounts_customer (customer_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    CREATE TABLE IF NOT EXISTS orderflow_sessions (
      token CHAR(64) NOT NULL, account_id BIGINT UNSIGNED NOT NULL, expires_at DATETIME NOT NULL,
      PRIMARY KEY (token), KEY idx_orderflow_sessions_expires (expires_at),
      CONSTRAINT fk_orderflow_session_account FOREIGN KEY (account_id) REFERENCES orderflow_accounts(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    CREATE TABLE IF NOT EXISTS orderflow_settings (
      id TINYINT NOT NULL DEFAULT 1, enabled TINYINT(1) NOT NULL DEFAULT 1, last_closed_date DATE NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, updated_by BIGINT UNSIGNED NULL,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    CREATE TABLE IF NOT EXISTS orderflow_exports (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, business_date DATE NOT NULL, export_type ENUM('automatic','manual') NOT NULL,
      exported_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, exported_by BIGINT UNSIGNED NULL,
      order_count INT UNSIGNED NOT NULL, item_count INT UNSIGNED NOT NULL, total_quantity BIGINT UNSIGNED NOT NULL,
      file_name VARCHAR(160) NOT NULL, xlsx_data LONGBLOB NOT NULL,
      PRIMARY KEY (id), KEY idx_orderflow_exports_date (business_date, exported_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    CREATE TABLE IF NOT EXISTS orderflow_daily_closings (
      business_date DATE NOT NULL, closed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      trigger_type ENUM('automatic','manual') NOT NULL, closed_by BIGINT UNSIGNED NULL, export_id BIGINT UNSIGNED NOT NULL,
      PRIMARY KEY (business_date), UNIQUE KEY uq_orderflow_closing_export (export_id),
      CONSTRAINT fk_orderflow_closing_export FOREIGN KEY (export_id) REFERENCES orderflow_exports(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    CREATE TABLE IF NOT EXISTS orderflow_hidden_goods (
      goods_id INT NOT NULL, hidden_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, hidden_by BIGINT UNSIGNED NULL,
      PRIMARY KEY (goods_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    INSERT IGNORE INTO orderflow_settings (id,enabled) VALUES (1,1);
    INSERT IGNORE INTO timer (time_id,hour,minute,seconds,status) VALUES (1,'24','00','00',2);
  `);
  await addIndexIfMissing('order','idx_orderflow_order_date_status','`o_date`,`status`');
  const hash=await bcrypt.hash(initialAdminPassword,12);
  await pool.execute(`INSERT IGNORE INTO orderflow_accounts (username,password_hash,display_name,role,active)
    VALUES ('admin',?,'系統管理員','admin',1)`,[hash]);
}

function parseCookies(header='') {
  return Object.fromEntries(header.split(';').map((part)=>{const index=part.indexOf('=');return index<0?['','']:[part.slice(0,index).trim(),decodeURIComponent(part.slice(index+1).trim())];}).filter(([key])=>key));
}
function verifyLegacyPassword(input,stored) {
  if(!stored) return false;
  if(String(input)===String(stored)) return true;
  if(/^[0-9a-f]{32}$/i.test(stored)&&crypto.createHash('md5').update(input).digest('hex').toLowerCase()===stored.toLowerCase()) return true;
  if(/^\$2[aby]\$/.test(stored)) return bcrypt.compareSync(input,stored);
  try { return Buffer.from(stored,'base64').toString('utf8')===input; } catch(_) { return false; }
}
async function migrateLegacyLogin(username,password) {
  const [admins]=await pool.execute('SELECT id,account,password FROM administrator WHERE account=? LIMIT 1',[username]);
  if(admins[0]&&verifyLegacyPassword(password,admins[0].password)) return {username,passwordHash:await bcrypt.hash(password,12),displayName:username,role:'admin',customerId:null};
  const [customers]=await pool.execute('SELECT c_index,c_account,c_password,c_name FROM customer WHERE c_account=? AND c_suspended=0 LIMIT 1',[username]);
  if(customers[0]&&verifyLegacyPassword(password,customers[0].c_password)) return {username,passwordHash:await bcrypt.hash(password,12),displayName:customers[0].c_name,role:'member',customerId:customers[0].c_index};
  return null;
}
async function requireAuth(req,res,next) {
  try {
    const token=parseCookies(req.headers.cookie).order_session; if(!token) return res.status(401).json({error:'請先登入'});
    const [rows]=await pool.execute(`SELECT a.id,a.username,a.display_name AS displayName,a.role,a.customer_id AS customerId
      FROM orderflow_sessions s JOIN orderflow_accounts a ON a.id=s.account_id WHERE s.token=? AND s.expires_at>NOW() AND a.active=1`,[token]);
    if(!rows[0]) return res.status(401).json({error:'登入已逾時，請重新登入'}); req.user=rows[0]; req.sessionToken=token; next();
  } catch(error) { next(error); }
}
function requireAdmin(req,res,next) { if(req.user.role!=='admin') return res.status(403).json({error:'僅系統管理員可使用此功能'}); next(); }

app.post('/api/login',async(req,res)=>{
  const username=String(req.body.username||'').trim(),password=String(req.body.password||'');
  let [rows]=await pool.execute('SELECT * FROM orderflow_accounts WHERE username=? AND active=1 LIMIT 1',[username]); let account=rows[0];
  if(!account||!await bcrypt.compare(password,account.password_hash)) {
    const legacy=await migrateLegacyLogin(username,password); if(!legacy) return res.status(401).json({error:'帳號或密碼錯誤；舊站加密帳號需先重設密碼'});
    await pool.execute(`INSERT INTO orderflow_accounts (username,password_hash,display_name,role,customer_id,active) VALUES (?,?,?,?,?,1)
      ON DUPLICATE KEY UPDATE password_hash=VALUES(password_hash),display_name=VALUES(display_name),role=VALUES(role),customer_id=VALUES(customer_id),active=1`,
      [legacy.username,legacy.passwordHash,legacy.displayName,legacy.role,legacy.customerId]);
    [rows]=await pool.execute('SELECT * FROM orderflow_accounts WHERE username=? LIMIT 1',[username]); account=rows[0];
  }
  const token=crypto.randomBytes(32).toString('hex'); await pool.query('DELETE FROM orderflow_sessions WHERE expires_at<=NOW()');
  await pool.execute('INSERT INTO orderflow_sessions (token,account_id,expires_at) VALUES (?,?,DATE_ADD(NOW(),INTERVAL ? HOUR))',[token,account.id,sessionHours]);
  res.setHeader('Set-Cookie',`order_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${sessionHours*3600}`);
  res.json({id:account.id,username:account.username,displayName:account.display_name,role:account.role,customerId:account.customer_id});
});
app.post('/api/logout',requireAuth,async(req,res)=>{await pool.execute('DELETE FROM orderflow_sessions WHERE token=?',[req.sessionToken]);res.setHeader('Set-Cookie','order_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');res.status(204).end();});
app.get('/api/me',requireAuth,(req,res)=>res.json(req.user));

app.get('/api/products/:barcode',requireAuth,async(req,res)=>{
  const [rows]=await pool.execute(`SELECT g.s_index AS id,g.s_barcode AS barcode,g.s_goodname AS name,g.s_unit AS specification
    FROM goods g LEFT JOIN orderflow_hidden_goods h ON h.goods_id=g.s_index WHERE g.s_barcode=? AND h.goods_id IS NULL ORDER BY g.s_index DESC LIMIT 1`,[req.params.barcode.trim()]);
  if(!rows[0]) return res.status(404).json({error:'查無此商品條碼'}); res.json(rows[0]);
});
app.get('/api/products',requireAuth,requireAdmin,async(req,res)=>{
  const query=String(req.query.query||'').trim().slice(0,50),params=query?[`%${query}%`,`%${query}%`,`%${query}%`]:[];
  const where=query?'AND (g.s_barcode LIKE ? OR g.s_goodname LIKE ? OR g.s_unit LIKE ?)':'';
  const [rows]=await pool.execute(`SELECT g.s_index AS id,g.s_barcode AS barcode,g.s_goodname AS name,g.s_unit AS specification
    FROM goods g LEFT JOIN orderflow_hidden_goods h ON h.goods_id=g.s_index WHERE h.goods_id IS NULL ${where} ORDER BY g.s_index DESC LIMIT 500`,params); res.json(rows);
});
function validateProduct(body) {
  const barcode=String(body.barcode||'').trim(),name=String(body.name||'').trim(),unit=String(body.specification||'').trim();
  if(!barcode||barcode.length>20) throw new Error('商品條碼必填且最多20字'); if(!name||name.length>50) throw new Error('商品名稱必填且最多50字');
  if(unit.length>10) throw new Error('單位最多10字'); return {barcode,name,unit};
}
app.post('/api/products',requireAuth,requireAdmin,async(req,res)=>{
  try { const p=validateProduct(req.body),[exists]=await pool.execute('SELECT s_index FROM goods WHERE s_barcode=? LIMIT 1',[p.barcode]);
    if(exists.length) return res.status(409).json({error:'此商品條碼已存在'}); const [result]=await pool.execute('INSERT INTO goods (s_barcode,s_goodname,s_unit) VALUES (?,?,?)',[p.barcode,p.name,p.unit]);
    res.status(201).json({id:result.insertId,barcode:p.barcode,name:p.name,specification:p.unit}); } catch(error) { res.status(400).json({error:error.message}); }
});
app.put('/api/products/:id',requireAuth,requireAdmin,async(req,res)=>{
  try { const p=validateProduct(req.body),id=Number(req.params.id),[dupe]=await pool.execute('SELECT s_index FROM goods WHERE s_barcode=? AND s_index<>? LIMIT 1',[p.barcode,id]);
    if(dupe.length) return res.status(409).json({error:'此商品條碼已存在'}); const [result]=await pool.execute('UPDATE goods SET s_barcode=?,s_goodname=?,s_unit=? WHERE s_index=?',[p.barcode,p.name,p.unit,id]);
    if(!result.affectedRows) return res.status(404).json({error:'查無此商品'}); res.json({id,barcode:p.barcode,name:p.name,specification:p.unit}); } catch(error) { res.status(400).json({error:error.message}); }
});
app.delete('/api/products/:id',requireAuth,requireAdmin,async(req,res)=>{
  const id=Number(req.params.id),[used]=await pool.execute('SELECT 1 FROM detail WHERE s_index=? LIMIT 1',[id]);
  if(used.length) await pool.execute('INSERT IGNORE INTO orderflow_hidden_goods (goods_id,hidden_by) VALUES (?,?)',[id,req.user.id]); else await pool.execute('DELETE FROM goods WHERE s_index=?',[id]); res.status(204).end();
});

app.get('/api/customers',requireAuth,requireAdmin,async(req,res)=>{
  const query=String(req.query.query||'').trim().slice(0,64),params=query?[`%${query}%`,`%${query}%`,`%${query}%`,`%${query}%`]:[];
  const where=query?'WHERE c.c_account LIKE ? OR c.c_name LIKE ? OR c.c_custno LIKE ? OR c.c_id LIKE ?':'';
  const [rows]=await pool.execute(`SELECT c.c_index AS id,c.c_custno AS customerNo,c.c_account AS account,c.c_name AS name,
    c.c_tel AS telephone,c.c_id AS taxId,c.c_suspended AS suspended,(a.id IS NOT NULL) AS appPasswordReady
    FROM customer c LEFT JOIN orderflow_accounts a ON a.customer_id=c.c_index ${where} ORDER BY c.c_index DESC LIMIT 500`,params);
  res.json(rows);
});

app.post('/api/customers/:id/reset-password',requireAuth,requireAdmin,async(req,res)=>{
  const id=Number(req.params.id),password=String(req.body.password||'');
  if(!Number.isInteger(id)||id<1) return res.status(400).json({error:'客戶編號不正確'});
  if(password.length<8||password.length>128) return res.status(400).json({error:'新密碼需為8至128字'});
  const [customers]=await pool.execute('SELECT c_index,c_account,c_name,c_suspended FROM customer WHERE c_index=? LIMIT 1',[id]);
  if(!customers[0]) return res.status(404).json({error:'查無此客戶'}); const customer=customers[0],hash=await bcrypt.hash(password,12);
  const [collision]=await pool.execute('SELECT id FROM orderflow_accounts WHERE username=? AND (customer_id IS NULL OR customer_id<>?) LIMIT 1',[customer.c_account,id]);
  if(collision.length) return res.status(409).json({error:'此客戶帳號與既有系統帳號重複，請先調整舊資料'});
  await pool.execute(`INSERT INTO orderflow_accounts (username,password_hash,display_name,role,customer_id,active) VALUES (?,?,?,'member',?,?)
    ON DUPLICATE KEY UPDATE password_hash=VALUES(password_hash),display_name=VALUES(display_name),role='member',customer_id=VALUES(customer_id),active=VALUES(active)`,
    [customer.c_account,hash,customer.c_name,customer.c_index,customer.c_suspended?0:1]);
  res.json({id,account:customer.c_account,passwordReset:true});
});

async function createOrder(user,items) {
  if(!user.customerId) throw new Error('管理員帳號未綁定客戶，請使用客戶帳號建立訂單'); const clock=getBusinessClock();
  const [closed]=await pool.execute('SELECT 1 FROM orderflow_daily_closings WHERE business_date=? LIMIT 1',[clock.date]); if(closed.length) throw new Error('今日訂單已結單，無法再新增');
  const connection=await pool.getConnection(); let orderId;
  try {
    const [orderResult]=await connection.execute('INSERT INTO `order` (o_date,o_hour,o_minute,o_seconds,c_index,status) VALUES (?,?,?,?,?,0)',[clock.date,clock.time.slice(0,2),clock.time.slice(3,5),String(new Date().getSeconds()).padStart(2,'0'),user.customerId]); orderId=orderResult.insertId;
    for(const item of items) {
      const [products]=await connection.execute(`SELECT g.* FROM goods g LEFT JOIN orderflow_hidden_goods h ON h.goods_id=g.s_index WHERE g.s_barcode=? AND h.goods_id IS NULL ORDER BY g.s_index DESC LIMIT 1`,[String(item.barcode)]);
      if(!products[0]) throw new Error(`查無商品：${item.barcode}`); const quantity=Number(item.quantity); if(!Number.isInteger(quantity)||quantity<1||quantity>9999) throw new Error('商品數量不正確');
      await connection.execute('INSERT INTO detail (o_index,s_index,d_date,d_hour,d_minute,d_seconds,c_index,o_quantity,o_note) VALUES (?,?,?,?,?,?,?,?,?)',[orderId,products[0].s_index,clock.date,clock.time.slice(0,2),clock.time.slice(3,5),String(new Date().getSeconds()).padStart(2,'0'),user.customerId,String(quantity),String(item.note||'').slice(0,255)]);
    }
    return {id:orderId,orderNumber:String(orderId)};
  } catch(error) { if(orderId){await connection.execute('DELETE FROM detail WHERE o_index=?',[orderId]);await connection.execute('DELETE FROM `order` WHERE o_index=?',[orderId]);} throw error; } finally { connection.release(); }
}
app.post('/api/orders',requireAuth,async(req,res)=>{const items=Array.isArray(req.body.items)?req.body.items:[];if(!items.length)return res.status(400).json({error:'訂單至少需要一項商品'});try{res.status(201).json(await createOrder(req.user,items));}catch(error){res.status(400).json({error:error.message});}});
app.get('/api/orders',requireAuth,async(req,res)=>{
  const date=/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date||''))?req.query.date:getBusinessClock().date,memberFilter=req.user.role==='member'?'AND o.c_index=?':'',params=req.user.role==='member'?[date,req.user.customerId]:[date];
  const [rows]=await pool.execute(`SELECT o.o_index AS id,CAST(o.o_index AS CHAR) AS orderNumber,CONCAT(o.o_date,' ',o.o_hour,':',o.o_minute,':',o.o_seconds) AS createdAt,
    c.c_name AS memberName,COUNT(d.d_id) AS itemCount,COALESCE(SUM(CAST(d.o_quantity AS UNSIGNED)),0) AS totalQuantity,
    IF(o.status=1,'closed','created') AS status,(o.status=0 AND o.o_date=CURDATE()) AS editable
    FROM \`order\` o JOIN customer c ON c.c_index=o.c_index LEFT JOIN detail d ON d.o_index=o.o_index WHERE o.o_date=? ${memberFilter}
    GROUP BY o.o_index,c.c_name ORDER BY o.o_index DESC`,params); res.json(rows);
});
app.get('/api/orders/:id',requireAuth,async(req,res)=>{
  const memberFilter=req.user.role==='member'?'AND o.c_index=?':'',params=req.user.role==='member'?[req.params.id,req.user.customerId]:[req.params.id];
  const [rows]=await pool.execute(`SELECT o.o_index AS id,CAST(o.o_index AS CHAR) AS orderNumber,IF(o.status=1,'closed','created') AS status,
    CONCAT(o.o_date,' ',o.o_hour,':',o.o_minute,':',o.o_seconds) AS createdAt,c.c_name AS memberName FROM \`order\` o JOIN customer c ON c.c_index=o.c_index WHERE o.o_index=? ${memberFilter}`,params);
  if(!rows[0]) return res.status(404).json({error:'查無訂單'}); const order=rows[0],[items]=await pool.execute(`SELECT g.s_barcode AS barcode,g.s_goodname AS name,g.s_unit AS specification,
    CAST(d.o_quantity AS UNSIGNED) AS quantity,d.o_note AS note FROM detail d JOIN goods g ON g.s_index=d.s_index WHERE d.o_index=? ORDER BY d.d_id`,[order.id]); order.items=items;res.json(order);
});

async function buildExcel(businessDate,connection=pool,forceClosed=false) {
  const statusExpression=forceClosed?"'已鎖定'":"IF(o.status=1,'已鎖定','可修改')";
  const [rows]=await connection.execute(`SELECT o.o_date AS businessDate,o.o_index AS orderNumber,CONCAT(o.o_date,' ',o.o_hour,':',o.o_minute,':',o.o_seconds) AS createdAt,
    c.c_name AS memberName,g.s_barcode AS barcode,g.s_goodname AS productName,g.s_unit AS unit,CAST(d.o_quantity AS UNSIGNED) AS quantity,d.o_note AS note,
    ${statusExpression} AS status FROM \`order\` o JOIN customer c ON c.c_index=o.c_index JOIN detail d ON d.o_index=o.o_index JOIN goods g ON g.s_index=d.s_index
    WHERE o.o_date=? ORDER BY o.o_index,d.d_id`,[businessDate]);
  return {buffer:createOrdersXlsx(rows,businessDate),orderCount:new Set(rows.map((row)=>String(row.orderNumber))).size,itemCount:rows.length,totalQuantity:rows.reduce((sum,row)=>sum+Number(row.quantity||0),0)};
}
async function createExport(businessDate,type,userId=null,connection=pool,forceClosed=false) {
  const excel=await buildExcel(businessDate,connection,forceClosed),fileName=`orders-${businessDate}.xlsx`,[result]=await connection.execute(`INSERT INTO orderflow_exports (business_date,export_type,exported_by,order_count,item_count,total_quantity,file_name,xlsx_data) VALUES (?,?,?,?,?,?,?,?)`,[businessDate,type,userId,excel.orderCount,excel.itemCount,excel.totalQuantity,fileName,excel.buffer]);
  return {id:String(result.insertId),businessDate,exportType:type,orderCount:excel.orderCount,itemCount:excel.itemCount,totalQuantity:excel.totalQuantity};
}
async function closeBusinessDate(businessDate,triggerType='automatic',userId=null) {
  const connection=await pool.getConnection(),lockName=`orderflow-close-${businessDate}`;
  try {
    const [[lock]]=await connection.execute('SELECT GET_LOCK(?,10) AS acquired',[lockName]);if(!lock.acquired)throw new Error('結單作業忙碌中，請稍後再試');
    const [existing]=await connection.execute(`SELECT c.business_date AS businessDate,c.closed_at AS closedAt,c.trigger_type AS triggerType,e.id AS exportId,e.order_count AS orderCount,e.item_count AS itemCount,e.total_quantity AS totalQuantity FROM orderflow_daily_closings c JOIN orderflow_exports e ON e.id=c.export_id WHERE c.business_date=?`,[businessDate]);if(existing[0])return existing[0];
    await connection.beginTransaction();
    const exported=await createExport(businessDate,triggerType,userId,connection,true);
    await connection.execute('UPDATE `order` SET status=1 WHERE o_date=?',[businessDate]);
    await connection.execute('INSERT INTO orderflow_daily_closings (business_date,trigger_type,closed_by,export_id) VALUES (?,?,?,?)',[businessDate,triggerType,userId,exported.id]);
    await connection.execute('UPDATE orderflow_settings SET last_closed_date=IF(last_closed_date IS NULL OR last_closed_date<?,?,last_closed_date) WHERE id=1',[businessDate,businessDate]);
    await connection.commit();
    return {...exported,closedAt:new Date().toISOString(),triggerType,exportId:exported.id};
  } catch(error) { try{await connection.rollback();}catch(_){} throw error; }
  finally {try{await connection.execute('SELECT RELEASE_LOCK(?)',[lockName]);}catch(_){}connection.release();}
}
async function scheduleInfo() {
  const [[timer]]=await pool.query('SELECT hour,minute,seconds,status FROM timer ORDER BY time_id LIMIT 1'),[[setting]]=await pool.query('SELECT enabled,last_closed_date AS lastClosedDate,updated_at AS updatedAt FROM orderflow_settings WHERE id=1');
  const hour=String(timer?.hour||'24').padStart(2,'0');return {...setting,closeTime:`${hour==='24'?'00':hour}:${String(timer?.minute||'00').padStart(2,'0')}`,timezone:'Asia/Taipei',legacyTimerStatus:timer?.status};
}
async function runSchedule() {
  const setting=await scheduleInfo();if(!setting.enabled)return;const now=getBusinessClock();if(now.time<setting.closeTime)return;const target=shiftDate(now.date,-1);
  await closeBusinessDate(target);
}
app.get('/api/schedule',requireAuth,requireAdmin,async(_req,res)=>{const setting=await scheduleInfo(),[exports]=await pool.query(`SELECT e.id,e.business_date AS businessDate,e.export_type AS exportType,e.exported_at AS exportedAt,e.order_count AS orderCount,e.item_count AS itemCount,e.total_quantity AS totalQuantity,(c.business_date IS NOT NULL) AS closed FROM orderflow_exports e LEFT JOIN orderflow_daily_closings c ON c.export_id=e.id ORDER BY e.id DESC LIMIT 30`);res.json({setting,exports,today:getBusinessClock().date});});
app.put('/api/schedule',requireAuth,requireAdmin,async(req,res)=>{const enabled=Boolean(req.body.enabled),closeTime=String(req.body.closeTime||'');if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(closeTime))return res.status(400).json({error:'排程時間格式不正確'});const [hour,minute]=closeTime.split(':');await pool.execute('UPDATE timer SET hour=?,minute=?,seconds=? ORDER BY time_id LIMIT 1',[hour==='00'?'24':hour,minute,'00']);await pool.execute('UPDATE orderflow_settings SET enabled=?,updated_by=? WHERE id=1',[enabled?1:0,req.user.id]);res.json(await scheduleInfo());});
app.post('/api/schedule/export',requireAuth,requireAdmin,async(req,res)=>{const date=String(req.body.businessDate||'');if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return res.status(400).json({error:'請選擇匯出日期'});res.status(201).json(await createExport(date,'manual',req.user.id));});
app.post('/api/schedule/close',requireAuth,requireAdmin,async(req,res)=>{const date=String(req.body.businessDate||'');if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||date>getBusinessClock().date)return res.status(400).json({error:'結單日期不正確'});res.status(201).json(await closeBusinessDate(date,'manual',req.user.id));});
app.get('/api/exports/:id/download',requireAuth,requireAdmin,async(req,res)=>{const [rows]=await pool.execute('SELECT file_name AS fileName,xlsx_data AS data FROM orderflow_exports WHERE id=?',[req.params.id]);if(!rows[0])return res.status(404).json({error:'查無匯出紀錄'});res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');res.setHeader('Content-Disposition',`attachment; filename="${rows[0].fileName}"`);res.send(rows[0].data);});
app.get('/api/health',async(_req,res)=>{await pool.query('SELECT 1');res.json({ok:true,database:'mysql',legacySchema:true});});
app.use((error,_req,res,_next)=>{console.error(error);res.status(500).json({error:'伺服器發生錯誤'});});
initializeDatabase().then(()=>{app.listen(port,'0.0.0.0',()=>console.log(`訂單系統已啟動：http://localhost:${port}`));runSchedule().catch((error)=>console.error('排程初始檢查失敗',error));setInterval(()=>runSchedule().catch((error)=>console.error('排程執行失敗',error)),30000).unref();}).catch((error)=>{console.error('MySQL初始化失敗',error);process.exit(1);});
