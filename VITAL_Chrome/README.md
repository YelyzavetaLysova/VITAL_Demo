# VITAL Chrome desktop 1.12.0

Open chrome://extensions. Reload VITAL if you replaced the existing source folder, or use Load unpacked and select extension from this project. Refresh every news tab. Enable only one VITAL copy.

The extension uses the hosted demo backend at https://vital.demo.mediafutures.no. Deploy the VITAL_Web_Demo update before reloading this extension. No local backend is needed, and the extension contains no API secret.

The sidebar has Summary, Claims, Article and Settings. The 1.12.0 changes are described in the archive README. Pending and skipped appear together as Not Health Claim, but both retain the explicit Analyse claim action. Expanding never starts a check. The same tone and navigation rules are shared by the website and Safari.

This package is for desktop Chrome, not ordinary mobile Chrome. Tests use mocked browser/backend APIs; test it in Chrome after loading.
