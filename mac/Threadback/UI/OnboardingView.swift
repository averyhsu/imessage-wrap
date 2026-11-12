import SwiftUI

/// The brand on the Mac: near-black page, one mark, heavy wide display type, Messages
/// colours as graphic material, pill buttons (web/css, ios/Shared/WrappedTheme.swift).
enum Theme {
    static let page = Color(nsColor: MacPalette.night)
    static let card = Color.white.opacity(0.06)
    static let blue = Color(nsColor: MacPalette.blue)
    static let green = Color(nsColor: MacPalette.green)
    static let muted = Color.white.opacity(0.62)

    static func display(_ size: CGFloat, weight: Font.Weight = .black) -> Font {
        return Font.system(size: size, weight: weight).width(.expanded)
    }
}

struct PillButton: View {
    let title: String
    var color: Color = Theme.blue
    var identifier: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 15, weight: .bold))
                .foregroundStyle(.white)
                .padding(.horizontal, 22)
                .padding(.vertical, 11)
                .background(Capsule().fill(color))
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(identifier)
    }
}

struct QuietButton: View {
    let title: String
    var identifier: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(.white)
                .padding(.horizontal, 18)
                .padding(.vertical, 10)
                .background(Capsule().fill(Color.white.opacity(0.12)))
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(identifier)
    }
}

