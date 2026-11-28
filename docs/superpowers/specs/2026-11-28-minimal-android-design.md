# Minimal Android in the browser

Use the pinned ARM64 Waydroid VANILLA image as the first supported distribution.
The user delegated the choice of image and asked for implementation. Reuse the
existing Android hardware integration, replace Trebuchet with a tiny native
launcher with hardware acceleration disabled, and hide optional bundled apps
through the disposable system overlay. Keep Settings, browser/WebView, the
keyboard, package installation, Android permissions and network services.

The website puts the session first, with the display beside startup and network
controls. Offer WISP and offline operation. Save relay settings locally and in a
shareable URL, reject invalid or mixed-content endpoints, and distinguish a
configured relay from Android connectivity. Preserve real boot progress,
cancellation, diagnostics and the input-readiness guard. Use a quiet light
control panel and a dark display area so the running Android interface remains
the main content. The first target is desktop Chromium with JSPI; smaller
viewports stack the controls without clipping the display.

Success means the minimal launcher draws and responds to repeated clicks, opens
Settings, and an Android app can request an HTTPS page through WISP. Software
SurfaceFlinger remains a possible bottleneck. Report that limitation and any
failed checks; do not promise a speedup, APK testing or usable graphics without
runtime evidence. No distribution selector until each alternative is tested.
