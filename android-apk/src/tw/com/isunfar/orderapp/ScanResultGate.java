package tw.com.isunfar.orderapp;

import com.google.zxing.Result;

/** Confirm identical text AND format from separate frames before leaving the camera. */
public final class ScanResultGate {
    private String text;
    private Object format;
    private long firstSeen;
    private int matches;

    public boolean accept(Result result, long now) {
        if (result == null || result.getText() == null || result.getText().isEmpty()) return false;
        if (!result.getText().equals(text) || result.getBarcodeFormat() != format
                || now < firstSeen || now - firstSeen > 1800) {
            text = result.getText();
            format = result.getBarcodeFormat();
            firstSeen = now;
            matches = 1;
            return false;
        }
        return ++matches >= 2;
    }
}
