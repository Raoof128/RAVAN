#if DEBUG || RAVAN_UI_TESTING
import XCTest

@MainActor final class CompactNavigationTests: XCTestCase {
    #if PAIRED
    func testFirstLaunchCanReadAndConnectWithoutImportingAFilm() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--ravan-isolated-test"]
        app.launch()
        preparePortrait(app)
        tap(app.buttons["welcome.reading"], app: app)
        let reader = app.buttons["destination.reading"]
        XCTAssertTrue(reader.waitForExistence(timeout: 15))
        XCTAssertTrue(reader.isSelected)
        XCTAssertTrue(app.buttons["reading.website"].exists)
        tap(app.buttons["reading.connect"], app: app)
        XCTAssertTrue(app.buttons["server.website"].waitForExistence(timeout: 10))
    }
    #endif

    func testTaskBarAndScrollViewOccupySeparateRegions() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--ravan-isolated-test", "--ravan-test-library"]
        app.launch()
        preparePortrait(app)
        guard app.frame.width < 720 else { throw XCTSkip("This test exercises the compact window layout.") }

        let library = app.buttons["destination.library"]
        let watchlist = app.buttons["destination.watchlist"]
        let settings = app.buttons["destination.cinema"]
        XCTAssertTrue(library.waitForExistence(timeout: 15))
        for button in [library, watchlist, settings] {
            XCTAssertTrue(button.isHittable)
            XCTAssertGreaterThanOrEqual(button.frame.height, 44)
        }
        XCTAssertTrue(library.isSelected)
        let visibleLibraryTabs = app.buttons.matching(NSPredicate(format: "label == %@", "Library"))
            .allElementsBoundByIndex.filter(\.isHittable)
        if visibleLibraryTabs.count != 1 {
            let details = XCTAttachment(string: app.debugDescription)
            details.name = "Compact fixture navigation tree"
            details.lifetime = .keepAlways
            add(details)
        }
        XCTAssertEqual(visibleLibraryTabs.count, 1)

        func checkViewport(containing control: String, file: StaticString = #filePath, line: UInt = #line) {
            let scroll = app.scrollViews.containing(.button, identifier: control).firstMatch
            XCTAssertTrue(scroll.waitForExistence(timeout: 12), file: file, line: line)
            XCTAssertLessThanOrEqual(scroll.frame.maxY, library.frame.minY + 1, file: file, line: line)
        }
        checkViewport(containing: "library.files")
        let sample = app.buttons["film.sample"].firstMatch
        for _ in 0..<4 where !sample.isHittable { app.swipeUp() }
        XCTAssertTrue(sample.isHittable)
        sample.tap()
        checkViewport(containing: "screening.play")
        watchlist.tap()
        XCTAssertTrue(watchlist.isSelected)
        settings.tap()
        checkViewport(containing: "cinema.files")
        library.tap()
        XCTAssertTrue(library.isSelected)
        XCTAssertTrue(app.buttons["screening.play"].waitForExistence(timeout: 10))
        checkViewport(containing: "screening.play")
    }
}
#endif
