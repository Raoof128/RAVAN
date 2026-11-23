#if PAIRED && RAVAN_UI_TESTING
import XCTest

@MainActor final class PairedJourneyTests: XCTestCase {
    override func setUpWithError() throws {
        try super.setUpWithError()
        continueAfterFailure = false
    }

    private func launch(readOnly: Bool = false, failFirstPage: Bool = false) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--ravan-isolated-test", "--ravan-test-library", "--ravan-paired-fixture"]
        if failFirstPage { app.launchArguments.append("--ravan-fail-first-page") }
        if readOnly { app.launchArguments.append("--ravan-paired-readonly") }
        app.launch()
        preparePortrait(app)
        return app
    }

    private func tap(_ element: XCUIElement, in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        tap(element, app: app, file: file, line: line)
    }

    private func expectLabel(_ label: String, on element: XCUIElement, file: StaticString = #filePath, line: UInt = #line) {
        let predicate = NSPredicate(format: "label == %@", label)
        let expected = XCTNSPredicateExpectation(predicate: predicate, object: element)
        XCTAssertEqual(XCTWaiter.wait(for: [expected], timeout: 8), .completed, file: file, line: line)
    }

    private func capture(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    func testServerFilmAndWatchlist() throws {
        let app = launch(failFirstPage: true)
        tap(app.buttons["server.catalogue.retry"], in: app)
        tap(app.buttons["server.film.fixture-film"].firstMatch, in: app)
        XCTAssertTrue(app.buttons["film.resume"].waitForExistence(timeout: 12))
        capture(app, "Paired screening card")
        try audit(app)
        let save = app.buttons["server.watchlist"]
        tap(save, in: app)
        expectLabel("Remove from Watchlist", on: save)
        let sidebar = app.buttons["destination.watchlist"]
        if sidebar.exists && sidebar.isHittable { sidebar.tap() }
        else if app.buttons["destinations.menu"].exists && app.buttons["destinations.menu"].isHittable {
            app.buttons["destinations.menu"].tap(); app.buttons["Watchlist"].tap()
        } else { app.buttons["Watchlist"].firstMatch.tap() }
        tap(app.buttons["server.film.fixture-film"].firstMatch, in: app)
        let removed = app.buttons["server.watchlist"]
        XCTAssertTrue(removed.waitForExistence(timeout: 8))
        XCTAssertEqual(removed.label, "Remove from Watchlist")
        tap(removed, in: app)
        // Removing the only film may also return the compact watchlist to its empty state.
        if removed.exists { expectLabel("Save to Watchlist", on: removed) }
    }

    func testPreparationAndConflict() throws {
        let app = launch(readOnly: true)
        tap(app.buttons["server.film.fixture-film"].firstMatch, in: app)
        XCTAssertTrue(app.buttons["film.resume"].waitForExistence(timeout: 12))
        XCTAssertFalse(app.buttons["server.watchlist"].exists)
        tap(app.buttons["film.resume"], in: app)
        let status = app.staticTexts["preparation.status"]
        XCTAssertTrue(status.waitForExistence(timeout: 12))
        capture(app, "Server preparation")
        let play = app.buttons["preparation.play"]
        XCTAssertTrue(play.waitForExistence(timeout: 18))
        XCTAssertEqual(status.label, "Ready to play")
        try audit(app)
        XCTAssertFalse(app.alerts["Another film is playing"].exists)
        tap(play, in: app)
        let conflict = app.alerts["Another film is playing"]
        XCTAssertTrue(conflict.waitForExistence(timeout: 12))
        capture(app, "Explicit playback conflict")
        conflict.buttons["Keep playing there"].tap()
        XCTAssertFalse(conflict.exists)
        XCTAssertFalse(app.buttons["player.close"].exists)
    }
}
#endif
