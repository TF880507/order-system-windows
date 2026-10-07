(function exposeCameraScanner(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CameraScanner = api;
}(typeof window !== 'undefined' ? window : globalThis, (root) => {
  function isRoutineDecodeMiss(error) {
    if (!error) return false;
    const kind = String(error.getKind?.() || error.kind || error.name || '');
    const message = String(error.message || '');
    return /NotFoundException|ChecksumException|FormatException/i.test(kind)
      || /No MultiFormat Readers were able to detect the code/i.test(message)
      || /No .*code.*found|checksum|format exception/i.test(message);
  }

  function createBrowserCameraScanner({ video, onResult, onStatus, onError }) {
    let controls = null;
    let starting = false;
    let handlingResult = false;
    let healthTimer = null;
    let waitingStatusShown = false;

    function clearHealthMonitor() {
      root.clearInterval?.(healthTimer);
      healthTimer = null;
    }

    function monitorVideo() {
      clearHealthMonitor();
      healthTimer = root.setInterval?.(() => {
        if (!controls || handlingResult || !video?.srcObject) return;
        const liveTrack = video.srcObject.getVideoTracks?.().find((track) => track.readyState === 'live');
        if (!liveTrack) {
          onError?.(Object.assign(new Error('相機串流已中斷，請關閉後重新開啟相機。'), { name: 'NotReadableError' }));
          clearHealthMonitor();
          return;
        }
        if (video.paused) {
          Promise.resolve(video.play?.()).catch((error) => onError?.(error));
        }
      }, 800);
    }

    function stop() {
      clearHealthMonitor();
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
      waitingStatusShown = false;
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
            clearHealthMonitor();
            if (value) Promise.resolve(onResult?.(value, format)).catch(onError);
            else handlingResult = false;
            return;
          }
          if (isRoutineDecodeMiss(error)) {
            if (!waitingStatusShown) {
              waitingStatusShown = true;
              onStatus?.('相機已啟動，請將條碼完整放入掃描框內');
            }
            return;
          }
          if (error) onError?.(error);
        });
        await video.play?.();
        monitorVideo();
        onStatus?.('相機已啟動，請將條碼完整放入掃描框內');
      } catch (error) {
        stop();
        throw error;
      } finally {
        starting = false;
      }
    }

    return { start, stop, isRunning: () => Boolean(starting || controls) };
  }

  return { createBrowserCameraScanner, isRoutineDecodeMiss };
}));
