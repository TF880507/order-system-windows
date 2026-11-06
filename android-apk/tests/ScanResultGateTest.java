import tw.com.isunfar.orderapp.ScanResultGate;
import com.google.zxing.*;

public class ScanResultGateTest {
    static Result result(String text, BarcodeFormat format) { return new Result(text, null, null, format); }
    static void check(boolean condition) { if (!condition) throw new AssertionError("Confirmation failed"); }
    public static void main(String[] args) {
        Result good = result("4711467263544", BarcodeFormat.EAN_13);
        Result wrong = result("1118467263544", BarcodeFormat.EAN_13);
        ScanResultGate gate = new ScanResultGate();
        check(!gate.accept(wrong, 1000));
        check(!gate.accept(good, 1120));
        check(gate.accept(good, 1240));
        gate = new ScanResultGate();
        check(!gate.accept(good, 1000));
        check(!gate.accept(good, 3000));
        check(gate.accept(good, 3120));
        gate = new ScanResultGate();
        check(!gate.accept(good, 1000));
        check(!gate.accept(result(good.getText(), BarcodeFormat.CODE_128), 1120));
        check(!gate.accept(good, 1240));
        check(gate.accept(good, 1360));
        check(!new ScanResultGate().accept(null, 0));
        System.out.println("PASS wrong-first-frame, stable-pair, expiry, format-change and null-result cases");
    }
}
