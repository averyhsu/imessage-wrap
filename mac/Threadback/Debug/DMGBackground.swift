#if DEBUG
import AppKit

/// The disk image's window background (Debug builds only; CI renders it with
/// `Threadback --tb-dmg-background DIR` and mac/scripts/make-dmg.sh uses it).
///
/// The window is 660 x 420 points. Finder puts the app icon at (170, 160) and the
/// Applications shortcut at (490, 160) (icon centres, from the top left). The icons sit on a
/// light card so Finder's dark icon labels stay readable; the three steps are below it.
enum DMGBackground {
    static let size = CGSize(width: 660, height: 420)
    static let appIcon = CGPoint(x: 170, y: 160)
    static let applicationsIcon = CGPoint(x: 490, y: 160)

    /// The steps, in the words macOS uses (checked against the runner in the Gatekeeper step).
    static let steps: [(String, NSColor)] = [
        ("Drag Threadback onto Applications.", MacPalette.blue),
        ("Open it from Applications. At \u{201C}Threadback\u{201D} Not Opened, click Done.", MacPalette.green),
        ("Then System Settings \u{203A} Privacy & Security, scroll down, click Open Anyway.", MacPalette.rgb(0xBF5AF2)),
    ]

    static func write(to folder: URL) throws {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        for (scale, name) in [(CGFloat(1), "background.png"), (CGFloat(2), "background@2x.png")] {
            guard let data = render(scale: scale) else { throw EngineError(code: "dmg", message: "could not render") }
            try data.write(to: folder.appendingPathComponent(name))
        }
    }

    static func render(scale: CGFloat) -> Data? {
        let width = Int(size.width * scale), height = Int(size.height * scale)
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let cg = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                 space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        cg.translateBy(x: 0, y: CGFloat(height))
        cg.scaleBy(x: scale, y: -scale)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(cgContext: cg, flipped: true)
        draw(cg)
        NSGraphicsContext.restoreGraphicsState()
        guard let image = cg.makeImage() else { return nil }
        let rep = NSBitmapImageRep(cgImage: image)
        rep.size = size  // 72 dpi at 1x, 144 dpi at 2x, so Finder uses the right one
        return rep.representation(using: .png, properties: [:])
    }

    private static func glow(_ cg: CGContext, center: CGPoint, radius: CGFloat, color: NSColor) {
        let colors = [color.cgColor, color.withAlphaComponent(0).cgColor] as CFArray
        if let gradient = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: colors, locations: [0, 1]) {
            cg.drawRadialGradient(gradient, startCenter: center, startRadius: 0, endCenter: center, endRadius: radius, options: [])
        }
    }

    private static func draw(_ cg: CGContext) {
        let rect = CGRect(origin: .zero, size: size)
        cg.setFillColor(MacPalette.night.cgColor)
        cg.fill(rect)
        glow(cg, center: CGPoint(x: 40, y: 20), radius: 320, color: MacPalette.blue.withAlphaComponent(0.42))
        glow(cg, center: CGPoint(x: 640, y: 420), radius: 300, color: MacPalette.rgb(0xBF5AF2).withAlphaComponent(0.25))

        // One mark and the name.
        if let mark = NSImage(named: "BrandMark") {
            mark.draw(in: CGRect(x: 28, y: 20, width: 26, height: 26))
        }
        NSAttributedString(string: "Threadback", attributes: [
            .font: NSFont.systemFont(ofSize: 15, weight: .heavy), .foregroundColor: NSColor.white,
        ]).draw(at: CGPoint(x: 62, y: 23))
        NSAttributedString(string: "INSTALL IN THREE STEPS", attributes: [
            .font: NSFont.systemFont(ofSize: 10.5, weight: .heavy), .foregroundColor: NSColor.white.withAlphaComponent(0.6), .kern: 1.4,
        ]).draw(at: CGPoint(x: 470, y: 26))

        // The light card under the two icons.
        let card = CGRect(x: 40, y: 64, width: 580, height: 196)
        cg.setFillColor(MacPalette.rgb(0xF2F2F7).cgColor)
        cg.addPath(CGPath(roundedRect: card, cornerWidth: 24, cornerHeight: 24, transform: nil))
        cg.fillPath()

        // The arrow from the app to Applications, with the step number on it.
        let y = appIcon.y - 6
        let start = CGPoint(x: appIcon.x + 78, y: y), end = CGPoint(x: applicationsIcon.x - 84, y: y)
        cg.setStrokeColor(MacPalette.blue.cgColor)
        cg.setLineWidth(7)
        cg.setLineCap(.round)
        cg.move(to: start)
        cg.addLine(to: CGPoint(x: end.x - 8, y: y))
        cg.strokePath()
        cg.setFillColor(MacPalette.blue.cgColor)
        cg.move(to: CGPoint(x: end.x + 8, y: y))
        cg.addLine(to: CGPoint(x: end.x - 16, y: y - 16))
        cg.addLine(to: CGPoint(x: end.x - 16, y: y + 16))
        cg.closePath()
        cg.fillPath()
        badge(cg, "1", center: CGPoint(x: (start.x + end.x) / 2, y: y - 34), color: MacPalette.blue)

        // The three steps.
        var top: CGFloat = 282
        for (index, step) in steps.enumerated() {
            badge(cg, "\(index + 1)", center: CGPoint(x: 58, y: top + 11), color: step.1)
            NSAttributedString(string: step.0, attributes: [
                .font: NSFont.systemFont(ofSize: 15, weight: .semibold), .foregroundColor: NSColor.white,
            ]).draw(with: CGRect(x: 80, y: top, width: 556, height: 40), options: [.usesLineFragmentOrigin], context: nil)
            top += 38
        }
    }

    private static func badge(_ cg: CGContext, _ text: String, center: CGPoint, color: NSColor) {
        let r: CGFloat = 12
        cg.setFillColor(color.cgColor)
        cg.fillEllipse(in: CGRect(x: center.x - r, y: center.y - r, width: 2 * r, height: 2 * r))
        let label = NSAttributedString(string: text, attributes: [
            .font: MacPalette.display(13, weight: .black), .foregroundColor: color == MacPalette.green ? NSColor.black : NSColor.white,
        ])
        let s = label.size()
        label.draw(at: CGPoint(x: center.x - s.width / 2, y: center.y - s.height / 2))
    }
}
#endif
