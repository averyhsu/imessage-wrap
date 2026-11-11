import UIKit

/// Draws the share card: the image of the message bubble's template layout. This is what
/// every member of the chat sees, including people without the app and Macs, so it has to
/// read well on its own: chat name, "<label> in review", and the total message count.
/// It borrows the look of the story's cover slide (blue gradient, two rounded blobs).
enum RecapCardRenderer {
    /// 4:3 card. Rendered at 3x this is 1080 x 810 pixels.
    static let pointSize = CGSize(width: 360, height: 270)

    static func image(for summary: RecapSummary, scale: CGFloat = 3) -> UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = scale
        format.opaque = true
        let renderer = UIGraphicsImageRenderer(size: pointSize, format: format)
        return renderer.image { (context: UIGraphicsImageRendererContext) in
            draw(summary, in: CGRect(origin: .zero, size: pointSize), context: context.cgContext)
        }
    }

    static func pngData(for summary: RecapSummary, scale: CGFloat = 3) -> Data? {
        return image(for: summary, scale: scale).pngData()
    }

    // MARK: Drawing

    private static func draw(_ summary: RecapSummary, in rect: CGRect, context: CGContext) {
        drawBackground(in: rect, context: context)

        let inset: CGFloat = 22
        let content = rect.insetBy(dx: inset, dy: inset)
        let white = UIColor.white

        // Brand mark, top right: a white bubble with three dots.
        drawBrandMark(in: CGRect(x: content.maxX - 44, y: content.minY - 4, width: 44, height: 31), context: context)

        // Eyebrow: "2026 IN REVIEW"
        let eyebrow = NSAttributedString(
            string: summary.reviewLabel.uppercased(),
            attributes: [
                .font: WrappedTheme.displayFont(ofSize: 12, weight: .heavy),
                .foregroundColor: white.withAlphaComponent(0.86),
                .kern: 1.4
            ]
        )
        eyebrow.draw(at: CGPoint(x: content.minX, y: content.minY))

        // Chat name, up to two lines.
        let nameStyle = NSMutableParagraphStyle()
        nameStyle.lineBreakMode = .byWordWrapping
        nameStyle.lineHeightMultiple = 0.92
        let nameFont = WrappedTheme.displayFont(ofSize: 24, weight: .black)
        let name = NSAttributedString(
            string: summary.chatName,
            attributes: [
                .font: nameFont,
                .foregroundColor: white,
                .paragraphStyle: nameStyle,
                .kern: -0.4
            ]
        )
        let nameRect = CGRect(
            x: content.minX,
            y: content.minY + 22,
            width: content.width - 50,
            height: nameFont.lineHeight * 2.0
        )
        name.draw(
            with: nameRect,
            options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine],
            context: nil
        )

        // Footer: product name on the left, "Tap to play" on the right.
        let footerFont = UIFont.systemFont(ofSize: 13, weight: .bold)
        let footerAttributes: [NSAttributedString.Key: Any] = [
            .font: footerFont,
            .foregroundColor: white.withAlphaComponent(0.86)
        ]
        let brand = NSAttributedString(string: WrappedConfig.productName, attributes: footerAttributes)
        let play = NSAttributedString(string: "▶  Tap to play", attributes: footerAttributes)
        let footerY = content.maxY - footerFont.lineHeight
        brand.draw(at: CGPoint(x: content.minX, y: footerY))
        let playSize = play.size()
        play.draw(at: CGPoint(x: content.maxX - playSize.width, y: footerY))

        // "messages" just above the footer, and the big number sitting on top of it.
        let unitFont = WrappedTheme.displayFont(ofSize: 17, weight: .black)
        let unit = NSAttributedString(
            string: summary.totalMessages == 1 ? "message" : "messages",
            attributes: [
                .font: unitFont,
                .foregroundColor: white
            ]
        )
        let unitY = footerY - 12 - unitFont.lineHeight
        unit.draw(at: CGPoint(x: content.minX, y: unitY))

        var numberSize: CGFloat = 74
        var number = numberString(summary.formattedTotal, size: numberSize)
        while number.size().width > content.width && numberSize > 28 {
            numberSize -= 3
            number = numberString(summary.formattedTotal, size: numberSize)
        }
        let numberFont = WrappedTheme.displayFont(ofSize: numberSize, weight: .black)
        // Sit the digits' baseline a few points above the "messages" line.
        let baseline = unitY - 1
        let numberY = baseline - numberFont.ascender
        number.draw(at: CGPoint(x: content.minX - 3, y: numberY))
    }

    private static func numberString(_ text: String, size: CGFloat) -> NSAttributedString {
        return NSAttributedString(
            string: text,
            attributes: [
                .font: WrappedTheme.displayFont(ofSize: size, weight: .black),
                .foregroundColor: UIColor.white,
                .kern: -size * 0.035
            ]
        )
    }

    private static func drawBackground(in rect: CGRect, context: CGContext) {
        let space = CGColorSpaceCreateDeviceRGB()
        context.saveGState()
        context.clip(to: rect)

        if let gradient = CGGradient(
            colorsSpace: space,
            colors: WrappedTheme.coverCGColors as CFArray,
            locations: WrappedTheme.coverLocations
        ) {
            context.drawLinearGradient(
                gradient,
                start: CGPoint(x: rect.midX - rect.height * 0.13, y: rect.minY),
                end: CGPoint(x: rect.midX + rect.height * 0.13, y: rect.maxY),
                options: [.drawsBeforeStartLocation, .drawsAfterEndLocation]
            )
        } else {
            context.setFillColor(WrappedTheme.blueUI.cgColor)
            context.fill(rect)
        }

        // The cover's two blobs: a lighter one leaning in from the top right and a deep
        // one from the bottom left.
        drawBlob(
            center: CGPoint(x: rect.maxX + 10, y: rect.minY - 10),
            size: CGSize(width: 250, height: 170),
            degrees: 14,
            color: WrappedTheme.blobLightUI,
            context: context
        )
        drawBlob(
            center: CGPoint(x: rect.minX + 24, y: rect.maxY + 30),
            size: CGSize(width: 270, height: 190),
            degrees: -10,
            color: WrappedTheme.blobDeepUI.withAlphaComponent(0.78),
            context: context
        )
        context.restoreGState()
    }

    private static func drawBlob(center: CGPoint, size: CGSize, degrees: CGFloat, color: UIColor, context: CGContext) {
        context.saveGState()
        context.translateBy(x: center.x, y: center.y)
        context.rotate(by: degrees * .pi / 180)
        let blob = CGRect(x: -size.width / 2, y: -size.height / 2, width: size.width, height: size.height)
        let path = UIBezierPath(roundedRect: blob, cornerRadius: min(size.width, size.height) * 0.36)
        context.setFillColor(color.cgColor)
        context.addPath(path.cgPath)
        context.fillPath()
        context.restoreGState()
    }

    /// A small white speech bubble with three dots.
    private static func drawBrandMark(in rect: CGRect, context: CGContext) {
        context.saveGState()
        let tailRoom = rect.width * 0.1
        let body = CGRect(x: rect.minX + tailRoom, y: rect.minY, width: rect.width - tailRoom, height: rect.height * 0.92)
        let radius = body.height / 2
        let bubble = UIBezierPath(roundedRect: body, cornerRadius: radius)
        let tail = UIBezierPath()
        tail.move(to: CGPoint(x: body.minX + radius * 0.25, y: body.maxY - radius * 0.9))
        tail.addQuadCurve(
            to: CGPoint(x: rect.minX, y: rect.maxY),
            controlPoint: CGPoint(x: body.minX + radius * 0.2, y: rect.maxY - rect.height * 0.08)
        )
        tail.addQuadCurve(
            to: CGPoint(x: body.minX + radius * 1.1, y: body.maxY - radius * 0.08),
            controlPoint: CGPoint(x: body.minX + radius * 0.5, y: rect.maxY)
        )
        tail.close()
        context.setFillColor(UIColor.white.cgColor)
        context.addPath(bubble.cgPath)
        context.addPath(tail.cgPath)
        context.fillPath()

        let dot = rect.height * 0.17
        let gap = rect.height * 0.11
        let total = dot * 3 + gap * 2
        var x = body.midX - total / 2
        let y = body.midY - dot / 2
        context.setFillColor(WrappedTheme.blueUI.cgColor)
        for _ in 0..<3 {
            context.fillEllipse(in: CGRect(x: x, y: y, width: dot, height: dot))
            x += dot + gap
        }
        context.restoreGState()
    }
}
