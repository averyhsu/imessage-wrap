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
    /// Debug builds only: stage the demo with a chosen layout (`true` = live bubble,
    /// `false` = template card alone), whatever `WrappedConfig.useLiveLayout` says.
    var onSendDemoWithLayout: (Bool) -> Void = { _ in }
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
            ThemeBackground()
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
                    } else if model.recents.isEmpty && model.notice == nil {
                        hint
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
        return model.isRoomy ? 32 : 21
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: -1) {
                Text("Your group chat,")
                    .font(WrappedTheme.display(headlineSize))
                    .foregroundStyle(Color.white)
                Text("in review.")
                    .font(WrappedTheme.display(headlineSize))
                    .foregroundStyle(WrappedTheme.popBlue)
            }
            .lineLimit(1)
            .minimumScaleFactor(0.7)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("launcher.headline")
            Spacer(minLength: 0)
            #if DEBUG
            // Test hooks, debug builds only (see `onSendDemoWithLayout`).
            debugHook(live: true)
            debugHook(live: false)
            #endif
            BrandMark(size: model.isRoomy ? 44 : 34)
        }
    }

    #if DEBUG
    /// An invisible control that stages the demo with a chosen layout, so the UI tests can
    /// capture both the live bubble and the template card whatever the default is.
    private func debugHook(live: Bool) -> some View {
        Button(action: { model.onSendDemoWithLayout(live) }) {
            Color.white.opacity(0.001)
                .frame(width: 14, height: 14)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(live ? "launcher.sendDemoLive" : "launcher.sendDemoTemplate")
        .accessibilityLabel(live ? "Send the demo as a live bubble (debug)" : "Send the demo as a template card (debug)")
    }
    #endif

    private var cardPreview: some View {
        Image(uiImage: LauncherView.demoCard)
            .resizable()
            .aspectRatio(contentMode: .fit)
            .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
            .shadow(color: WrappedTheme.blue.opacity(0.4), radius: 24, x: 0, y: 12)
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
                .foregroundStyle(WrappedTheme.yellow)
            Text(text)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Color.white.opacity(0.85))
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(10)
        .background(Color.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .accessibilityIdentifier("launcher.notice")
    }

    @ViewBuilder
    private var recentsSection: some View {
        if !model.recents.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("RECENT RECAPS")
                    .font(WrappedTheme.display(10.5, weight: .heavy))
                    .kerning(1.2)
                    .foregroundStyle(Color.white.opacity(0.62))
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

    /// Fills the compact style when there is nothing else to show yet.
    private var hint: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "sparkles")
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(WrappedTheme.popBlue)
                .padding(.top, 1)
            Text("It lands in the chat as a card everyone can tap. With the app it plays as a story; without it, the link opens the same story on the web.")
                .font(.system(size: 13, weight: .regular))
                .foregroundStyle(Color.white.opacity(0.62))
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.top, 4)
        .padding(.horizontal, 4)
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
                        .background(WrappedTheme.blue, in: Circle())
                    VStack(alignment: .leading, spacing: 2) {
                        Text(recap.summary.chatName)
                            .font(.system(size: 15, weight: .bold))
                            .foregroundStyle(Color.white)
                            .lineLimit(1)
                        Text(recap.summary.shortLine)
                            .font(.system(size: 12, weight: .regular))
                            .foregroundStyle(Color.white.opacity(0.62))
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
        .background(Color.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}
