import UIKit

/// Draws the share card: the image of the message bubble's template layout. This is what
/// every member of the chat sees, including people without the app and Macs, so it has to
/// read well on its own: chat name, "<label> in review", and the total message count.
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

        // Eyebrow: "2026 IN REVIEW"
        let eyebrowFont = UIFont.systemFont(ofSize: 13, weight: .bold)
        let eyebrow = NSAttributedString(
            string: summary.reviewLabel.uppercased(),
            attributes: [
                .font: eyebrowFont,
                .foregroundColor: white.withAlphaComponent(0.86),
                .kern: 1.6
            ]
        )
        eyebrow.draw(at: CGPoint(x: content.minX, y: content.minY))

        // Chat name, up to two lines.
        let nameStyle = NSMutableParagraphStyle()
        nameStyle.lineBreakMode = .byWordWrapping
        nameStyle.lineHeightMultiple = 0.95
        let nameFont = WrappedTheme.roundedFont(ofSize: 27, weight: .heavy)
        let name = NSAttributedString(
            string: summary.chatName,
            attributes: [
                .font: nameFont,
                .foregroundColor: white,
                .paragraphStyle: nameStyle
            ]
        )
        let nameTop = content.minY + 22
        let nameRect = CGRect(x: content.minX, y: nameTop, width: content.width, height: nameFont.lineHeight * 2.0)
        name.draw(
            with: nameRect,
            options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine],
            context: nil
        )

        // Footer: product name on the left, "Tap to play" on the right.
        let footerFont = UIFont.systemFont(ofSize: 13, weight: .semibold)
        let footerAttributes: [NSAttributedString.Key: Any] = [
            .font: footerFont,
            .foregroundColor: white.withAlphaComponent(0.82)
        ]
        let brand = NSAttributedString(string: WrappedConfig.productName, attributes: footerAttributes)
        let play = NSAttributedString(string: "▶  Tap to play", attributes: footerAttributes)
        let footerY = content.maxY - footerFont.lineHeight
        brand.draw(at: CGPoint(x: content.minX, y: footerY))
        let playSize = play.size()
        play.draw(at: CGPoint(x: content.maxX - playSize.width, y: footerY))

        // Big number, sized to fit the width, sitting just above "messages".
        let unitFont = UIFont.systemFont(ofSize: 16, weight: .semibold)
        let unitText = summary.totalMessages == 1 ? "message" : "messages"
        let unit = NSAttributedString(
            string: unitText,
            attributes: [
                .font: unitFont,
                .foregroundColor: white.withAlphaComponent(0.9)
            ]
        )
        let unitY = footerY - 14 - unitFont.lineHeight
        unit.draw(at: CGPoint(x: content.minX, y: unitY))

        var numberSize: CGFloat = 76
        var number = numberString(summary.formattedTotal, size: numberSize)
        while number.size().width > content.width && numberSize > 30 {
            numberSize -= 4
            number = numberString(summary.formattedTotal, size: numberSize)
        }
        let numberFont = WrappedTheme.roundedFont(ofSize: numberSize, weight: .black)
        let numberY = unitY - numberFont.lineHeight + numberFont.lineHeight * 0.14
        number.draw(at: CGPoint(x: content.minX - 2, y: numberY))
    }

    private static func numberString(_ text: String, size: CGFloat) -> NSAttributedString {
        return NSAttributedString(
            string: text,
            attributes: [
                .font: WrappedTheme.roundedFont(ofSize: size, weight: .black),
                .foregroundColor: UIColor.white,
                .kern: -1.5
            ]
        )
    }

    private static func drawBackground(in rect: CGRect, context: CGContext) {
        let space = CGColorSpaceCreateDeviceRGB()
        let colors = WrappedTheme.brandCGColors as CFArray
        let locations: [CGFloat] = [0.0, 0.55, 1.0]

        context.saveGState()
        if let gradient = CGGradient(colorsSpace: space, colors: colors, locations: locations) {
            context.drawLinearGradient(
                gradient,
                start: CGPoint(x: rect.minX, y: rect.minY),
                end: CGPoint(x: rect.maxX, y: rect.maxY),
                options: [.drawsBeforeStartLocation, .drawsAfterEndLocation]
            )
        } else {
            context.setFillColor(WrappedTheme.violetUI.cgColor)
            context.fill(rect)
        }

        // Soft translucent discs for depth.
        context.setFillColor(UIColor.white.withAlphaComponent(0.10).cgColor)
        context.fillEllipse(in: CGRect(x: rect.maxX - 150, y: rect.minY - 90, width: 250, height: 250))
        context.setFillColor(UIColor.white.withAlphaComponent(0.07).cgColor)
        context.fillEllipse(in: CGRect(x: rect.maxX - 110, y: rect.maxY - 120, width: 200, height: 200))

        // Darken the lower half slightly so white text keeps its contrast on the blue end.
        let shadeColors = [
            UIColor.black.withAlphaComponent(0.0).cgColor,
            UIColor.black.withAlphaComponent(0.28).cgColor
        ] as CFArray
        if let shade = CGGradient(colorsSpace: space, colors: shadeColors, locations: [0.0, 1.0]) {
            context.drawLinearGradient(
                shade,
                start: CGPoint(x: rect.midX, y: rect.minY),
                end: CGPoint(x: rect.midX, y: rect.maxY),
                options: []
            )
        }
        context.restoreGState()
    }
}
