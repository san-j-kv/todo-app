package com.sanjkv.todo;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Before super, not after: BridgeActivity.onCreate ends by building the
        // bridge from the plugins registered so far, so anything added later is
        // silently absent from Capacitor.Plugins. TodoStore is app-local and
        // cannot auto-register — assets/capacitor.plugins.json is regenerated
        // by `cap sync` from installed npm packages only.
        registerPlugin(TodoStorePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
