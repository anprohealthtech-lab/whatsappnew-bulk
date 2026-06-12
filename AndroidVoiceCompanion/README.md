# Android SIM Dialing Companion Prototype

This native prototype enrolls as an Android gateway, polls the main app for campaign jobs, and places normal SIM calls using `ACTION_CALL`.

For the first hardware test:

1. Enroll a separate Android gateway in the main app.
2. Install this app directly with Android Studio.
3. Grant call and phone-state permissions.
4. Pair the phone to the Windows gateway over Bluetooth HFP.
5. Enter the main-app URL, device ID, and one-time device token.

The prototype intentionally keeps audio processing on the Windows gateway. Production work still needs default-dialer integration, SIM-slot selection, call-state callbacks, signed APK distribution, and pairing the Android and Windows device records.
