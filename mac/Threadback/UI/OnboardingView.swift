import AppKit
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
        .frame(width: 720, height: 640)
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
            Button("Quit") { NSApp.terminate(nil) }
                .buttonStyle(.plain)
                .font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.muted)
                .padding(.leading, 12)
                .accessibilityIdentifier("onboarding.quit")
        }
    }

    // MARK: 1. Welcome

    private var welcome: some View {
        VStack(alignment: .leading, spacing: 18) {
            if model.cameThroughGatekeeper && !model.location.needsMove {
                Label("That was the only detour. Three clicks left.", systemImage: "checkmark.seal.fill")
                    .font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.green)
                    .accessibilityIdentifier("onboarding.detourDone")
            }
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
            if model.location.needsMove {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Threadback is running from \(model.location == .translocated ? "the download" : "Downloads"). Move it to Applications first, so its permissions and the login item last.")
                        .font(.system(size: 13, weight: .semibold)).foregroundStyle(.white).fixedSize(horizontal: false, vertical: true)
                    QuietButton(title: model.location.canMoveItself ? "Move to Applications" : "Show Downloads in Finder", identifier: "onboarding.move") { model.moveToApplications() }
                    if !model.moveNote.isEmpty {
                        Text(model.moveNote).font(.system(size: 12)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(14)
                .background(RoundedRectangle(cornerRadius: 14).fill(Color(nsColor: MacPalette.rgb(0xFF9F0A, alpha: 0.22))))
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

    private static let red = Color(nsColor: MacPalette.rgb(0xFF453A))

    @ViewBuilder
    private var connect: some View {
        VStack(alignment: .leading, spacing: 16) {
            switch model.connectState {
            case .fullDiskAccess(let note):
                fullDiskAccess(note)
            default:
                Text("Connect your messages.").font(Theme.display(38)).foregroundStyle(.white)
                Text("Threadback counts who said what in your group chats. In the window that opens, the Messages folder is already selected: click Grant Access.")
                    .font(.system(size: 15)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                connectBody
            }
        }
    }

    @ViewBuilder
    private var connectBody: some View {
        switch model.connectState {
        case .connected(let summary):
            Label(summary, systemImage: "checkmark.circle.fill")
                .font(.system(size: 17, weight: .bold)).foregroundStyle(Theme.green)
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
        case .failed(let message):
            Label(message, systemImage: "xmark.octagon.fill")
                .font(.system(size: 14, weight: .semibold)).foregroundStyle(OnboardingView.red)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("onboarding.connectError")
            HStack(spacing: 10) {
                PillButton(title: "Try again", identifier: "onboarding.retry") { model.connect() }
                QuietButton(title: "Use Full Disk Access instead", identifier: "onboarding.useFDA") { model.showFullDiskAccess() }
            }
        case .working:
            HStack(spacing: 10) {
                ProgressView().controlSize(.small)
                Text("Reading your group chats\u{2026}").font(.system(size: 14)).foregroundStyle(Theme.muted)
            }
        default:
            PillButton(title: "Connect Messages\u{2026}", identifier: "onboarding.connect") { model.connect() }
        }
    }

    private func fullDiskAccess(_ note: String) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Use Full Disk Access instead.").font(Theme.display(34)).foregroundStyle(.white)
            VStack(alignment: .leading, spacing: 8) {
                Text("1. Click Open System Settings.")
                Text("2. In Full Disk Access, switch Threadback on (use + to add it from Applications if it is not listed).")
                Text("3. Come back here and click Check again.")
            }
            .font(.system(size: 14)).foregroundStyle(.white).fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 10) {
                PillButton(title: "Open System Settings", identifier: "onboarding.openFDA") { Permissions.openFullDiskAccessSettings() }
                QuietButton(title: "Check again", identifier: "onboarding.checkFDA") { model.checkFullDiskAccess() }
            }
            if !note.isEmpty {
                Text(note).font(.system(size: 13)).foregroundStyle(OnboardingView.red).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("onboarding.fdaNote")
            }
            QuietButton(title: "Back to the folder", identifier: "onboarding.backToFolder") { model.connectState = .idle }
        }
    }

    // MARK: 3. Choose the chat

    private var chooseChat: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let on = model.approved.first, model.cardImage != nil || model.previewing || !model.automationNote.isEmpty {
                ready(on)
            } else {
                Text("Choose the chat.").font(Theme.display(38)).foregroundStyle(.white)
                HStack(spacing: 12) {
                    Text("Your name in the recap").font(.system(size: 14, weight: .bold)).foregroundStyle(.white)
                    TextField("Your first name", text: $model.ownerName)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 220)
                        .accessibilityIdentifier("onboarding.name")
                    Text(model.nameIsReady ? "Everyone in the chat sees it." : "Type the name your friends know you by.")
                        .font(.system(size: 12)).foregroundStyle(model.nameIsReady ? Theme.muted : OnboardingView.red)
                }
                Text("Replies come from your Apple ID, in that chat only, at most once every 2 minutes. Next, macOS asks whether Threadback may use Messages: click Allow.")
                    .font(.system(size: 14)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                ScrollView {
                    VStack(spacing: 8) {
                        ForEach(Array(model.chats.prefix(12).enumerated()), id: \.element.id) { index, chat in
                            HStack(spacing: 12) {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(chat.name).font(.system(size: 15, weight: .bold)).foregroundStyle(.white).lineLimit(1)
                                    Text("\(chat.members) people \u{00B7} \(RecapSummary.formatCount(chat.messages)) messages")
                                        .font(.system(size: 12)).foregroundStyle(Theme.muted)
                                }
                                Spacer()
                                PillButton(title: "Turn on", color: Theme.green, identifier: "chat.turnOn.\(index)") { model.turnOn(chat) }
                                    .disabled(!model.nameIsReady)
                                    .opacity(model.nameIsReady ? 1 : 0.4)
                            }
                            .padding(.horizontal, 16).padding(.vertical, 12)
                            .background(RoundedRectangle(cornerRadius: 16).fill(Theme.card))
                        }
                    }
                }
                .frame(maxHeight: 300)
            }
        }
    }

    private func ready(_ chat: ChatRef) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("You're on.").font(Theme.display(38)).foregroundStyle(.white).accessibilityIdentifier("onboarding.ready")
            HStack(alignment: .top, spacing: 16) {
                ZStack {
                    RoundedRectangle(cornerRadius: 16).fill(Theme.card)
                    if let image = model.cardImage {
                        Image(nsImage: image).resizable().aspectRatio(1080 / 1350, contentMode: .fit)
                            .clipShape(RoundedRectangle(cornerRadius: 16))
                            .accessibilityIdentifier("onboarding.card")
                    } else {
                        ProgressView().controlSize(.small)
                    }
                }
                .frame(width: 232, height: 290)
                VStack(alignment: .leading, spacing: 10) {
                    Text("When anyone in \(chat.name) types /wrapped, everyone in the chat gets:")
                        .font(.system(size: 13, weight: .semibold)).foregroundStyle(.white).fixedSize(horizontal: false, vertical: true)
                    Text(model.recapPreview.isEmpty ? "\u{2026}" : model.recapPreview).font(.system(size: 10.5)).foregroundStyle(.white)
                        .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                        .background(RoundedRectangle(cornerRadius: 14).fill(Color(nsColor: MacPalette.rgb(0x2C2C2E))))
                        .accessibilityIdentifier("onboarding.text")
                    if !MacConfig.storySiteIsLive {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Today: this picture and this text.").font(.system(size: 12.5, weight: .semibold)).foregroundStyle(.white)
                            Text("Later: once the story website is online, also a link that opens the full tap-through story for everyone in the chat.")
                                .font(.system(size: 12.5)).foregroundStyle(.white).fixedSize(horizontal: false, vertical: true)
                        }
                        .accessibilityIdentifier("onboarding.today")
                    }
                    HStack(spacing: 10) {
                        PillButton(title: "\u{25B6} Play the story", color: Theme.blue, identifier: "onboarding.playStory") { model.playStory(chat) }
                        Text("Only you see it, on this Mac.").font(.system(size: 11.5)).foregroundStyle(Theme.muted)
                    }
                    if !model.storyNote.isEmpty {
                        Text(model.storyNote).font(.system(size: 11.5)).foregroundStyle(Theme.muted)
                    }
                }
            }
            if !model.automationNote.isEmpty {
                Text(model.automationNote).font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.green)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("onboarding.automation")
            }
            HStack(spacing: 14) {
                Toggle("Open Threadback when I log in", isOn: Binding(get: { model.loginItemOn }, set: { model.setLoginItem($0) }))
                    .toggleStyle(.switch).foregroundStyle(.white).accessibilityIdentifier("onboarding.loginItem")
                Spacer()
                QuietButton(title: "Copy test report", identifier: "onboarding.copyReport") { model.copyTestReport() }
                PillButton(title: "Done", identifier: "onboarding.done") { model.finishOnboarding() }
            }
            if !model.loginItemNote.isEmpty && model.location == .translocated {
                Text(model.loginItemNote).font(.system(size: 12)).foregroundStyle(OnboardingView.red)
            }
            if !model.copiedNote.isEmpty {
                Text(model.copiedNote).font(.system(size: 12)).foregroundStyle(Theme.green).accessibilityIdentifier("onboarding.copied")
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
