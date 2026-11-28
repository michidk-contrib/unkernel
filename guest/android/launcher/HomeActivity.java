// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Michael Lohr <michael@lohr.dev>
package dev.unkernel.home;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.ResolveInfo;
import android.graphics.Color;
import android.os.Bundle;
import android.provider.Settings;
import android.util.Log;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import java.util.List;
import java.net.HttpURLConnection;
import java.net.URL;

/** Plain Android views with hardware acceleration disabled in the manifest. */
public final class HomeActivity extends Activity {
    private LinearLayout content;
    private int taps;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(Color.rgb(240, 244, 235));
        getWindow().setNavigationBarColor(Color.rgb(240, 244, 235));
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        showHome();
        handleIntent(getIntent());
    }

    private void page(String title, String description) {
        content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        int padding = (int) (24 * getResources().getDisplayMetrics().density);
        content.setPadding(padding, padding, padding, padding);
        content.setBackgroundColor(Color.rgb(240, 244, 235));
        ScrollView scroll = new ScrollView(this);
        scroll.addView(content);
        setContentView(scroll);
        TextView heading = text(title, 28);
        heading.setPadding(0, 0, 0, 16);
        text(description, 16).setPadding(0, 0, 0, 24);
    }

    private TextView text(String label, int size) {
        TextView view = new TextView(this);
        view.setText(label);
        view.setTextSize(size);
        view.setTextColor(Color.rgb(30, 48, 36));
        content.addView(view);
        return view;
    }

    private void button(String label, View.OnClickListener action) {
        Button button = new Button(this);
        button.setText(label);
        button.setAllCaps(false);
        button.setMinHeight(56);
        button.setOnClickListener(action);
        content.addView(button, new LinearLayout.LayoutParams(-1, -2));
    }

    private void open(Intent intent) {
        try { startActivity(intent); }
        catch (RuntimeException unavailable) {
            Toast.makeText(this, "This app could not be opened", Toast.LENGTH_SHORT).show();
        }
    }

    private void showHome() {
        page("Android, in your browser.", "A minimal Android 13 session. Choose an app to get started.");
        button("Settings", view -> open(new Intent(Settings.ACTION_SETTINGS)));
        button("Test touch input", view -> showTouch());
        button("Check internet", view -> checkInternet());
        button("Installed apps", view -> showApps());
    }

    private void showTouch() {
        page("Touch test", "Each press updates the counter using Android's UI thread.");
        TextView counter = text("Taps: " + taps, 24);
        button("Tap me", view -> { taps++; counter.setText("Taps: " + taps); Log.i("BrowserHome", "taps=" + taps); });
        button("Back to apps", view -> showHome());
    }

    private void showApps() {
        page("Installed apps", "Apps with a launcher entry in this session.");
        Intent query = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        List<ResolveInfo> apps = getPackageManager().queryIntentActivities(query, 0);
        apps.sort(new ResolveInfo.DisplayNameComparator(getPackageManager()));
        for (ResolveInfo app : apps) {
            button(app.loadLabel(getPackageManager()).toString(), view -> open(new Intent(Intent.ACTION_MAIN)
                .addCategory(Intent.CATEGORY_LAUNCHER).setClassName(app.activityInfo.packageName, app.activityInfo.name)));
        }
        button("Back to home", view -> showHome());
    }

    private void checkInternet() {
        page("Internet check", "Fetching https://example.com from an Android app.");
        TextView result = text("Connecting...", 18);
        button("Back to home", view -> showHome());
        new Thread(() -> {
            HttpURLConnection connection = null;
            String message;
            try {
                connection = (HttpURLConnection) new URL("https://example.com/").openConnection();
                connection.setConnectTimeout(15000);
                connection.setReadTimeout(15000);
                message = "Network HTTP " + connection.getResponseCode();
            } catch (Exception failure) {
                message = "Network failed: " + failure.getClass().getSimpleName() + ": " + failure.getMessage();
            } finally {
                if (connection != null) connection.disconnect();
            }
            final String status = message;
            Log.i("BrowserHome", status);
            runOnUiThread(() -> result.setText(status));
        }, "internet-check").start();
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        showHome();
        handleIntent(intent);
    }
    private void handleIntent(Intent intent) {
        if ("dev.unkernel.home.CHECK_NETWORK".equals(intent.getAction())) checkInternet();
        if ("dev.unkernel.home.SHOW_APPS".equals(intent.getAction())) showApps();
        if ("dev.unkernel.home.DOWNLOAD_APK".equals(intent.getAction())) {
            page("Getting your app", "This download uses Android's Internet connection.");
            TextView status = text("Connecting...", 18);
            ApkDownload.start(this, intent.getStringExtra("url"), intent.getStringExtra("token"),
                message -> runOnUiThread(() -> status.setText(message)));
        }
    }
    @Override public void onBackPressed() { showHome(); }
}
