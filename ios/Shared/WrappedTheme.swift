import SwiftUI
import UIKit

/// Design tokens shared by every native surface (app, launcher, bubble, share card).
///
/// They mirror the web story (`web/css/base.css`, `story.css`, `landing.css`) so the
/// native shell and the story read as one product: the Messages palette used as graphic
/// material on a near-black page, heavy wide display type, pill buttons, and the story's
/// blue cover gradient with its rounded "blob" shapes.
enum WrappedTheme {
    private static func rgb(_ hex: UInt32, alpha: CGFloat = 1) -> UIColor {
        return UIColor(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: alpha
        )
    }

    // MARK: Palette (UIKit)

    static let blueUI = rgb(0x0A84FF)
    static let popBlueUI = rgb(0x5EB1FF)
    static let greenUI = rgb(0x30D158)
    static let pinkUI = rgb(0xFF2D55)
    static let purpleUI = rgb(0xBF5AF2)
    static let yellowUI = rgb(0xFFD60A)
    static let inkUI = rgb(0x0B0B0F)
    static let nightUI = rgb(0x07070C)

    /// The story's cover: `linear-gradient(165deg, #2a9bff 0%, #0a7aff 38%, #0047e0 100%)`.
    static let coverTopUI = rgb(0x2A9BFF)
    static let coverMidUI = rgb(0x0A7AFF)
    static let coverBottomUI = rgb(0x0047E0)
    /// The two blobs that sit behind the cover's text.
    static let blobLightUI = rgb(0x46A6FF)
    static let blobDeepUI = rgb(0x0036C2)

    static var coverCGColors: [CGColor] {
        return [coverTopUI.cgColor, coverMidUI.cgColor, coverBottomUI.cgColor]
    }

    static let coverLocations: [CGFloat] = [0.0, 0.38, 1.0]

    // MARK: Palette (SwiftUI)

    static let blue = Color(uiColor: blueUI)
    static let popBlue = Color(uiColor: popBlueUI)
    static let green = Color(uiColor: greenUI)
    static let pink = Color(uiColor: pinkUI)
    static let purple = Color(uiColor: purpleUI)
    static let yellow = Color(uiColor: yellowUI)
    static let ink = Color(uiColor: inkUI)
    static let night = Color(uiColor: nightUI)

    static let coverGradient = LinearGradient(
        stops: [
            Gradient.Stop(color: Color(uiColor: coverTopUI), location: 0.0),
            Gradient.Stop(color: Color(uiColor: coverMidUI), location: 0.38),
            Gradient.Stop(color: Color(uiColor: coverBottomUI), location: 1.0)
        ],
        startPoint: UnitPoint(x: 0.37, y: 0),
        endPoint: UnitPoint(x: 0.63, y: 1)
    )

    // MARK: Type

    /// Heavy, wide display type: the system font standing in for the story's Archivo.
    static func displayFont(ofSize size: CGFloat, weight: UIFont.Weight = .black) -> UIFont {
        return UIFont.systemFont(ofSize: size, weight: weight, width: .expanded)
    }

    static func display(_ size: CGFloat, weight: Font.Weight = .black) -> Font {
        return Font.system(size: size, weight: weight).width(.expanded)
    }
}

/// The page background: near-black with the soft colour glows of the web landing page.
struct ThemeBackground: View {
    var body: some View {
        ZStack {
            WrappedTheme.night
            RadialGradient(
                colors: [WrappedTheme.blue.opacity(0.46), WrappedTheme.blue.opacity(0)],
                center: UnitPoint(x: 0.05, y: 0.0),
                startRadius: 0,
                endRadius: 380
            )
            RadialGradient(
                colors: [WrappedTheme.purple.opacity(0.30), WrappedTheme.purple.opacity(0)],
                center: UnitPoint(x: 1.05, y: 0.42),
                startRadius: 0,
                endRadius: 330
            )
            RadialGradient(
                colors: [WrappedTheme.green.opacity(0.16), WrappedTheme.green.opacity(0)],
                center: UnitPoint(x: 0.0, y: 1.0),
                startRadius: 0,
                endRadius: 340
            )
        }
        .ignoresSafeArea()
    }
}

/// One half of a speech bubble with a tail at the lower left, in the proportions of the
/// web brand mark. The body and the tail are separate shapes that are filled one over the
/// other: as a single path, their opposite winding would cut a notch where they overlap.
struct BubbleShape: Shape {
    enum Part {
        case body
        case tail
    }

    var part: Part

    func path(in rect: CGRect) -> Path {
        let tailRoom = rect.width * 0.1
        let body = CGRect(
            x: rect.minX + tailRoom,
            y: rect.minY,
            width: rect.width - tailRoom,
            height: rect.height * 0.92
        )
        let radius = body.height / 2
        var path = Path()
        switch part {
        case .body:
            path.addRoundedRect(in: body, cornerSize: CGSize(width: radius, height: radius), style: .continuous)
        case .tail:
            path.move(to: CGPoint(x: body.minX + radius * 0.25, y: body.maxY - radius * 0.9))
            path.addQuadCurve(
                to: CGPoint(x: rect.minX, y: rect.maxY),
                control: CGPoint(x: body.minX + radius * 0.2, y: rect.maxY - rect.height * 0.08)
            )
            path.addQuadCurve(
                to: CGPoint(x: body.minX + radius * 1.1, y: body.maxY - radius * 0.08),
                control: CGPoint(x: body.minX + radius * 0.5, y: rect.maxY)
            )
            path.closeSubpath()
        }
        return path
    }
}

/// The brand mark: a blue speech bubble with three dots, as on the web.
struct BrandMark: View {
    /// Height of the mark; it is 1.3 times as wide.
    var size: CGFloat = 44
    var fill: Color = WrappedTheme.blue
    var dots: Color = Color.white

    var body: some View {
        ZStack {
            BubbleShape(part: .body)
                .fill(fill)
            BubbleShape(part: .tail)
                .fill(fill)
            HStack(spacing: size * 0.11) {
                dot
                dot
                dot
            }
            .offset(x: size * 0.065, y: -size * 0.04)
        }
        .frame(width: size * 1.3, height: size)
        .accessibilityHidden(true)
    }

    private var dot: some View {
        Circle()
            .fill(dots)
            .frame(width: size * 0.17, height: size * 0.17)
    }
}

/// Full-width primary pill button (solid blue).
struct PrimaryActionStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 17, weight: .heavy))
            .foregroundStyle(Color.white)
            .frame(maxWidth: .infinity)
            .frame(height: 52)
            .background(WrappedTheme.blue, in: Capsule())
            .opacity(configuration.isPressed ? 0.8 : 1)
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
    }
}

/// Full-width quiet pill button.
struct SecondaryActionStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 16, weight: .bold))
            .foregroundStyle(Color.white)
            .frame(maxWidth: .infinity)
            .frame(height: 48)
            .background(Color.white.opacity(configuration.isPressed ? 0.2 : 0.12), in: Capsule())
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
    }
}
