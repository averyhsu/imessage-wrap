import XCTest
@testable import Wrapped

final class SmokeTests: XCTestCase {
    func testBaseURLIsHTTPSAndEndsWithSlash() {
        XCTAssertEqual(WrappedConfig.baseURL.scheme, "https")
        XCTAssertTrue(WrappedConfig.baseURLString.hasSuffix("/"))
    }
}
