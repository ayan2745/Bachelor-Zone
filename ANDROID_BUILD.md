# Android app build

This project now uses Capacitor to package the existing `index.html` app as an Android app.

## App details

- App name: `Bachelor Mess`
- Android package id: `com.imran.bachelormess`
- Web source copied from: `index.html`
- Capacitor web folder: `www`
- Android project folder: `android`

## Commands

```bash
npm run android:sync
npm run android:open
npm run android:debug
```

`android:sync` copies `index.html` into `www/index.html` and syncs it into the Android project.

`android:open` opens the project in Android Studio.

`android:debug` builds a debug APK when Java and Android SDK are installed.

## Local build requirement

The current machine is using Java 8, but this Android build needs Java 11 or newer. Install Android Studio or a modern JDK, then run:

```bash
npm run android:debug
```

The debug APK will be generated under:

```text
android/app/build/outputs/apk/debug/
```
