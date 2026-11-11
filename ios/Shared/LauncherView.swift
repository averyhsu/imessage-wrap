import SwiftUI
import UIKit

/// State and actions of the launcher. The iMessage extension owns one and wires the
/// closures to the conversation; the app's debug gallery uses one with no-op closures.
final class LauncherModel: ObservableObject {
    @Published var recents: [Recap] = []
    @Published var notice: String?
    /// False in the compact style (keyboard-sized), true in the expanded style.
    @Published var isRoomy = false

    var onSendDemo: () -> Void = {}
    var onPasteLink: () -> Void = {}
    var onPlay: (Recap) -> Void = { _ in }
    var onSend: (Recap) -> Void = { _ in }
}

/// The launcher shown when the extension is opened from the Messages app drawer.
/// It is a graphic panel of its own, not an imitation of a Messages thread.
struct LauncherView: View {
    @ObservedObject var model: LauncherModel

    private static let demoCard: UIImage = RecapCardRenderer.image(for: DemoRecap.recap.summary, scale: 2)

    var body: some View {
        ZStack {
            WrappedTheme.background
                .ignoresSafeArea()
            ScrollView(.vertical, showsIndicators: false) {
                VStack(alignment: .leading, spacing: model.isRoomy ? 18 : 10) {
                    header
                    if model.isRoomy {
                        cardPreview
                    }
                    actions
                    if let notice = model.notice {
                        noticeView(notice)
                    }
                    recentsSection
                    if model.isRoomy {
                        footer
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, model.isRoomy ? 20 : 12)
                .padding(.bottom, 12)
                .frame(maxWidth: 520, alignment: .leading)
                .frame(maxWidth: .infinity)
            }
        }
        .preferredColorScheme(.dark)
    }

    // MARK: Pieces

    private var headlineSize: CGFloat {
        return model.isRoomy ? 34 : 23
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 0) {
                Text("Your group chat,")
                    .font(.system(size: headlineSize, weight: .heavy, design: .rounded))
                    .foregroundStyle(Color.white)
                Text("in review.")
                    .font(.system(size: headlineSize, weight: .heavy, design: .rounded))
                    .foregroundStyle(WrappedTheme.brandGradientHorizontal)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("launcher.headline")
            Spacer(minLength: 0)
            BrandMark(size: model.isRoomy ? 54 : 44)
        }
    }

    private var cardPreview: some View {
        Image(uiImage: LauncherView.demoCard)
            .resizable()
            .aspectRatio(contentMode: .fit)
            .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
            .shadow(color: WrappedTheme.violet.opacity(0.45), radius: 24, x: 0, y: 12)
            .accessibilityLabel("Preview of the demo recap card")
    }

    private var actions: some View {
        VStack(spacing: 8) {
            Button(action: { model.onSendDemo() }) {
                Label("Send the demo recap", systemImage: "paperplane.fill")
            }
            .buttonStyle(PrimaryActionStyle())
            .accessibilityIdentifier("launcher.sendDemo")

            Button(action: { model.onPasteLink() }) {
                Label("Paste a recap link", systemImage: "link")
            }
            .buttonStyle(SecondaryActionStyle())
            .accessibilityIdentifier("launcher.paste")
        }
    }

    private func noticeView(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.circle.fill")
                .foregroundStyle(WrappedTheme.pink)
            Text(text)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Color.white.opacity(0.85))
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(10)
        .background(Color.white.opacity(0.07), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .accessibilityIdentifier("launcher.notice")
    }

    @ViewBuilder
    private var recentsSection: some View {
        if !model.recents.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("RECENT RECAPS")
                    .font(.system(size: 11, weight: .bold))
                    .kerning(1.2)
                    .foregroundStyle(Color.white.opacity(0.55))
                if model.isRoomy {
                    VStack(spacing: 8) {
                        ForEach(model.recents) { recap in
                            row(for: recap)
                        }
                    }
                } else {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(model.recents) { recap in
                                row(for: recap)
                                    .frame(width: 250)
                            }
                        }
                    }
                }
            }
        }
    }

    private func row(for recap: Recap) -> some View {
        RecentRecapRow(
            recap: recap,
            onPlay: { model.onPlay(recap) },
            onSend: { model.onSend(recap) }
        )
    }

    private var footer: some View {
        Text("A recap travels inside its link. Nothing is uploaded, and this app never reads your messages.")
            .font(.system(size: 12, weight: .regular))
            .foregroundStyle(Color.white.opacity(0.5))
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, 2)
    }
}

/// One remembered recap: tap the row to play it, tap the paper plane to send it.
private struct RecentRecapRow: View {
    let recap: Recap
    let onPlay: () -> Void
    let onSend: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Button(action: onPlay) {
                HStack(spacing: 10) {
                    Image(systemName: "play.fill")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(Color.white)
                        .frame(width: 32, height: 32)
                        .background(WrappedTheme.brandGradient, in: Circle())
                    VStack(alignment: .leading, spacing: 2) {
                        Text(recap.summary.chatName)
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(Color.white)
                            .lineLimit(1)
                        Text("\(recap.summary.reviewLabel) · \(recap.summary.messagesLine)")
                            .font(.system(size: 12, weight: .regular))
                            .foregroundStyle(Color.white.opacity(0.6))
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Play \(recap.summary.caption)")

            Button(action: onSend) {
                Image(systemName: "paperplane.fill")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(Color.white)
                    .frame(width: 34, height: 34)
                    .background(Color.white.opacity(0.14), in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Send \(recap.summary.caption)")
        }
        .padding(10)
        .background(Color.white.opacity(0.07), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

/// The app's mark, drawn in SwiftUI: a gradient tile with three rising bars.
struct BrandMark: View {
    var size: CGFloat = 44

    var body: some View {
        RoundedRectangle(cornerRadius: size * 0.3, style: .continuous)
            .fill(WrappedTheme.brandGradient)
            .frame(width: size, height: size)
            .overlay {
                HStack(alignment: .bottom, spacing: size * 0.08) {
                    bar(height: 0.26)
                    bar(height: 0.40)
                    bar(height: 0.54)
                }
            }
            .accessibilityHidden(true)
    }

    private func bar(height: CGFloat) -> some View {
        Capsule()
            .fill(Color.white)
            .frame(width: size * 0.13, height: size * height)
    }
}

/// Full-width gradient button.
struct PrimaryActionStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 17, weight: .bold, design: .rounded))
            .foregroundStyle(Color.white)
            .frame(maxWidth: .infinity)
            .frame(height: 50)
            .background(
                WrappedTheme.brandGradientHorizontal,
                in: RoundedRectangle(cornerRadius: 16, style: .continuous)
            )
            .opacity(configuration.isPressed ? 0.82 : 1)
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
    }
}

/// Full-width quiet button.
struct SecondaryActionStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 16, weight: .semibold, design: .rounded))
            .foregroundStyle(Color.white)
            .frame(maxWidth: .infinity)
            .frame(height: 46)
            .background(
                Color.white.opacity(configuration.isPressed ? 0.16 : 0.10),
                in: RoundedRectangle(cornerRadius: 16, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(Color.white.opacity(0.14), lineWidth: 1)
            }
    }
}
