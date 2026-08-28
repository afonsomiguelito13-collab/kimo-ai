package com.kimo.ai;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

public class MainActivity extends AppCompatActivity {

    private static final int STORAGE_PERMISSION_CODE = 101;
    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        webView = findViewById(R.id.webview);
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);
        
        // Injetar a Bridge para o JavaScript comunicar com o Android
        webView.addJavascriptInterface(new WebAppInterface(this), "Android");
        
        webView.setWebViewClient(new WebViewClient());

        // Carrega o site alojado no Render
        webView.loadUrl("https://kimo-ai-yko9.onrender.com");

        // Verificar permissões no arranque
        checkAndRequestPermissions();
    }

    private void checkAndRequestPermissions() {
        String permission;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            permission = Manifest.permission.READ_MEDIA_DOCUMENTS;
        } else {
            permission = Manifest.permission.READ_EXTERNAL_STORAGE;
        }

        if (ContextCompat.checkSelfPermission(this, permission) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, new String[]{permission}, STORAGE_PERMISSION_CODE);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == STORAGE_PERMISSION_CODE) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                // Informa o WebView que a permissão foi concedida com sucesso
                webView.evaluateJavascript("if(typeof updatePermissionUIStates === 'function'){ updatePermissionUIStates(true); }", null);
            }
        }
    }

    // Classe de Bridge para interligar o site e o APK nativo
    public class WebAppInterface {
        AppCompatActivity mContext;

        WebAppInterface(AppCompatActivity c) {
            mContext = c;
        }

        @android.webkit.JavascriptInterface
        public void requestStoragePermission() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    checkAndRequestPermissions();
                }
            });
        }
    }
}
