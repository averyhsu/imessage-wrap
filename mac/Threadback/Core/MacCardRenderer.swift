import AppKit

/// Colours of the brand, the same values as ios/Shared/WrappedTheme.swift (UIKit there).
enum MacPalette {
    static func rgb(_ hex: UInt32, alpha: CGFloat = 1) -> NSColor {
        return NSColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
                       blue: CGFloat(hex & 0xFF) / 255, alpha: alpha)
    }

    static let blue = rgb(0x0A84FF)
    static let green = rgb(0x30D158)
    static let ink = rgb(0x0B0B0F)
    static let night = rgb(0x07070C)
    static let coverTop = rgb(0x2A9BFF)
    static let coverMid = rgb(0x0A7AFF)
    static let coverBottom = rgb(0x0047E0)
    static let blobLight = rgb(0x46A6FF)
    static let blobDeep = rgb(0x0036C2)

    static func display(_ size: CGFloat, weight: NSFont.Weight = .black) -> NSFont {
        return NSFont.systemFont(ofSize: size, weight: weight, width: .expanded)
    }
}

/// The recap image sent into the thread: a port of ios/Shared/RecapCardRenderer.swift
/// (UIKit) to AppKit, same layout and the same `RecapSummary` input. Copied rather than
/// shared because the iOS file is built on UIGraphicsImageRenderer/UIBezierPath/UIFont;
/// making it compile for both would touch most of its lines. One text differs: the footer
/// says "Full story in the link" instead of "Tap to play", because in the thread the image
/// is a plain picture and the link follows as its own message.
enum MacCardRenderer {
    static let pointSize = CGSize(width: 360, height: 270)

    /// PNG bytes, 1080 x 810 at the default scale.
    static func pngData(for summary: RecapSummary, eyebrow: String? = nil, scale: CGFloat = 3) -> Data? {
        let width = Int(pointSize.width * scale)
        let height = Int(pointSize.height * scale)
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let cg = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                 space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        // Top-left origin, in points.
        cg.translateBy(x: 0, y: CGFloat(height))
        cg.scaleBy(x: scale, y: -scale)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(cgContext: cg, flipped: true)
        draw(summary, eyebrow: eyebrow ?? summary.reviewLabel.uppercased(), in: CGRect(origin: .zero, size: pointSize), context: cg)
        NSGraphicsContext.restoreGraphicsState()
        guard let image = cg.makeImage() else { return nil }
        let rep = NSBitmapImageRep(cgImage: image)
        return rep.representation(using: .png, properties: [:])
    }

    private static func lineHeight(_ font: NSFont) -> CGFloat {
        return ceil(font.ascender - font.descender + font.leading)
    }

    private static func draw(_ summary: RecapSummary, eyebrow eyebrowText: String, in rect: CGRect, context: CGContext) {
        drawBackground(in: rect, context: context)
        let content = rect.insetBy(dx: 22, dy: 22)
        let white = NSColor.white

        let eyebrow = NSAttributedString(string: eyebrowText, attributes: [
            .font: MacPalette.display(11.5, weight: .heavy), .foregroundColor: white, .kern: 1.3,
        ])
        let eyebrowSize = eyebrow.size()
        let pill = CGRect(x: content.maxX - eyebrowSize.width - 20, y: content.minY - 5,
                          width: eyebrowSize.width + 20, height: eyebrowSize.height + 10)
        context.setFillColor(white.withAlphaComponent(0.2).cgColor)
        context.addPath(CGPath(roundedRect: pill, cornerWidth: pill.height / 2, cornerHeight: pill.height / 2, transform: nil))
        context.fillPath()
        eyebrow.draw(at: CGPoint(x: pill.minX + 10.5, y: pill.minY + 5))

        let nameStyle = NSMutableParagraphStyle()
        nameStyle.lineBreakMode = .byWordWrapping
        nameStyle.lineHeightMultiple = 0.92
        let nameFont = MacPalette.display(24, weight: .black)
        let name = NSAttributedString(string: summary.chatName, attributes: [
            .font: nameFont, .foregroundColor: white, .paragraphStyle: nameStyle, .kern: -0.4,
        ])
        let nameRect = CGRect(x: content.minX, y: content.minY + 26, width: content.width, height: lineHeight(nameFont) * 2.0)
        name.draw(with: nameRect, options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], context: nil)

