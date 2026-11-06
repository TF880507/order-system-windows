package tw.com.isunfar.orderapp;

import com.google.zxing.*;
import com.google.zxing.common.GlobalHistogramBinarizer;
import com.google.zxing.common.HybridBinarizer;
import java.util.Arrays;
import java.util.EnumMap;
import java.util.Map;

/** One worker, one frame at a time. Spread fallback work across frames, never queue it. */
public final class BarcodeDecoder {
    private final MultiFormatReader linear = new MultiFormatReader();
    private final MultiFormatReader linearFallback = new MultiFormatReader();
    private final MultiFormatReader matrix = new MultiFormatReader();
    private int frame;
    private byte[] rotated;

    public BarcodeDecoder() {
        Map<DecodeHintType, Object> linearHints = hints(BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A,
            BarcodeFormat.UPC_E, BarcodeFormat.CODE_39, BarcodeFormat.CODE_93,
            BarcodeFormat.CODE_128, BarcodeFormat.ITF, BarcodeFormat.CODABAR);
        linear.setHints(linearHints);
        Map<DecodeHintType, Object> fallbackHints = new EnumMap<>(linearHints);
        fallbackHints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
        linearFallback.setHints(fallbackHints);
        matrix.setHints(hints(BarcodeFormat.QR_CODE, BarcodeFormat.DATA_MATRIX,
            BarcodeFormat.PDF_417, BarcodeFormat.AZTEC));
    }

    private static Map<DecodeHintType, Object> hints(BarcodeFormat... formats) {
        Map<DecodeHintType, Object> hints = new EnumMap<>(DecodeHintType.class);
        hints.put(DecodeHintType.POSSIBLE_FORMATS, Arrays.asList(formats));
        hints.put(DecodeHintType.ASSUME_GS1, Boolean.TRUE);
        hints.put(DecodeHintType.CHARACTER_SET, "UTF-8");
        return hints;
    }

    public Result decode(byte[] data, int width, int height) {
        int step = frame++ % 24;
        // Alternate sensor directions. ZXing handles the reverse row direction itself.
        if ((step & 1) != 0) {
            if (rotated == null || rotated.length != data.length) rotated = new byte[data.length];
            for (int y = 0; y < height; y++) {
                for (int x = 0; x < width; x++) rotated[x * height + height - 1 - y] = data[y * width + x];
            }
            data = rotated;
            int originalWidth = width;
            width = height;
            height = originalWidth;
        }
        PlanarYUVLuminanceSource full = new PlanarYUVLuminanceSource(data, width, height, 0, 0, width, height, false);
        int region = (step / 2) % 3;
        int left = region == 0 ? width / 10 : region == 1 ? width / 32 : 0;
        int top = region == 0 ? height / 4 : region == 1 ? height / 7 : 0;
        LuminanceSource source = full.crop(left, top, width - 2 * left, height - 2 * top);
        if (step >= 12) source = source.invert();
        // At most two reader calls per frame, instead of 40 exhaustive passes.
        Result result = read(source, linear, step % 4 < 2);
        // Deep row search only on full-frame slots. Keep it off the usual preview path.
        if (result == null) result = read(source, region == 2 ? linearFallback : matrix, true);
        return result;
    }

    private Result read(LuminanceSource source, MultiFormatReader reader, boolean hybrid) {
        try {
            return reader.decodeWithState(new BinaryBitmap(hybrid
                ? new HybridBinarizer(source) : new GlobalHistogramBinarizer(source)));
        } catch (ReaderException miss) {
            return null;
        } finally {
            reader.reset();
        }
    }
}
