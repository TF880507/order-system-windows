# 好市吉 App Android 包裝

這個 APK 使用原生 Android WebView 開啟 `http://72.62.75.119:4000/`。USB／藍牙 HID 掃碼器會以鍵盤輸入方式直接交給網頁，CSV 匯出會下載到 Android 的「下載」資料夾。

APK 套件名稱：`tw.com.isunfar.orderapp`

`build-apk.ps1` 使用本機 Android SDK 的 `aapt2`、`d8`、`zipalign` 與 `apksigner` 直接建置，不需要 Android Studio 專案或第三方 APK 服務。簽章金鑰保存在 `signing/`，該目錄不會提交到 Git；後續更新 APK 必須沿用相同金鑰。
