# Minimal Android implementation plan

**Goal:** Run a small Android launcher and expose session and WISP controls.

**Architecture:** Retain the pinned Waydroid system and vendor disks. Apply
optional-app whiteouts in the writable overlay and add a platform-only APK.
Keep browser configuration separate from Android boot orchestration.

**Spec:** ../specs/2026-11-28-minimal-android-design.md

- [x] Build and sign Browser Home using Android platform 33 and build-tools
  35.0.0. Include Settings, installed apps, a tap counter and an HTTPS check.
- [x] Install it before Android init in the website and runtime verification.
  Hash the APK into prepared-data identities and update launcher readiness.
- [x] Add validated WISP/offline settings, persistence and URL sharing. Attach
  a network device only in WISP mode, and test Android-level connectivity.
- [x] Rebuild the website around the display, configuration and startup state.
  Preserve Start/Stop, progress, error and diagnostic controls.
- [x] Run launcher compilation, TypeScript checks and relevant unit tests,
  then a real Android boot and shared-browser desktop/mobile layout checks.
- [x] Record measured limitations and keep generated SDK/build files untracked.

Verification on 2026-11-28 passed against the packaged EROFS disks and Android
kernel in Node: boot completion, Browser Home readiness, Settings rendering,
a Wayland pointer click opening Network & internet, and Android HTTPS through
WISP. The launcher was ready after 371,777 ms on one emulated CPU with cold
data. This is one native run, not a browser benchmark or a speedup comparison.
Desktop and mobile layout checks passed separately in the shared browser.
