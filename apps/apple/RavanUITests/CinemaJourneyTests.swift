import XCTest

extension XCTestCase {
    @MainActor func preparePortrait(_ app: XCUIApplication) {
        let device = XCUIDevice.shared
        device.orientation = .portrait
        let settled = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            app.frame.height > app.frame.width
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [settled], timeout: 8), .completed)
    }

    @MainActor func tap(_ control: XCUIElement, app: XCUIApplication,
                        file: StaticString = #filePath, line: UInt = #line) {
        // A partially clipped element can report isHittable while its center lies under
        // the navigation bar. Scroll the actual viewport before activating it.
        for _ in 0..<8 {
            if control.exists {
                let frame = control.frame
                let id = control.identifier
                let scroll = !id.isEmpty ? app.scrollViews.containing(.button, identifier: id).firstMatch : app.scrollViews.firstMatch
                let viewport = scroll.exists ? scroll.frame.intersection(app.frame) : app.frame
                let visible = frame.intersection(viewport)
                let center = CGPoint(x: frame.midX, y: frame.midY)
                if control.isHittable, !visible.isEmpty, viewport.contains(center) {
                    control.tap()
                    return
                }
                if scroll.exists {
                    if frame.midY < viewport.midY { scroll.swipeDown() } else { scroll.swipeUp() }
                    continue
                }
            }
            let viewport = app.scrollViews.firstMatch
            if viewport.exists { viewport.swipeUp() } else { app.swipeUp() }
        }
        XCTFail("The intended control did not reach the visible viewport.", file: file, line: line)
    }

    @MainActor func audit(_ app: XCUIApplication) throws {
        let initialPolicy = continueAfterFailure
        continueAfterFailure = true
        defer { continueAfterFailure = initialPolicy }
        try app.performAccessibilityAudit { issue in
            let element = issue.element
            let diagnostic = XCTAttachment(string: [issue.compactDescription, element?.label ?? "", element?.identifier ?? "",
                                                    element.map { String(describing: $0.frame) } ?? ""].joined(separator: " | "))
            diagnostic.name = "Accessibility finding"
            diagnostic.lifetime = .keepAlways
            self.add(diagnostic)
            let hierarchy = XCTAttachment(string: app.debugDescription)
            hierarchy.name = "Audited fixture accessibility tree"
            self.add(hierarchy)
            return false
        }
    }
}

