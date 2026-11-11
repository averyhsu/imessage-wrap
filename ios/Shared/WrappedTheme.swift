import SwiftUI
import UIKit

/// Brand colours shared by every native surface (app, launcher, bubble, share card).
enum WrappedTheme {
    static let pinkUI = UIColor(red: 1.00, green: 0.24, blue: 0.50, alpha: 1)
    static let violetUI = UIColor(red: 0.61, green: 0.30, blue: 1.00, alpha: 1)
    static let blueUI = UIColor(red: 0.24, green: 0.55, blue: 1.00, alpha: 1)
    static let inkUI = UIColor(red: 0.035, green: 0.03, blue: 0.07, alpha: 1)
    static let duskUI = UIColor(red: 0.09, green: 0.055, blue: 0.16, alpha: 1)

    static let pink = Color(uiColor: pinkUI)
    static let violet = Color(uiColor: violetUI)
    static let blue = Color(uiColor: blueUI)
    static let ink = Color(uiColor: inkUI)
    static let dusk = Color(uiColor: duskUI)

    /// The signature gradient: pink to violet to blue.
    static let brandGradient = LinearGradient(
        colors: [pink, violet, blue],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
    )

    static let brandGradientHorizontal = LinearGradient(
        colors: [pink, violet, blue],
        startPoint: .leading,
        endPoint: .trailing
    )

    /// Page background: deep violet-black fading to black.
    static let background = LinearGradient(
        colors: [dusk, ink, Color.black],
        startPoint: .top,
        endPoint: .bottom
    )

    static var brandCGColors: [CGColor] {
        return [pinkUI.cgColor, violetUI.cgColor, blueUI.cgColor]
    }

    /// A system font with the rounded design when available.
    static func roundedFont(ofSize size: CGFloat, weight: UIFont.Weight) -> UIFont {
        let base = UIFont.systemFont(ofSize: size, weight: weight)
        if let descriptor = base.fontDescriptor.withDesign(.rounded) {
            return UIFont(descriptor: descriptor, size: size)
        }
        return base
    }
}
