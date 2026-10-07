(function exposeDeviceScanner(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.DeviceScanner = api;
}(typeof window !== 'undefined' ? window : globalThis, () => {
  function detectScanEnvironment(options = {}) {
    const userAgent = String(options.userAgent || '');
    const platformName = String(options.platformName || '');
    const maxTouchPoints = Number(options.maxTouchPoints || 0);
    const hasNativeScanner = Boolean(options.hasNativeScanner);
    const isSecureContext = Boolean(options.isSecureContext);
    const hasMediaDevices = Boolean(options.hasMediaDevices);
    const isAndroid = /Android/i.test(userAgent);
    const isIPhoneOrIPad = /iPhone|iPad|iPod/i.test(userAgent)
      || (platformName === 'MacIntel' && maxTouchPoints > 1);
    const isMobileBrowser = !hasNativeScanner && (isAndroid || isIPhoneOrIPad || /Mobile/i.test(userAgent));
    const isWindows = /Windows/i.test(userAgent);
    const platform = hasNativeScanner
      ? 'android-app'
      : (isMobileBrowser ? 'mobile-web' : (isWindows ? 'windows' : 'desktop'));
    const canUseWebCamera = !hasNativeScanner && isSecureContext && hasMediaDevices;

    let cameraUnavailableReason = '';
    if (!hasNativeScanner && !isSecureContext) {
      cameraUnavailableReason = '相機掃描需要使用 HTTPS 安全網址，請開啟 https://good.joef.com.tw/。';
    } else if (!hasNativeScanner && !hasMediaDevices) {
      cameraUnavailableReason = '此瀏覽器不支援相機存取，請更新 Chrome、Edge 或 Safari。';
    }

    return {
      platform,
      hasNativeScanner,
      canUseWebCamera,
      canUseCamera: hasNativeScanner || canUseWebCamera,
      useHardwareInput: platform === 'windows' || platform === 'desktop',
      cameraUnavailableReason
    };
  }

  function describeCameraError(error) {
    const name = String(error?.name || '');
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return '相機權限被拒絕，請到瀏覽器的網站設定允許相機後再試一次。';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return '找不到可用的相機，請確認裝置具有鏡頭或已接上外接鏡頭。';
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return '相機目前被其他程式使用，請關閉其他相機程式後再試一次。';
    }
    if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
      return '無法使用指定鏡頭，請重新開啟掃描或改用其他相機。';
    }
    return error?.message ? `相機啟動失敗：${error.message}` : '相機啟動失敗，請重新整理頁面後再試一次。';
  }

  return { detectScanEnvironment, describeCameraError };
}));
