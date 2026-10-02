package tw.com.isunfar.orderapp;

import android.Manifest;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.URLUtil;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;
import org.json.JSONObject;

public class MainActivity extends Activity {
    private static final String APP_URL = "http://72.62.75.119:4000/";
    private static final int STORAGE_PERMISSION_REQUEST = 42;
    private static final int CAMERA_PERMISSION_REQUEST = 43;
    private static final int BARCODE_SCAN_REQUEST = 44;
    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.rgb(34, 42, 64));

        webView = new WebView(this);
        webView.setFocusable(true);
        webView.setFocusableInTouchMode(true);
        webView.addJavascriptInterface(new AndroidScannerBridge(), "AndroidScanner");
        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return openUrl(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return openUrl(Uri.parse(url));
            }
        });

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setSupportZoom(false);
        settings.setUserAgentString(settings.getUserAgentString() + " HaoShiJiOrderApp/2.0 AndroidCameraScanner");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        }

        CookieManager.getInstance().setAcceptCookie(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);
        }
        webView.setDownloadListener(new AppDownloadListener());
        setContentView(webView);

        if (savedInstanceState == null) webView.loadUrl(APP_URL);
        else webView.restoreState(savedInstanceState);
    }

    private boolean openUrl(Uri uri) {
        String url = uri.toString();
        if (url.startsWith(APP_URL)) return false;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (Exception error) {
            Toast.makeText(this, "無法開啟連結", Toast.LENGTH_SHORT).show();
        }
        return true;
    }

    public final class AndroidScannerBridge {
        @JavascriptInterface
        public void scanBarcode() {
            runOnUiThread(new Runnable() {
                @Override public void run() { startBarcodeScanner(); }
            });
        }
    }

    private void startBarcodeScanner() {
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.CAMERA}, CAMERA_PERMISSION_REQUEST);
            return;
        }
        startActivityForResult(new Intent(this, ScannerActivity.class), BARCODE_SCAN_REQUEST);
    }

    private void notifyScanError(String message) {
        if (webView == null) return;
        webView.evaluateJavascript("window.handleNativeBarcodeScanError && window.handleNativeBarcodeScanError(" + JSONObject.quote(message) + ")", null);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == CAMERA_PERMISSION_REQUEST) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) startBarcodeScanner();
            else notifyScanError("未取得相機權限，請到 Android 設定允許相機後再試");
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != BARCODE_SCAN_REQUEST) return;
        if (resultCode == RESULT_OK && data != null) {
            String value = data.getStringExtra(ScannerActivity.EXTRA_BARCODE);
            String format = data.getStringExtra(ScannerActivity.EXTRA_FORMAT);
            webView.evaluateJavascript("window.handleNativeBarcodeScan && window.handleNativeBarcodeScan(" + JSONObject.quote(value) + "," + JSONObject.quote(format) + ")", null);
        } else if (data != null && data.hasExtra(ScannerActivity.EXTRA_ERROR)) {
            notifyScanError(data.getStringExtra(ScannerActivity.EXTRA_ERROR));
        } else {
            notifyScanError("");
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        webView.saveState(outState);
        super.onSaveInstanceState(outState);
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.loadUrl("about:blank");
            webView.destroy();
        }
        super.onDestroy();
    }

    private final class AppDownloadListener implements DownloadListener {
        @Override
        public void onDownloadStart(String url, String userAgent, String contentDisposition, String mimeType, long contentLength) {
            if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P && checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, STORAGE_PERMISSION_REQUEST);
                Toast.makeText(MainActivity.this, "請允許儲存權限後再按一次匯出", Toast.LENGTH_LONG).show();
                return;
            }
            try {
                String filename = URLUtil.guessFileName(url, contentDisposition, mimeType);
                DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
                request.addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url));
                request.addRequestHeader("User-Agent", userAgent);
                request.setMimeType(mimeType);
                request.setTitle(filename);
                request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, filename);
                ((DownloadManager) getSystemService(DOWNLOAD_SERVICE)).enqueue(request);
                Toast.makeText(MainActivity.this, "檔案將儲存到下載資料夾", Toast.LENGTH_LONG).show();
            } catch (Exception error) {
                Toast.makeText(MainActivity.this, "下載失敗，請稍後再試", Toast.LENGTH_LONG).show();
            }
        }
    }
}
