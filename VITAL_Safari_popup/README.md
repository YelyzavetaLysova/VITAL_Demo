# VITAL Safari popup 1.15.0

Remove the old temporary VITAL from Safari Settings > Extensions. Keep older installed copies disabled. Open Settings > Developer > Add Temporary Extension, select extension-safari from this folder, and refresh the article.

This remains the native toolbar popup that worked in 1.6.4. No frame is embedded in the news page. It retains explicit sizing and scrollable content. The new display and navigation rules match the Chrome/sidebar and web widgets.

Show in article dismisses the popup after navigation. Clicking a highlighted claim requests the popup. If Safari blocks programmatic opening, click VITAL in the toolbar to open the saved selection. Analysis continues on the backend while the popup is closed.

For Xcode or iPhone/iPad simulator testing, run `python3 build_safari.py` on your Mac. Select the macOS or iOS scheme and the intended device/simulator. Enable VITAL in Safari settings on that device. Do not move the project directory after generating its Xcode project.

Uses https://vital.demo.mediafutures.no. Update VITAL_Web_Demo on the server before loading. No API secret is stored in this extension. The central API remains unchanged.

Automated DOM tests are included; real macOS/iOS/iPadOS testing is still needed before public distribution.

## Privacy update

The extension asks for notice acceptance before submission. Opening it does not upload article text; press Analyse to submit or retrieve an identical cached article. Settings contains privacy information and withdrawal. See ../PUBLICATION.md for tester distribution and ../README.md for release notes. The privacy page is included offline in the extension. No backend secrets are included here.