@MainActor final class CinemaJourneyTests: XCTestCase {
    override func setUpWithError() throws {
        try super.setUpWithError()
        #if !DEBUG && !RAVAN_UI_TESTING
        throw XCTSkip("Build both the app and UI tests with RAVAN_UI_TESTING to run an isolated release-configuration test.")
        #else
        continueAfterFailure = false
        #endif
    }
    private func capture(_ app: XCUIApplication, as name: String) {
        // A changed accessibility label can arrive before its short visual transition finishes.
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.45))
        let capture = XCTAttachment(screenshot: app.screenshot())
        capture.name = name
        capture.lifetime = .keepAlways
        add(capture)
    }

    private func destination(_ name: String, in app: XCUIApplication) {
        let sidebar = app.buttons["destination." + name]
        if sidebar.exists && sidebar.isHittable {
            sidebar.tap()
        } else if app.buttons["destinations.menu"].exists && app.buttons["destinations.menu"].isHittable {
            app.buttons["destinations.menu"].tap()
            app.buttons[title(name)].tap()
        } else {
            app.buttons[title(name)].firstMatch.tap()
        }
    }

    private func title(_ raw: String) -> String {
        switch raw {
        case "cinema": "Your Cinema"
        case "watchlist": "Watchlist"
        default: "Library"
        }
    }

    func testWelcomeAndOfflineSample() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--ravan-isolated-test"]
        app.launch()
        preparePortrait(app)
        XCTAssertTrue(app.buttons["welcome.files"].waitForExistence(timeout: 25))
        #if PAIRED
        XCTAssertTrue(app.buttons["welcome.connect"].exists)
        #else
        XCTAssertFalse(app.buttons["welcome.connect"].exists)
        #endif
        capture(app, as: "Welcome")
        try audit(app)
        tap(app.buttons["welcome.sample"], app: app)
        let close = app.buttons["player.close"]
        XCTAssertTrue(close.waitForExistence(timeout: 30))
        capture(app, as: "Player")
        close.tap()

        let sample = app.buttons["film.sample"].firstMatch
        // A saved position adds a Continue Watching shelf above the lazy film grid.
        XCTAssertTrue(app.buttons["library.files"].waitForExistence(timeout: 15))
        capture(app, as: "Library")
        try audit(app)
        tap(sample, app: app)
        XCTAssertTrue(app.buttons["screening.play"].waitForExistence(timeout: 10))
        capture(app, as: "Screening Card")
        try audit(app)

        let save = app.buttons["screening.save"]
        if save.label == "Remove from Watchlist" { tap(save, app: app) }
        tap(save, app: app)
        XCTAssertEqual(save.label, "Remove from Watchlist")
        destination("watchlist", in: app)
        XCTAssertTrue(sample.waitForExistence(timeout: 10))
        tap(sample, app: app)
        XCTAssertEqual(app.buttons["screening.save"].label, "Remove from Watchlist")
        tap(app.buttons["screening.save"], app: app)
    }

    func testSearchAndPrivacyControls() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--ravan-isolated-test", "--ravan-test-library"]
        app.launch()
        preparePortrait(app)
        destination("library", in: app)
        let search = app.textFields["collection.search"].firstMatch
        if !search.waitForExistence(timeout: 6), app.navigationBars.buttons.element(boundBy: 0).isHittable {
            app.navigationBars.buttons.element(boundBy: 0).tap()
        }
        XCTAssertTrue(search.waitForExistence(timeout: 12))
        search.tap()
        search.typeText("quartzfjord")
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "quartzfjord")).firstMatch.waitForExistence(timeout: 8))
        app.buttons["collection.search.clear"].firstMatch.tap()
        XCTAssertTrue(app.buttons["film.sample"].firstMatch.waitForExistence(timeout: 8))
        // Dismiss software input before changing tabs on a compact screen.
        if app.keyboards.buttons["Search"].exists { app.keyboards.buttons["Search"].tap() }
        destination("cinema", in: app)
        XCTAssertTrue(app.buttons["cinema.files"].waitForExistence(timeout: 12))
        #if !PAIRED
        XCTAssertFalse(app.buttons["Connect a Server"].exists)
        #endif
        tap(app.buttons["Privacy policy"].firstMatch, app: app)
        XCTAssertTrue(app.staticTexts["Films in Files"].waitForExistence(timeout: 12))
        app.buttons["Done"].tap()
    }

    func testLightAppearanceWatchlistSettingsAndHelp() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--ravan-isolated-test", "--ravan-test-library", "--ravan-test-light"]
        app.launch()
        preparePortrait(app)
        destination("watchlist", in: app)
        XCTAssertTrue(app.staticTexts["No saved films on this device"].waitForExistence(timeout: 12))
        capture(app, as: "Watchlist Light")
        try audit(app)
        destination("cinema", in: app)
        XCTAssertTrue(app.buttons["cinema.files"].waitForExistence(timeout: 12))
        capture(app, as: "Your Cinema Light")
        // Audit the support rows with their complete labels exposed, then return to Audio.
        let settingsScroll = app.scrollViews.containing(.button, identifier: "cinema.files").firstMatch
        let help = app.buttons["Playback help"].firstMatch
        if settingsScroll.exists && (!help.exists || help.frame.maxY > settingsScroll.frame.maxY) {
            settingsScroll.swipeUp()
        }
        XCTAssertTrue(help.exists && help.isHittable)
        try audit(app)
        let audio = app.buttons["Audio"].firstMatch
        tap(audio, app: app)
        app.buttons["Persian"].firstMatch.tap()
        XCTAssertEqual(audio.value as? String, "Persian")
        tap(app.buttons["Playback help"].firstMatch, app: app)
        XCTAssertTrue(app.staticTexts["Audio and captions"].waitForExistence(timeout: 10))
        try audit(app)
        app.buttons["Done"].tap()
        XCTAssertTrue(app.buttons["cinema.files"].exists)
    }

    #if PAIRED
    #if RAVAN_UI_TESTING
    func testWebsitePairingOffersOwnerApproval() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--ravan-isolated-test"]
        app.launch()
        preparePortrait(app)
        tap(app.buttons["welcome.connect"], app: app)
        tap(app.buttons["server.website"], app: app)
        XCTAssertTrue(app.staticTexts["pairing.code"].waitForExistence(timeout: 12))
        XCTAssertEqual(app.staticTexts["pairing.code"].label, "A B C D E F G H")
        XCTAssertTrue(app.buttons["pairing.approve"].exists)
        tap(app.buttons["Change server"], app: app)
        XCTAssertTrue(app.buttons["server.website"].waitForExistence(timeout: 12))
    }
    #endif
    func testConnectRejectsAnInsecureAddressAndReturnsToWelcome() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--ravan-isolated-test"]
        app.launch()
        preparePortrait(app)
        tap(app.buttons["welcome.connect"], app: app)
        let address = app.textFields["server.address"]
        XCTAssertTrue(address.waitForExistence(timeout: 12))
        capture(app, as: "Connect")
        try audit(app)
        address.tap()
        address.typeText("http://cinema.invalid\n")
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "HTTPS server address")).firstMatch.waitForExistence(timeout: 10))
        app.buttons["Close"].tap()
        XCTAssertTrue(app.buttons["welcome.sample"].waitForExistence(timeout: 10))
    }
    #endif

    func testWelcomeAtAccessibilitySize() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--ravan-isolated-test", "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
        app.launch()
        preparePortrait(app)
        XCTAssertTrue(app.buttons["welcome.files"].waitForExistence(timeout: 25))
        tap(app.buttons["welcome.sample"], app: app)
        XCTAssertTrue(app.buttons["player.close"].waitForExistence(timeout: 30))
        app.buttons["player.close"].tap()
        tap(app.buttons["film.sample"].firstMatch, app: app)
        tap(app.buttons["screening.save"], app: app)
        XCTAssertEqual(app.buttons["screening.save"].label, "Remove from Watchlist")
        capture(app, as: "Screening Card Large Text")
    }

    func testLandscapeTaskBarKeepsEachDestination() async throws {
        guard UIDevice.current.userInterfaceIdiom == .phone else { throw XCTSkip("This journey covers the compact phone task bar.") }
        let device = XCUIDevice.shared
        let previous = device.orientation
        defer { device.orientation = previous.isValidInterfaceOrientation ? previous : .portrait }
        let app = XCUIApplication()
        app.launchArguments = ["--ravan-isolated-test", "--ravan-test-library"]
        app.launch()
        preparePortrait(app)
        let library = app.buttons["destination.library"]
        let watchlist = app.buttons["destination.watchlist"]
        XCTAssertTrue(library.waitForExistence(timeout: 12))
        device.orientation = .landscapeLeft
        let deadline = ContinuousClock.now + .seconds(8)
        while app.frame.width <= app.frame.height && ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(100))
        }
        XCTAssertGreaterThan(app.frame.width, app.frame.height)
        XCTAssertTrue(library.isSelected)
        // UIKit reports intermediate presentation frames during the physical rotation animation.
        let settledTarget = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            watchlist.isHittable && watchlist.frame.height >= 44
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [settledTarget], timeout: 8), .completed)
        tap(app.buttons["film.sample"].firstMatch, app: app)
        XCTAssertTrue(app.buttons["screening.play"].waitForExistence(timeout: 10))
        watchlist.tap()
        XCTAssertTrue(watchlist.isSelected)
        library.tap()
        XCTAssertTrue(app.buttons["screening.play"].waitForExistence(timeout: 10))
        capture(app, as: "Landscape Screening Card")
    }
}
