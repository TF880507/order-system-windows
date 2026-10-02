# 好市吉 App Android 包裝

這個 APK 使用原生 Android WebView 開啟 `http://72.62.75.119:4000/`。3.0 版改善原生相機在不同方向、反相條碼、螢幕條碼及 EAN-13 商品條碼的辨識；支援 QR Code、EAN、UPC、Code 39、Code 93、Code 128、ITF 與 Codabar。掃描結果會交給和 Windows USB 掃碼器相同的商品查詢及下單流程。CSV 匯出會下載到 Android 的「下載」資料夾。

第一次使用相機掃描時會要求 Android 相機權限。APK 支援 Android 6.0 以上，並沿用既有簽章，可直接覆蓋更新。

APK 套件名稱：`tw.com.isunfar.orderapp`

Windows 可執行 `build-apk.ps1`，macOS/Linux 可執行 `build-apk.sh`。兩者使用本機 Android SDK 的 `aapt2`、`d8`、`zipalign` 與 `apksigner` 直接建置，不需要 Android Studio 專案或第三方 APK 服務。簽章金鑰保存在 `signing/`，該目錄不會提交到 Git；後續更新 APK 必須沿用相同金鑰。
