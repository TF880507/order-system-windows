package tw.com.isunfar.orderapp;

import android.app.Activity;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.ImageFormat;
import android.graphics.Paint;
import android.graphics.SurfaceTexture;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.media.Image;
import android.media.ImageReader;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.view.Gravity;
import android.view.Surface;
import android.view.TextureView;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.TextView;

import com.google.zxing.BinaryBitmap;
import com.google.zxing.BarcodeFormat;
import com.google.zxing.DecodeHintType;
import com.google.zxing.LuminanceSource;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.Result;
import com.google.zxing.common.GlobalHistogramBinarizer;
import com.google.zxing.common.HybridBinarizer;

import java.nio.ByteBuffer;
import java.util.Arrays;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

public class ScannerActivity extends Activity {
    public static final String EXTRA_BARCODE = "barcode";
    public static final String EXTRA_FORMAT = "format";
    public static final String EXTRA_ERROR = "error";

    private TextureView preview;
    private HandlerThread cameraThread;
    private Handler cameraHandler;
    private CameraDevice camera;
    private CameraCaptureSession session;
    private ImageReader imageReader;
    private final MultiFormatReader barcodeReader = new MultiFormatReader();
    private final AtomicBoolean decoding = new AtomicBoolean(false);
    private volatile boolean finished;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        configureBarcodeReader();
        buildInterface();
    }

    private void configureBarcodeReader() {
        List<BarcodeFormat> formats = Arrays.asList(
            BarcodeFormat.QR_CODE,
            BarcodeFormat.EAN_13,
            BarcodeFormat.EAN_8,
            BarcodeFormat.UPC_A,
            BarcodeFormat.UPC_E,
            BarcodeFormat.CODE_39,
            BarcodeFormat.CODE_93,
            BarcodeFormat.CODE_128,
            BarcodeFormat.ITF,
            BarcodeFormat.CODABAR,
            BarcodeFormat.DATA_MATRIX,
            BarcodeFormat.PDF_417,
            BarcodeFormat.AZTEC
        );
        Map<DecodeHintType, Object> hints = new EnumMap<DecodeHintType, Object>(DecodeHintType.class);
        hints.put(DecodeHintType.POSSIBLE_FORMATS, formats);
        hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
        hints.put(DecodeHintType.CHARACTER_SET, "UTF-8");
        barcodeReader.setHints(hints);
    }

    private void buildInterface() {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        preview = new TextureView(this);
        root.addView(preview, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(new ScanOverlay(this), new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        TextView instruction = new TextView(this);
        instruction.setText("將商品條碼或 QR Code 對準掃描框\n支援 EAN-13；請保持穩定並避免反光");
        instruction.setTextColor(Color.WHITE);
        instruction.setTextSize(18);
        instruction.setGravity(Gravity.CENTER);
        instruction.setBackgroundColor(0x99000000);
        instruction.setPadding(dp(18), dp(14), dp(18), dp(14));
        FrameLayout.LayoutParams instructionParams = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM);
        instructionParams.setMargins(dp(18), 0, dp(18), dp(28));
        root.addView(instruction, instructionParams);

        Button close = new Button(this);
        close.setText("關閉");
        close.setTextSize(16);
        close.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View view) { cancelScan(); }
        });
        FrameLayout.LayoutParams closeParams = new FrameLayout.LayoutParams(dp(92), dp(52), Gravity.TOP | Gravity.END);
        closeParams.setMargins(0, dp(22), dp(18), 0);
        root.addView(close, closeParams);
        setContentView(root);

        preview.setSurfaceTextureListener(new TextureView.SurfaceTextureListener() {
            @Override public void onSurfaceTextureAvailable(SurfaceTexture texture, int width, int height) { openCamera(); }
            @Override public void onSurfaceTextureSizeChanged(SurfaceTexture texture, int width, int height) {}
            @Override public boolean onSurfaceTextureDestroyed(SurfaceTexture texture) { return true; }
            @Override public void onSurfaceTextureUpdated(SurfaceTexture texture) {}
        });
    }

    @Override protected void onResume() {
        super.onResume();
        cameraThread = new HandlerThread("barcode-camera");
        cameraThread.start();
        cameraHandler = new Handler(cameraThread.getLooper());
        if (preview.isAvailable()) openCamera();
    }

    @Override protected void onPause() {
        closeCamera();
        if (cameraThread != null) {
            cameraThread.quitSafely();
            try { cameraThread.join(); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
            cameraThread = null;
            cameraHandler = null;
        }
        super.onPause();
    }

    private void openCamera() {
        if (camera != null || cameraHandler == null) return;
        CameraManager manager = (CameraManager) getSystemService(CAMERA_SERVICE);
        try {
            String cameraId = chooseBackCamera(manager);
            if (cameraId == null) { fail("此裝置找不到可用相機"); return; }
            CameraCharacteristics characteristics = manager.getCameraCharacteristics(cameraId);
            StreamConfigurationMap map = characteristics.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
            if (map == null) { fail("無法取得相機掃描格式"); return; }
            android.util.Size size = chooseSize(map.getOutputSizes(ImageFormat.YUV_420_888));
            imageReader = ImageReader.newInstance(size.getWidth(), size.getHeight(), ImageFormat.YUV_420_888, 2);
            imageReader.setOnImageAvailableListener(new ImageReader.OnImageAvailableListener() {
                @Override public void onImageAvailable(ImageReader reader) { decodeImage(reader); }
            }, cameraHandler);
            manager.openCamera(cameraId, new CameraDevice.StateCallback() {
                @Override public void onOpened(CameraDevice device) { camera = device; createSession(); }
                @Override public void onDisconnected(CameraDevice device) { device.close(); camera = null; fail("相機連線中斷"); }
                @Override public void onError(CameraDevice device, int error) { device.close(); camera = null; fail("無法啟動相機"); }
            }, cameraHandler);
        } catch (SecurityException error) {
            fail("沒有相機權限");
        } catch (CameraAccessException error) {
            fail("相機目前無法使用");
        }
    }

    private String chooseBackCamera(CameraManager manager) throws CameraAccessException {
        String fallback = null;
        for (String id : manager.getCameraIdList()) {
            if (fallback == null) fallback = id;
            Integer facing = manager.getCameraCharacteristics(id).get(CameraCharacteristics.LENS_FACING);
            if (facing != null && facing == CameraCharacteristics.LENS_FACING_BACK) return id;
        }
        return fallback;
    }

    private android.util.Size chooseSize(android.util.Size[] sizes) {
        if (sizes == null || sizes.length == 0) return new android.util.Size(1280, 720);
        android.util.Size best = sizes[0];
        long targetArea = 1280L * 720L;
        long bestScore = Long.MAX_VALUE;
        for (android.util.Size size : sizes) {
            long area = (long) size.getWidth() * size.getHeight();
            if (size.getWidth() <= 1920 && size.getHeight() <= 1080) {
                long score = Math.abs(area - targetArea);
                long ratioError = Math.abs((long) size.getWidth() * 9L - (long) size.getHeight() * 16L);
                score += ratioError * 100L;
                if (score >= bestScore) continue;
                best = size;
                bestScore = score;
            }
        }
        return best;
    }

    private void createSession() {
        if (camera == null || imageReader == null || !preview.isAvailable()) return;
        try {
            SurfaceTexture texture = preview.getSurfaceTexture();
            texture.setDefaultBufferSize(imageReader.getWidth(), imageReader.getHeight());
            Surface previewSurface = new Surface(texture);
            CaptureRequest.Builder request = camera.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
            request.addTarget(previewSurface);
            request.addTarget(imageReader.getSurface());
            request.set(CaptureRequest.CONTROL_MODE, CaptureRequest.CONTROL_MODE_AUTO);
            request.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
            request.set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_ON);
            request.set(CaptureRequest.CONTROL_AWB_MODE, CaptureRequest.CONTROL_AWB_MODE_AUTO);
            camera.createCaptureSession(Arrays.asList(previewSurface, imageReader.getSurface()), new CameraCaptureSession.StateCallback() {
                @Override public void onConfigured(CameraCaptureSession captureSession) {
                    session = captureSession;
                    try { captureSession.setRepeatingRequest(request.build(), null, cameraHandler); }
                    catch (CameraAccessException error) { fail("無法開始相機預覽"); }
                }
                @Override public void onConfigureFailed(CameraCaptureSession captureSession) { fail("無法建立相機預覽"); }
            }, cameraHandler);
        } catch (CameraAccessException error) {
            fail("無法建立相機預覽");
        }
    }

    private void decodeImage(ImageReader reader) {
        Image image = reader.acquireLatestImage();
        if (image == null) return;
        if (!decoding.compareAndSet(false, true)) { image.close(); return; }
        try {
            Image.Plane plane = image.getPlanes()[0];
            ByteBuffer buffer = plane.getBuffer();
            int width = image.getWidth();
            int height = image.getHeight();
            int rowStride = plane.getRowStride();
            int pixelStride = plane.getPixelStride();
            int bufferStart = buffer.position();
            byte[] luminance = new byte[width * height];
            for (int row = 0; row < height; row++) {
                int rowStart = bufferStart + row * rowStride;
                for (int column = 0; column < width; column++) luminance[row * width + column] = buffer.get(rowStart + column * pixelStride);
            }
            PlanarYUVLuminanceSource full = new PlanarYUVLuminanceSource(luminance, width, height, 0, 0, width, height, false);
            Result result = tryDecodeAllOrientations(full);
            if (result == null && full.isCropSupported()) {
                int cropLeft = width / 12;
                int cropTop = height / 6;
                result = tryDecodeAllOrientations(full.crop(cropLeft, cropTop, width - cropLeft * 2, height - cropTop * 2));
            }
            if (result != null && !finished) finishWithResult(result);
        } finally {
            image.close();
            barcodeReader.reset();
            decoding.set(false);
        }
    }

    private Result tryDecodeAllOrientations(LuminanceSource source) {
        LuminanceSource current = source;
        for (int rotation = 0; rotation < 4; rotation++) {
            Result result = tryDecode(current);
            if (result != null) return result;
            if (!current.isRotateSupported()) break;
            current = current.rotateCounterClockwise();
        }
        return null;
    }

    private Result tryDecode(LuminanceSource source) {
        Result result = decodeBitmap(new BinaryBitmap(new HybridBinarizer(source)));
        if (result != null) return result;
        result = decodeBitmap(new BinaryBitmap(new GlobalHistogramBinarizer(source)));
        if (result != null) return result;
        LuminanceSource inverted = source.invert();
        result = decodeBitmap(new BinaryBitmap(new HybridBinarizer(inverted)));
        if (result != null) return result;
        return decodeBitmap(new BinaryBitmap(new GlobalHistogramBinarizer(inverted)));
    }

    private Result decodeBitmap(BinaryBitmap bitmap) {
        try { return barcodeReader.decodeWithState(bitmap); }
        catch (Exception ignored) { barcodeReader.reset(); return null; }
    }

    private void finishWithResult(Result result) {
        finished = true;
        runOnUiThread(new Runnable() {
            @Override public void run() {
                android.content.Intent data = new android.content.Intent();
                data.putExtra(EXTRA_BARCODE, result.getText());
                data.putExtra(EXTRA_FORMAT, result.getBarcodeFormat().toString());
                setResult(RESULT_OK, data);
                finish();
            }
        });
    }

    private void fail(String message) {
        if (finished) return;
        finished = true;
        runOnUiThread(new Runnable() {
            @Override public void run() {
                android.content.Intent data = new android.content.Intent();
                data.putExtra(EXTRA_ERROR, message);
                setResult(RESULT_CANCELED, data);
                finish();
            }
        });
    }

    private void cancelScan() { setResult(RESULT_CANCELED); finish(); }
    @Override public void onBackPressed() { cancelScan(); }
    private void closeCamera() {
        if (session != null) { session.close(); session = null; }
        if (camera != null) { camera.close(); camera = null; }
        if (imageReader != null) { imageReader.close(); imageReader = null; }
    }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }

    private static final class ScanOverlay extends View {
        private final Paint shade = new Paint();
        private final Paint border = new Paint();
        ScanOverlay(android.content.Context context) {
            super(context);
            shade.setColor(0x88000000);
            border.setColor(Color.WHITE);
            border.setStyle(Paint.Style.STROKE);
            border.setStrokeWidth(5);
        }
        @Override protected void onDraw(Canvas canvas) {
            super.onDraw(canvas);
            float margin = getWidth() * .10f;
            float top = getHeight() * .27f;
            float bottom = getHeight() * .63f;
            canvas.drawRect(0, 0, getWidth(), top, shade);
            canvas.drawRect(0, bottom, getWidth(), getHeight(), shade);
            canvas.drawRect(0, top, margin, bottom, shade);
            canvas.drawRect(getWidth() - margin, top, getWidth(), bottom, shade);
            canvas.drawRoundRect(margin, top, getWidth() - margin, bottom, 18, 18, border);
        }
    }
}