        let footerFont = NSFont.systemFont(ofSize: 13, weight: .bold)
        let footerAttributes: [NSAttributedString.Key: Any] = [.font: footerFont, .foregroundColor: white.withAlphaComponent(0.86)]
        let brand = NSAttributedString(string: WrappedConfig.productName, attributes: footerAttributes)
        let story = NSAttributedString(string: "Full story in the link \u{2193}", attributes: footerAttributes)
        let footerY = content.maxY - lineHeight(footerFont)
        brand.draw(at: CGPoint(x: content.minX, y: footerY))
        story.draw(at: CGPoint(x: content.maxX - story.size().width, y: footerY))

        let unitFont = MacPalette.display(17, weight: .black)
        let unit = NSAttributedString(string: summary.totalMessages == 1 ? "message" : "messages",
                                      attributes: [.font: unitFont, .foregroundColor: white])
        let unitY = footerY - 12 - lineHeight(unitFont)
        unit.draw(at: CGPoint(x: content.minX, y: unitY))

        var numberSize: CGFloat = 74
        var number = numberString(summary.formattedTotal, size: numberSize)
        while number.size().width > content.width && numberSize > 28 {
            numberSize -= 3
            number = numberString(summary.formattedTotal, size: numberSize)
        }
        let numberFont = MacPalette.display(numberSize, weight: .black)
        let baseline = unitY - numberSize * 0.12
        number.draw(at: CGPoint(x: content.minX - 3, y: baseline - numberFont.ascender))
    }

    private static func numberString(_ text: String, size: CGFloat) -> NSAttributedString {
        return NSAttributedString(string: text, attributes: [
            .font: MacPalette.display(size, weight: .black), .foregroundColor: NSColor.white, .kern: -size * 0.035,
        ])
    }

    private static func drawBackground(in rect: CGRect, context: CGContext) {
        context.saveGState()
        context.clip(to: rect)
        let colors = [MacPalette.coverTop.cgColor, MacPalette.coverMid.cgColor, MacPalette.coverBottom.cgColor] as CFArray
        if let gradient = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: colors, locations: [0, 0.38, 1]) {
            context.drawLinearGradient(gradient,
                                       start: CGPoint(x: rect.midX - rect.height * 0.13, y: rect.minY),
                                       end: CGPoint(x: rect.midX + rect.height * 0.13, y: rect.maxY),
                                       options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
        }
        drawBlob(center: CGPoint(x: rect.maxX + 10, y: rect.minY - 10), size: CGSize(width: 250, height: 170),
                 degrees: 14, color: MacPalette.blobLight, context: context)
        drawBlob(center: CGPoint(x: rect.minX + 24, y: rect.maxY + 30), size: CGSize(width: 270, height: 190),
                 degrees: -10, color: MacPalette.blobDeep.withAlphaComponent(0.78), context: context)
        context.restoreGState()
    }

    private static func drawBlob(center: CGPoint, size: CGSize, degrees: CGFloat, color: NSColor, context: CGContext) {
        context.saveGState()
        context.translateBy(x: center.x, y: center.y)
        context.rotate(by: degrees * .pi / 180)
        let blob = CGRect(x: -size.width / 2, y: -size.height / 2, width: size.width, height: size.height)
        let radius = min(size.width, size.height) * 0.36
        context.setFillColor(color.cgColor)
        context.addPath(CGPath(roundedRect: blob, cornerWidth: radius, cornerHeight: radius, transform: nil))
        context.fillPath()
        context.restoreGState()
    }
}
