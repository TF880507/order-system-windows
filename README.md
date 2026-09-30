# 訂單管理系統（Windows 開發版）

這是一個低資源、可直接延伸開發的 Web 系統起始專案，包含：

- 首頁、會員登入、訂單工作台
- USB HID 掃碼器／QR Code 掃描輸入
- 手動輸入商品條碼
- 建立訂單與每日訂單查詢
- 每日結單排程、手動 Excel 匯出與執行紀錄
- Node.js API 與客戶既有 MySQL 資料庫
- 響應式桌機／平板／手機畫面

## Windows 安裝

1. 安裝 Docker Desktop：https://www.docker.com/products/docker-desktop/
2. 解壓縮或複製本資料夾到 Windows。
3. 雙擊 `docker-start.bat`。
4. Chrome 開啟 `http://localhost:4000`。

若要不使用 Docker 開發，請先準備 MySQL、匯入客戶資料庫備份並設定 `MYSQL_*` 環境變數，再執行 `install.bat` 與 `start.bat`。

也可以使用 PowerShell：

```powershell
npm install
npm run dev
```

## Docker / VPS 部署

Docker 對外使用 port `4000`，容器內仍使用 port `3000`。Compose 的本機開發環境會同時啟動 Web 系統與 MySQL，資料保存在 Docker volume `mysql_data`。測試完成、正式上線前，請修改 `.env` 裡的管理員及資料庫密碼。

```bash
cp .env.example .env
docker compose up -d --build
```

目前 VPS 外部測試端點為 `http://72.62.75.119:4000`。正式環境仍建議為 OrderFlow 使用獨立網域並透過 HTTPS 反向代理轉送。USB 掃碼器接在使用者的電腦即可：它以鍵盤方式將條碼輸入已開啟的瀏覽器，不需要接到 VPS。

## 測試登入資料

- 帳號：`admin`
- 密碼：`test123`

正式使用前，請以環境變數 `ADMIN_PASSWORD` 設定首次初始化密碼。管理員帳號建立後，重新啟動不會覆寫既有密碼。

## 測試商品條碼

- `4719585678958`
- `4710088432415`
- `4902430781026`

## USB 掃碼器設定

建議使用支援 QR Code／一維條碼的 USB 掃碼器，設定為：

- USB HID Keyboard（鍵盤）模式
- 掃描結尾字元：Enter／CR
- 鍵盤語系：依 Windows 使用環境設定

### XB-R20 使用方式

1. 將掃碼器接上 USB，使用 USB HID Keyboard 模式，Windows 切換成英文輸入法。
2. 登入後開啟「訂單工作台 → 掃描 QR Code」，系統會自動聚焦掃碼接收欄。
3. 掃描商品條碼或內容為商品條碼的 QR Code。支援 Enter／CR、Tab 結尾；沒有結尾字元時，停止輸入約 300ms 後查詢。
4. 找到商品後顯示名稱、條碼、規格。確認數量、備註，再按「加入訂單」。掃描本身不會建立訂單。
5. 建立成功後清空表單並回到掃碼接收欄。只想換掃商品時，保持接收欄焦點即可，下一次掃描會取代上一筆條碼。
6. 若已點進數量、備註或其他位置，先點「繼續掃描」。請不要直接對著數量或備註欄掃描。

瀏覽器必須在前景且接收欄取得焦點。頁面的「等待掃描」表示接收欄可輸入，並非 USB 裝置連線偵測。USB-HID 鍵盤模式不需要瀏覽器外掛或 WebUSB 授權。

查無商品時會停用「加入訂單」，請確認商品已建檔後重掃；也可以按「查詢條碼」重試。QR Code 若裝的是網址或 JSON 而非商品條碼，不會自動解析成商品。目前資料庫僅預建上述三筆測試商品，實際商品需先建檔。

程式測試：`npm test`。實機驗收請掃描上述測試條碼，確認畫面顯示商品，再以另一條碼重掃，並確認修改數量與備註後能正常建立訂單。

## 資料位置

MySQL 本機開發資料保存在 Docker volume `mysql_data`。可使用 `docker compose exec mysql mysqldump` 建立備份。客戶正式資料庫不會包進Git或ZIP。

## 商品管理

以系統管理員帳號登入後，左側會顯示「商品管理」。開啟頁面後，USB 掃碼器可直接將條碼帶入「商品條碼」欄；掃描後填寫名稱和選填規格並儲存，該條碼立即可供 USB 掃碼器與「手動輸入條碼」查詢、建立訂單使用。

正式多人使用時建議以 `mysqldump` 定期自動備份 MySQL，並定期演練還原。

## 排程與匯出

系統管理員登入後可進入「排程與匯出」。排程直接讀寫客戶原有 `timer` 表；`24:00:00` 會正規化為台北時間隔日 `00:00`。執行時將前一日 `order.status` 設為 `1`，代表已匯出且不可修改，並保存真正的 `.xlsx` Excel檔。MySQL named lock 可避免多個 Web程序重複執行。

- 手動匯出：建立所選日期的即時快照，不鎖定訂單。
- 立即結單：產生匯出檔並永久鎖定所選日期；請確認後再使用。
- 歷史訂單：跨日後顯示「已鎖定」，只能查詢。
- 匯出檔：`.xlsx`，含營業日、訂單編號、建立時間、客戶、商品、單位、數量、備註與狀態。

## 客戶資料庫串接

系統直接對應客戶備份中的 `customer`、`goods`、`order`、`detail`、`administrator` 與 `timer`。啟動時只新增名稱為 `orderflow_*` 的登入Session、匯出紀錄與結單紀錄表，不刪除或重建舊資料。詳細欄位用途請看 `CUSTOMER_DATABASE_MAPPING.md`。

客戶正式MySQL若只允許 `localhost`，部署在其他VPS的Web服務無法直接連線；主機商必須為VPS固定IP建立白名單並啟用TLS。程式預設拒絕未加密的遠端MySQL，避免帳密與訂單資料在網際網路上裸傳。請先使用資料庫副本驗證，不要直接拿正式庫測試。

目前客戶MariaDB的外部3306可到達，但實測不支援TLS；因此不可直接由外部VPS安全上線。可行方案是由主機商開啟MySQL TLS／VPN，或將後端改成可在客戶虛擬主機內透過 `localhost` 執行的PHP版本。

舊客戶密碼多數是舊版CodeIgniter可逆加密內容。沒有舊站 `application/config/config.php` 的 `encryption_key` 時，無法完整驗證全部舊密碼。管理員可在「客戶管理」為個別客戶設定新系統密碼；新密碼以bcrypt保存於獨立的 `orderflow_accounts`，不覆寫舊站密碼。

## 專案結構

```text
order-system-windows/
├─ public/
│  ├─ index.html       # 網頁結構
│  ├─ styles.css       # 畫面樣式
│  └─ app.js           # 前端功能與掃碼處理
├─ mysql-init/         # 無客戶資料的本機測試結構
├─ compose.yaml        # Web 與 MySQL 容器
├─ schedule.js         # 台北營業日工具
├─ server.js           # API、登入、資料庫結構
├─ package.json
├─ 安裝套件.bat
└─ 啟動系統.bat
```

## 上線前必要工作

- 修改初始管理員密碼
- 加入登入失敗次數限制與稽核紀錄
- 使用 HTTPS 與反向代理
- 建立資料庫備份及還原流程
- 使用實際掃碼器測試字尾 Enter、中文輸入法及連續掃描