struct OnboardingView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        ZStack(alignment: .topLeading) {
            Theme.page.ignoresSafeArea()
            // The soft colour glows of the landing page.
            Circle().fill(Theme.blue.opacity(0.35)).frame(width: 420, height: 420).blur(radius: 140).offset(x: -160, y: -200)
            Circle().fill(Color.purple.opacity(0.22)).frame(width: 360, height: 360).blur(radius: 140).offset(x: 520, y: 360)
            VStack(alignment: .leading, spacing: 0) {
                header
                Spacer().frame(height: 26)
                switch model.step {
                case .welcome: welcome
                case .connect: connect
                case .chats: chooseChat
                }
                Spacer(minLength: 0)
            }
            .padding(36)
        }
        .frame(width: 720, height: 600)
        .preferredColorScheme(.dark)
    }

    private var header: some View {
        HStack(spacing: 10) {
            Image("BrandMark").resizable().frame(width: 30, height: 30)
            Text(WrappedConfig.productName).font(.system(size: 17, weight: .heavy)).foregroundStyle(.white)
            Spacer()
            Text("STEP \(model.step.rawValue) OF 3")
                .font(.system(size: 11, weight: .heavy)).kerning(1.4).foregroundStyle(Theme.muted)
                .accessibilityIdentifier("onboarding.step")
        }
    }

    // MARK: 1. Welcome

    private var welcome: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("YOUR GROUP CHAT'S YEAR IN REVIEW").font(.system(size: 12, weight: .heavy)).kerning(1.6).foregroundStyle(Theme.muted)
            (Text("Type /wrapped.\n").foregroundColor(.white) + Text("Get the recap.").foregroundColor(Theme.blue))
                .font(Theme.display(46))
                .fixedSize(horizontal: false, vertical: true)
            Text("Turn Threadback on for one group chat. When anyone in it types /wrapped, this Mac replies in the thread with a recap image, a short text and a link to the full story.")
                .font(.system(size: 15)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 10) {
                bubble("1", "Connect your messages", Theme.blue)
                bubble("2", "Choose a chat", Theme.green)
                bubble("3", "Anyone types /wrapped", Color.white.opacity(0.14))
            }
            Spacer().frame(height: 4)
            PillButton(title: "Continue", identifier: "onboarding.continue") { model.continueFromWelcome() }
            Text("Your messages are read on this Mac only. Nothing is uploaded.").font(.system(size: 12)).foregroundStyle(Theme.muted)
        }
    }

    private func bubble(_ number: String, _ title: String, _ color: Color) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(number).font(Theme.display(26))
            Text(title).font(.system(size: 13, weight: .bold)).fixedSize(horizontal: false, vertical: true)
        }
        .foregroundStyle(.white)
        .padding(14)
        .frame(width: 196, height: 96, alignment: .topLeading)
        .background(RoundedRectangle(cornerRadius: 18).fill(color))
    }

    // MARK: 2. Connect your messages

    private var connect: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Connect your messages.").font(Theme.display(38)).foregroundStyle(.white)
            Text("Threadback counts who said what in your group chats. In the window that opens, the Messages folder is already selected: click Grant Access.")
                .font(.system(size: 15)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            if model.connectedSummary.isEmpty {
                PillButton(title: "Connect Messages…", identifier: "onboarding.connect") { model.connect() }
            } else {
                Label(model.connectedSummary, systemImage: "checkmark.circle.fill")
                    .font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.green)
                    .accessibilityIdentifier("onboarding.connected")
                VStack(alignment: .leading, spacing: 10) {
                    Text("Optional: show first names").font(.system(size: 14, weight: .bold)).foregroundStyle(.white)
                    Text("With access to your contacts the recap says \u{201C}Sam\u{201D}; without it, \u{201C}\u{2026}1234\u{201D}.")
                        .font(.system(size: 13)).foregroundStyle(Theme.muted)
                    HStack(spacing: 10) {
                        QuietButton(title: "Show first names", identifier: "onboarding.contacts") { model.askForContacts() }
                        if !model.contactsNote.isEmpty {
                            Text(model.contactsNote).font(.system(size: 12)).foregroundStyle(Theme.muted)
                        }
                    }
                }
                .padding(16)
                .background(RoundedRectangle(cornerRadius: 16).fill(Theme.card))
                PillButton(title: "Continue", identifier: "onboarding.toChats") { model.continueToChats() }
            }
            if !model.connectError.isEmpty {
                Text(model.connectError).font(.system(size: 13)).foregroundStyle(Color(nsColor: MacPalette.rgb(0xFF453A)))
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("onboarding.connectError")
                QuietButton(title: "Open Full Disk Access settings", identifier: "onboarding.fda") { Permissions.openFullDiskAccessSettings() }
            }
        }
    }

    // MARK: 3. Choose the chat

    private var chooseChat: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let on = model.approved.first, model.cardImage != nil || !model.automationNote.isEmpty {
                ready(on)
            } else {
                Text("Choose the chat.").font(Theme.display(38)).foregroundStyle(.white)
                Text("Replies come from your Apple ID, in that chat only, at most once every 2 minutes. Next, macOS asks to let Threadback control Messages: click Allow.")
                    .font(.system(size: 14)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                ScrollView {
                    VStack(spacing: 8) {
                        ForEach(Array(model.chats.prefix(8).enumerated()), id: \.element.id) { index, chat in
                            HStack(spacing: 12) {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(chat.name).font(.system(size: 15, weight: .bold)).foregroundStyle(.white).lineLimit(1)
                                    Text("\(chat.members) people · \(RecapSummary.formatCount(chat.messages)) messages")
                                        .font(.system(size: 12)).foregroundStyle(Theme.muted)
                                }
                                Spacer()
                                PillButton(title: "Turn on", color: Theme.green, identifier: "chat.turnOn.\(index)") { model.turnOn(chat) }
                            }
                            .padding(.horizontal, 16).padding(.vertical, 12)
                            .background(RoundedRectangle(cornerRadius: 16).fill(Theme.card))
                        }
                    }
                }
                .frame(maxHeight: 330)
            }
        }
    }

    private func ready(_ chat: ChatRef) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("You're on.").font(Theme.display(38)).foregroundStyle(.white).accessibilityIdentifier("onboarding.ready")
            Text("Anyone in \(chat.name) can type /wrapped. This is what they get:")
                .font(.system(size: 14)).foregroundStyle(Theme.muted)
            HStack(alignment: .top, spacing: 16) {
                if let image = model.cardImage {
                    Image(nsImage: image).resizable().aspectRatio(4 / 3, contentMode: .fit).frame(width: 300)
                        .clipShape(RoundedRectangle(cornerRadius: 18))
                }
                Text(model.recapPreview).font(.system(size: 11.5)).foregroundStyle(.white)
                    .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 16).fill(Color(nsColor: MacPalette.rgb(0x2C2C2E))))
            }
            if !model.automationNote.isEmpty {
                Text(model.automationNote).font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.green)
                    .accessibilityIdentifier("onboarding.automation")
            }
            HStack(spacing: 14) {
                Toggle("Open Threadback when I log in", isOn: Binding(get: { model.loginItemOn }, set: { model.setLoginItem($0) }))
                    .toggleStyle(.switch).foregroundStyle(.white).accessibilityIdentifier("onboarding.loginItem")
                Spacer()
                PillButton(title: "Done", identifier: "onboarding.done") { model.finishOnboarding() }
            }
            Text("Threadback answers while this Mac is awake and you are logged in. It lives in the menu bar.")
                .font(.system(size: 12)).foregroundStyle(Theme.muted)
        }
    }
}

/// A plain window for the CI experiments (Debug only): shows what they found.
struct ExperimentView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Threadback experiment").font(Theme.display(20)).foregroundStyle(.white)
            Text(model.experimentNote).font(.system(size: 12, design: .monospaced)).foregroundStyle(.white)
                .textSelection(.enabled)
                .accessibilityIdentifier("experiment.note")
            Spacer()
        }
        .padding(24)
        .frame(width: 640, height: 360, alignment: .topLeading)
        .background(Theme.page)
        .preferredColorScheme(.dark)
    }
}
