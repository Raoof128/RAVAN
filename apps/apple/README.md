# RAVĀN for iPhone and iPad

Open `Ravan.xcodeproj` in Xcode. Select the shared **Ravan** scheme, choose your connected iPhone as the run destination and press Run. For a first install, unlock the phone, trust the Mac, enable Developer Mode and select your Apple Development team in Signing & Capabilities. The deployment target is iOS 18. No third-party Swift packages are required. The checked-in project can be regenerated with `xcodegen generate` in this directory after changing `project.yml`.

On first launch, choose **Play Sample Film** to watch *Tide Almanac*, or **Open a Film in Files** to choose a compatible video. Close the player, select a film, and tap Resume to return to its saved position. Use Your Cinema for language preferences, local history, file selection and playback help.

| Build configuration | Bundle identifier | Entry points |
| --- | --- | --- |
| PersonalPaired | au.ravan.cinema.personal | Files, sample, optional personal server |
| StoreFiles | au.ravan.cinema | Offline Files library and sample |
| StorePaired | au.ravan.cinema | Files and optional server pairing, using the same local database as StoreFiles |

The identifiers are proposed for development. Signing and App Store Connect require the owner's registered identifiers and team. The scheme runs PersonalPaired by default and archives StoreFiles.

## Connect a personal cinema

1. On the welcome screen, tap **Connect to RAVĀN**. You can also open the connection screen from **Your Cinema**.
2. Tap **Get website pairing code**, or enter the HTTPS address of your own server. When the temporary code appears, tap **Copy code and open website**.
3. Sign in as the owner. In **Your cinema → Pair a screen**, paste the code, select **Allow this device to open the Reading Room and save reading progress**, then approve the device. Watchlist access has its own checkbox.
4. Return to the app and open **Reading Room**. Browse your Drive folders, choose an EPUB, PDF or CBZ title, and pick up at the position saved on the website.

For a self-hosted build, set the default website in [RavanWebsite.swift](Ravan/Paired/RavanWebsite.swift). If a device was paired before reading access was available, choose **Open website reader** and sign in, or disconnect and pair again to grant reading access.

Remote film playback uses Wi-Fi and the Apple SDR profile.

## Implementation

* `Ravan/LocalLibrary` manages versioned SwiftData records, security-scoped file references and positions. A local film has a generated identity independent of its filename.
* `Ravan/Playback` presents the system player, owns access while a local file is open and releases observers and the file on dismissal.
* `Ravan/UI` contains the compact and split layouts. Film selection is held per scene. Local storage is shared across the app's windows.
* `Ravan/Paired` contains device pairing, credentials, catalogue, jobs, session and media transport. The build condition `PAIRED` excludes this code from StoreFiles.
* `Sample` records the provenance and editable captions of the bundled film.

## Physical iPhone tests

The checked-in test plan runs on the personal iPhone. Connect it by USB or use a paired Wi-Fi connection. Set `RAVAN_IPHONE_UDID` to the physical device’s identifier from Xcode and `RAVAN_TEAM_ID` to the signing team. The tests use the bundled sample and isolated fixtures.

```sh
xcrun devicectl list devices
xcodebuild test -project apps/apple/Ravan.xcodeproj -scheme Ravan \
  -configuration PersonalPaired -destination "platform=iOS,id=${RAVAN_IPHONE_UDID}" \
  -parallel-testing-enabled NO DEVELOPMENT_TEAM="${RAVAN_TEAM_ID}" CODE_SIGN_STYLE=Automatic
```

To include the paired catalogue and preparation UI fixtures plus 20 bundled-film decode measurements, add the single build setting `SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG PAIRED RAVAN_UI_TESTING RAVAN_PERFORMANCE_FIXTURE` as a quoted argument to the PersonalPaired test command.

For the StoreFiles tests, change the configuration to `StoreFiles` and pass both `ENABLE_TESTABILITY=YES` and `SWIFT_ACTIVE_COMPILATION_CONDITIONS=RAVAN_UI_TESTING` to the test command. In both editions the test plan opens an in-memory cinema, so the UI tests can clear history or change favourites without touching the owner’s library or pairing. An ordinary launch opens the owner’s saved library.

To exercise an in-place Files-to-Paired update, use the same physical phone and Store bundle ID for both Xcode test runs. Run `-only-testing:RavanTests/LocalCinemaTests/testFilesToPairedPersistentUpgrade` with testability enabled. Set `SWIFT_ACTIVE_COMPILATION_CONDITIONS` to `RAVAN_UI_TESTING RAVAN_UPGRADE_FIXTURE` in StoreFiles, then to `PAIRED RAVAN_UI_TESTING RAVAN_UPGRADE_FIXTURE` in StorePaired. Keep the app installed between runs. The Files phase imports a copy of the bundled film into a dedicated test store. The Paired phase verifies the same bookmark, favourite and saved position and then plays the imported film.

For an unsigned device archive, run the following independently of App Store distribution.

```sh
xcodebuild archive -project apps/apple/Ravan.xcodeproj -scheme Ravan \
  -configuration StoreFiles -destination 'generic/platform=iOS' \
  -archivePath apps/apple/build/Ravan.xcarchive CODE_SIGNING_ALLOWED=NO
```
