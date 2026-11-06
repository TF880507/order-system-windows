import tw.com.isunfar.orderapp.BarcodeDecoder;
import com.google.zxing.*;
import com.google.zxing.common.BitMatrix;
import java.awt.image.BufferedImage;
import javax.imageio.ImageIO;
import java.io.File;
import java.util.Arrays;

public class BarcodeDecoderTest {
    static int passed;
    static void verify(byte[] data, int width, int height, String expected) {
        BarcodeDecoder decoder = new BarcodeDecoder();
        for (int i = 0; i < 24; i++) {
            Result result = decoder.decode(data, width, height);
            if (result != null) {
                if (!expected.equals(result.getText())) throw new AssertionError("Expected " + expected + ", got " + result.getText());
                passed++;
                return;
            }
        }
        throw new AssertionError("Could not decode " + expected);
    }

    public static void main(String[] args) throws Exception {
        String[] codes = {"4711467263544", "4714711366695", "4713697605668", "4711049230070", "ABC-123", "12345678901234", "QR-product-123"};
        BarcodeFormat[] formats = {BarcodeFormat.EAN_13, BarcodeFormat.EAN_13, BarcodeFormat.EAN_13,
            BarcodeFormat.EAN_13, BarcodeFormat.CODE_128, BarcodeFormat.ITF, BarcodeFormat.QR_CODE};
        for (int index = 0; index < codes.length; index++) {
            int width = 1280, height = 720;
            BitMatrix barcode = new MultiFormatWriter().encode(codes[index], formats[index],
                formats[index] == BarcodeFormat.QR_CODE ? 300 : 700, 300);
            byte[] data = new byte[width * height];
            Arrays.fill(data, (byte) 255);
            for (int y = 0; y < barcode.getHeight(); y++) {
                for (int x = 0; x < barcode.getWidth(); x++) data[(y + 210) * width + x + 290] = (byte) (barcode.get(x, y) ? 0 : 255);
            }
            verify(data, width, height, codes[index]);
            byte[] turned = new byte[data.length];
            for (int y = 0; y < height; y++) for (int x = 0; x < width; x++) turned[x * height + height - 1 - y] = data[y * width + x];
            verify(turned, height, width, codes[index]);
            for (int i = 0; i < data.length; i++) data[i] = (byte) (255 - (data[i] & 255));
            verify(data, width, height, codes[index]);
        }
        // Optional real customer photos, provided as path/expected pairs.
        for (int i = 0; i < args.length; i += 2) {
            BufferedImage photo = ImageIO.read(new File(args[i]));
            int width = photo.getWidth(), height = photo.getHeight();
            byte[] data = new byte[width * height];
            for (int y = 0; y < height; y++) for (int x = 0; x < width; x++) {
                int rgb = photo.getRGB(x, y);
                data[y * width + x] = (byte) ((((rgb >> 16) & 255) + 2 * ((rgb >> 8) & 255) + (rgb & 255)) / 4);
            }
            verify(data, width, height, args[i + 1]);
        }
        BarcodeDecoder decoder = new BarcodeDecoder();
        byte[] blank = new byte[1280 * 720];
        Arrays.fill(blank, (byte) 180);
        long start = System.nanoTime();
        for (int i = 0; i < 120; i++) {
            if (decoder.decode(blank, 1280, 720) != null) throw new AssertionError("Blank frame decoded");
        }
        System.out.println("PASS " + passed + " decode scenarios; blank-frame mean " + ((System.nanoTime() - start) / 120000000.0) + " ms (host CPU, not device FPS)");
    }
}
