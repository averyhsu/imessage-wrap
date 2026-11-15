import SwiftUI
import UIKit

/// State and actions of the launcher. The iMessage extension owns one and wires the
/// closures to the conversation; the app's debug gallery uses one with no-op closures.
final class LauncherModel: ObservableObject {
    /// Recaps the user pasted or sent from this extension, newest first.
    @Published var recents: [Recap] = []
    @Published var notice: String?
    /// False in the compact style (keyboard-sized), true in the expanded style.
    @Published var isRoomy = false

    var onPasteLink: () -> Void = {}
    /// Plays the built-in sample. It does not put anything into the conversation.
    var onSeeSample: () -> Void = {}
    var onClearRecents: () -> Void = {}
    var onPlay: (Recap) -> Void = { _ in }
    var onSend: (Recap) -> Void = { _ in }
    /// Debug builds only: stage the sample with a chosen layout (`true` = live bubble,
    /// `false` = template card), for UI tests.
    var onSendDemoWithLayout: (Bool) -> Void = { _ in }
}

/// The launcher shown when the extension is opened from the Messages app drawer.
///
/// It is about the person's own recap: paste its link, or pick one they made before. The
/// invented sample is a quiet "See a sample" that only plays; nothing made-up is offered
/// for sending from here. It is a graphic panel of its own, not an imitation of a
/// Messages thread.
struct LauncherView: View {
    @ObservedObject var model: LauncherModel

    var body: some View {
        ZStack {
            ThemeBackground()
            ScrollView(.vertical, showsIndicators: false) {
                VStack(alignment: .leading, spacing: model.isRoomy ? 16 : 10) {
                    header
                    Button(action: { model.onPasteLink() }) {
                        Label("Paste a recap link", systemImage: "link")
                    }
                    .buttonStyle(PrimaryActionStyle())
                    .accessibilityIdentifier("launcher.paste")

                    if let notice = model.notice {
                        noticeView(notice)
                    }
                    recentsSection
                    sampleRow
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
            BrandMark(size: model.isRoomy ? 44 : 36)
        }
    }

    #if DEBUG
    /// An invisible control that stages the sample with a chosen layout, so the UI tests can
    /// capture both the template card and the experimental live bubble.
    private func debugHook(live: Bool) -> some View {
        Button(action: { model.onSendDemoWithLayout(live) }) {
            Color.white.opacity(0.001)
                .frame(width: 14, height: 14)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(live ? "launcher.sendDemoLive" : "launcher.sendDemoTemplate")
        .accessibilityLabel(live ? "Stage the sample as a live bubble (debug)" : "Stage the sample as a card (debug)")
    }
    #endif

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
                RecentsHeader(title: "Your recaps", onClear: { model.onClearRecents() })
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
        RecapRow(
            recap: recap,
            onPlay: { model.onPlay(recap) },
            onSend: { model.onSend(recap) }
        )
    }

    /// The sample, kept quiet: it plays, it does not send.
    private var sampleRow: some View {
        VStack(alignment: .leading, spacing: 8) {
            if model.recents.isEmpty && model.notice == nil {
                Text("Copy the link of a recap made from your own group chat, then paste it here. It lands in the chat as a card everyone can tap.")
                    .font(.system(size: 13, weight: .regular))
                    .foregroundStyle(Color.white.opacity(0.62))
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 4)
            }
            Button(action: { model.onSeeSample() }) {
                Label("See a sample", systemImage: "play.circle")
            }
            .buttonStyle(QuietActionStyle())
            .accessibilityIdentifier("launcher.seeSample")
        }
        .padding(.top, 2)
    }

    private var footer: some View {
        Text("A recap travels inside its link. Nothing is uploaded, and this app never reads your messages.")
            .font(.system(size: 12, weight: .regular))
            .foregroundStyle(Color.white.opacity(0.5))
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, 2)
    }
}

/// "YOUR RECAPS" with a Clear control on the right.
struct RecentsHeader: View {
    let title: String
    let onClear: () -> Void

    var body: some View {
        HStack(alignment: .center) {
            Text(title.uppercased())
                .font(WrappedTheme.display(10.5, weight: .heavy))
                .kerning(1.2)
                .foregroundStyle(Color.white.opacity(0.62))
            Spacer(minLength: 8)
            Button(action: onClear) {
                Text("Clear")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(WrappedTheme.popBlue)
                    .padding(.horizontal, 10)
                    .frame(height: 28)
                    .background(Color.white.opacity(0.07), in: Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("recents.clear")
            .accessibilityLabel("Clear your recaps")
        }
    }
}

/// One remembered recap: tap the row to play it; where sending makes sense, the paper
/// plane stages it in the conversation.
struct RecapRow: View {
    let recap: Recap
    let onPlay: () -> Void
    var onSend: (() -> Void)?

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
            .accessibilityIdentifier("recents.play")

            if let onSend = onSend {
                Button(action: onSend) {
                    Image(systemName: "paperplane.fill")
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(Color.white)
                        .frame(width: 34, height: 34)
                        .background(Color.white.opacity(0.14), in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Send \(recap.summary.caption)")
                .accessibilityIdentifier("recents.send")
            }
        }
        .padding(10)
        .background(Color.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}
