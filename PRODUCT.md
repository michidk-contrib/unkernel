# Android on unkernel

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users and purpose

People curious about running a real Android system inside a browser, and
Android developers who may eventually use it to try their apps. The first
milestone is an interactive minimal Android system. APK upload and practical
app testing are goals, not verified capabilities.

## Stack and constraints

Plain HTML, CSS and TypeScript, built with Bun. unkernel runs an ARM64 Linux
kernel in WebAssembly. Waydroid supplies the Android 13 VANILLA system and
vendor images. The site must remain statically deployable on GitHub Pages.

Current Chromium with WebAssembly JSPI and cross-origin isolation is required.
The guest reserves 2 GiB. Android graphics are software rendered and remain
experimental. Visible pixels alone are insufficient evidence of readiness.
Stopping discards the session. WISP relays carry guest network traffic and must
be configurable, with an offline option. Relay configuration is distinct from
verified Android connectivity.

## Product requirements

Keep the Android display central, put startup controls within reach, show real
progress and provide useful errors and diagnostics. Start with one minimal
Waydroid profile. Expose additional distributions only after their boot and
interaction tests pass. Preserve framework, package installation, permissions
and network services for future app testing.
