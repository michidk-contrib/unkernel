// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Michael Lohr <michael@lohr.dev>
package dev.unkernel.home;

import android.content.Context;
import android.os.SystemClock;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;
import org.json.JSONObject;

/** Download through Android's real network connection, without browser CORS. */
final class ApkDownload {
    private static final long LIMIT = 64L * 1024 * 1024;
    private static final AtomicBoolean active = new AtomicBoolean();

    static void start(Context context, String address, String token, Consumer<String> progress) {
        if (token == null || !token.matches("[a-f0-9-]{36}")) return;
        File directory = context.getCacheDir();
        File apk = new File(directory, "download-" + token + ".apk");
        File status = new File(directory, "download-" + token + ".json");
        if (!active.compareAndSet(false, true)) {
            write(status, "failed", 0, "Another APK download is running", null);
            return;
        }
        new Thread(() -> {
            HttpURLConnection connection = null;
            long bytes = 0;
            long started = SystemClock.elapsedRealtime();
            try {
                URL url = new URL(address);
                for (int redirects = 0; ; redirects++) {
                    if (!"https".equals(url.getProtocol()) || url.getUserInfo() != null || url.getRef() != null)
                        throw new Exception("APK URLs and redirects must use HTTPS without credentials or fragments");
                    connection = (HttpURLConnection) url.openConnection();
                    connection.setInstanceFollowRedirects(false);
                    connection.setConnectTimeout(15000);
                    connection.setReadTimeout(30000);
                    int code = connection.getResponseCode();
                    if (code == 301 || code == 302 || code == 303 || code == 307 || code == 308) {
                        String location = connection.getHeaderField("Location");
                        if (redirects >= 5 || location == null) throw new Exception("Too many or invalid redirects");
                        url = new URL(url, location);
                        connection.disconnect();
                        continue;
                    }
                    if (code != 200) throw new Exception("APK server returned HTTP " + code);
                    break;
                }
                long expected = connection.getContentLengthLong();
                if (expected > LIMIT) throw new Exception("APK exceeds the 64 MiB limit");
                write(status, "downloading", 0, null, null);
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                long reported = SystemClock.elapsedRealtime();
                try (InputStream input = connection.getInputStream(); FileOutputStream output = new FileOutputStream(apk)) {
                    byte[] buffer = new byte[32768];
                    int length;
                    while ((length = input.read(buffer)) != -1) {
                        if (SystemClock.elapsedRealtime() - started > 300000) throw new Exception("APK download timed out");
                        bytes += length;
                        if (bytes > LIMIT) throw new Exception("APK exceeds the 64 MiB limit");
                        output.write(buffer, 0, length);
                        digest.update(buffer, 0, length);
                        if (SystemClock.elapsedRealtime() - reported > 1000) {
                            reported = SystemClock.elapsedRealtime();
                            write(status, "downloading", bytes, null, null);
                            progress.accept("Downloading APK: " + (bytes / 1048576) + " MiB");
                        }
                    }
                }
                if (bytes == 0 || (expected >= 0 && bytes != expected)) throw new Exception("APK download is empty or truncated");
                StringBuilder hash = new StringBuilder();
                for (byte value : digest.digest()) hash.append(String.format("%02x", value & 255));
                write(status, "complete", bytes, null, hash.toString());
                progress.accept("APK downloaded. Waiting for installation...");
            } catch (Exception failure) {
                apk.delete();
                write(status, "failed", bytes, failure.getMessage(), null);
                progress.accept("APK download failed: " + failure.getMessage());
            } finally {
                if (connection != null) connection.disconnect();
                active.set(false);
            }
        }, "apk-download").start();
    }

    private static void write(File target, String state, long bytes, String message, String hash) {
        File temporary = new File(target.getPath() + ".tmp");
        try {
            JSONObject value = new JSONObject().put("state", state).put("bytes", bytes);
            if (message != null) value.put("message", message);
            if (hash != null) value.put("sha256", hash);
            try (FileOutputStream output = new FileOutputStream(temporary)) {
                output.write(value.toString().getBytes(StandardCharsets.UTF_8));
            }
            if (!temporary.renameTo(target)) throw new Exception("Cannot publish APK download status");
        } catch (Exception failure) {
            android.util.Log.e("BrowserHome", "Cannot write APK status", failure);
        }
    }
}
