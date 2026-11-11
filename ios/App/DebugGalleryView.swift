import SwiftUI
import UIKit

/// Debug only (`--gallery`): the extension's native views rendered inside the containing
/// app so their design can be checked in CI screenshots. This is NOT the extension running
/// inside Messages, and every screenshot of it says so on screen.
struct DebugGalleryView: View {
    @StateObject private var launcher = LauncherModel()

    private static let sampleRecents: [Recap] = {
        let samples = [
            "{\"v\":1,\"chat\":{\"name\":\"Trail Mix Hikers\",\"members\":5},\"period\":{\"label\":\"2026\"},\"totals\":{\"messages\":9321}}",
            "{\"v\":1,\"chat\":{\"name\":\"Flat 4B\",\"members\":4},\"period\":{\"label\":\"2025\"},\"totals\":{\"messages\":20417}}"
        ]
        var recaps: [Recap] = []
        for sample in samples {
            if let recap = try? Recap(statsJSON: Data(sample.utf8)) {
                recaps.append(recap)
            }
        }
        return recaps
    }()

    private static let demoCard: UIImage = RecapCardRenderer.image(for: DemoRecap.recap.summary, scale: 2)

    var body: some View {
        ZStack {
            Color.black
                .ignoresSafeArea()
            ScrollView(.vertical, showsIndicators: false) {
                VStack(alignment: .leading, spacing: 22) {
                    Text("Debug gallery")
                        .font(.system(size: 28, weight: .heavy, design: .rounded))
                        .foregroundStyle(Color.white)
                        .accessibilityIdentifier("gallery.title")
                    Text("Extension views hosted in the containing app for design checks. This is not Messages.")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Color.black)
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.yellow, in: RoundedRectangle(cornerRadius: 10, style: .continuous))

                    section("Template card (image + caption every member sees)") {
                        VStack(alignment: .leading, spacing: 6) {
                            Image(uiImage: DebugGalleryView.demoCard)
                                .resizable()
                                .aspectRatio(contentMode: .fit)
                                .frame(maxWidth: 300)
                                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                            Text(DemoRecap.recap.summary.caption)
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(Color.white)
                            Text(DemoRecap.recap.summary.subcaption)
                                .font(.system(size: 13, weight: .regular))
                                .foregroundStyle(Color.white.opacity(0.6))
                        }
                    }

                    section("Live bubble (transcript style)") {
                        BubblePreview(summary: DemoRecap.recap.summary)
                            .frame(width: 300, height: 188)
                            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                            .accessibilityIdentifier("gallery.bubble")
                    }

                    section("Launcher (compact style, 300 pt tall)") {
                        LauncherView(model: launcher)
                            .frame(height: 300)
                            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                            .overlay {
                                RoundedRectangle(cornerRadius: 18, style: .continuous)
                                    .stroke(Color.white.opacity(0.15), lineWidth: 1)
                            }
                    }
                }
                .padding(18)
            }
        }
        .onAppear {
            launcher.recents = DebugGalleryView.sampleRecents
        }
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title.uppercased())
                .font(.system(size: 11, weight: .bold))
                .kerning(1.1)
                .foregroundStyle(Color.white.opacity(0.55))
            content()
        }
    }
}

/// Wraps the UIKit live bubble for the gallery.
private struct BubblePreview: UIViewRepresentable {
    let summary: RecapSummary?

    func makeUIView(context: Context) -> RecapBubbleView {
        return RecapBubbleView(frame: .zero)
    }

    func updateUIView(_ uiView: RecapBubbleView, context: Context) {
        uiView.configure(with: summary)
    }
}
