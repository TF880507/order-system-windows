SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS administrator (
  id INT NOT NULL AUTO_INCREMENT,
  account VARCHAR(64) NOT NULL,
  password VARCHAR(355) NOT NULL,
  PRIMARY KEY (id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb4 COMMENT='管理者';

CREATE TABLE IF NOT EXISTS customer (
  c_index INT NOT NULL AUTO_INCREMENT,
  c_custno VARCHAR(13) NOT NULL COMMENT '客戶代號',
  c_account VARCHAR(64) NOT NULL COMMENT '登入帳號',
  c_password VARCHAR(512) NOT NULL COMMENT '登入密碼',
  c_name VARCHAR(40) NOT NULL COMMENT '客戶名稱',
  c_tel VARCHAR(16) DEFAULT NULL COMMENT '電話',
  c_id VARCHAR(10) NOT NULL COMMENT '統一編號',
  c_suspended INT NOT NULL DEFAULT 0,
  PRIMARY KEY (c_index), UNIQUE KEY c_account (c_account)
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb4 COMMENT='廠商';

CREATE TABLE IF NOT EXISTS goods (
  s_index INT NOT NULL AUTO_INCREMENT,
  s_barcode VARCHAR(20) NOT NULL COMMENT '商品條碼',
  s_goodname VARCHAR(50) NOT NULL COMMENT '商品名稱',
  s_unit VARCHAR(10) DEFAULT NULL COMMENT '單位',
  PRIMARY KEY (s_index), KEY s_barcode (s_barcode), KEY s_goodname (s_goodname), KEY s_unit (s_unit)
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS \`order\` (
  o_index INT NOT NULL AUTO_INCREMENT COMMENT '訂購單號',
  o_date DATE NOT NULL COMMENT '訂購日期',
  o_hour VARCHAR(2) NOT NULL, o_minute VARCHAR(2) NOT NULL, o_seconds VARCHAR(2) NOT NULL,
  c_index INT NOT NULL COMMENT '客戶流水號(customer)',
  status TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1表示已匯出，不可修改',
  PRIMARY KEY (o_index), KEY ci_index (c_index), KEY idx_orderflow_order_date_status (o_date,status)
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS detail (
  d_id INT NOT NULL AUTO_INCREMENT COMMENT '流水號',
  o_index INT NOT NULL, s_index INT NOT NULL,
  d_date VARCHAR(10) NOT NULL, d_hour VARCHAR(2) NOT NULL, d_minute VARCHAR(2) NOT NULL, d_seconds VARCHAR(2) NOT NULL,
  c_index INT NOT NULL, o_quantity VARCHAR(11) NOT NULL, o_note VARCHAR(255) DEFAULT NULL,
  PRIMARY KEY (d_id), KEY oi_index (o_index), KEY si_index (s_index)
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS roots (
  account VARCHAR(255) NOT NULL, password VARCHAR(255) NOT NULL, PRIMARY KEY (account)
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb4 COMMENT='開發者';

CREATE TABLE IF NOT EXISTS timer (
  time_id INT NOT NULL AUTO_INCREMENT, hour VARCHAR(2) NOT NULL, minute VARCHAR(2) NOT NULL,
  seconds VARCHAR(2) NOT NULL, status INT NOT NULL,
  PRIMARY KEY (time_id)
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO customer (c_index,c_custno,c_account,c_password,c_name,c_tel,c_id,c_suspended)
VALUES (1,'DEMO','demo','test123','測試客戶',NULL,'00000000',0);
INSERT IGNORE INTO goods (s_index,s_barcode,s_goodname,s_unit) VALUES
  (1,'4719585678958','測試商品 A','個'),
  (2,'4710088432415','測試商品 B','盒'),
  (3,'4902430781026','測試商品 C','組');
INSERT IGNORE INTO timer (time_id,hour,minute,seconds,status) VALUES (1,'24','00','00',2);
