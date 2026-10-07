(function exposeCameraScanner(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CameraScanner = api;
}(typeof window !== 'undefined' ? window : globalThis, (root) => {
  function createBrowserCameraScanner({ video, onResult, onStatus, onError }) {
    let controls = null;
    let starting = false;
    let handlingResult = false;

    function stop() {
      controls?.stop?.();
      controls = null;
      starting = false;
      handlingResult = false;
      const stream = video?.srcObject;
      if (stream?.getTracks) stream.getTracks().forEach((track) => track.stop());
      if (video) {
        video.pause?.();
        video.srcObject = null;
      }
    }

    async function start() {
      if (starting || controls) return;
      if (!root.ZXingBrowser?.BrowserMultiFormatReader) {
        throw new Error('掃碼元件尚未載入，請重新整理頁面。');
      }
      starting = true;
      handlingResult = false;
      onStatus?.('正在啟動相機…');
      const reader = new root.ZXingBrowser.BrowserMultiFormatReader(undefined, {
        delayBetweenScanAttempts: 80,
        delayBetweenScanSuccess: 500
      });
      try {
        controls = await reader.decodeFromConstraints({
          audio: false,
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 }
          }
        }, video, (result, error, activeControls) => {
          if (result && !handlingResult) {
            handlingResult = true;
            const value = String(result.getText?.() || '').trim();
            const format = String(result.getBarcodeFormat?.() || '');
            activeControls?.stop?.();
            controls = null;
            if (value) Promise.resolve(onResult?.(value, format)).catch(onError);
            else handlingResult = false;
            return;
          }
          const errorName = String(error?.name || '');
          if (error && !/NotFoundException|ChecksumException|FormatException/.test(errorName)) onError?.(error);
        });
        onStatus?.('請將條碼完整放入掃描框內');
      } catch (error) {
        stop();
        throw error;
      } finally {
        starting = false;
      }
    }

    return { start, stop, isRunning: () => Boolean(starting || controls) };
  }

  return { createBrowserCameraScanner };
}));
