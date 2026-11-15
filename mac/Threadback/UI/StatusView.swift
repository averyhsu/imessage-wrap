import SwiftUI

/// What opening Threadback shows once it is set up: the chats that are on, each with its
/// last reply, Play the story and Turn off; Add a chat; Pause all; Quit. Nobody has to find
/// the menu-bar icon.
struct StatusView: View {
    @ObservedObject var model: AppModel

    private static let red = Color(nsColor: MacPalette.rgb(0xFF453A))

    var body: some View {
        ZStack(alignment: .topLeading) {
            Theme.page.ignoresSafeArea()
            Circle().fill(Theme.green.opacity(0.22)).frame(width: 420, height: 420).blur(radius: 140).offset(x: -160, y: -200)
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 10) {
                    Image("BrandMark").resizable().frame(width: 30, height: 30)
                    Text(WrappedConfig.productName).font(.system(size: 17, weight: .heavy)).foregroundStyle(.white)
                    Spacer()
                    Text(model.aboutLine).font(.system(size: 11)).foregroundStyle(Theme.muted)
                        .accessibilityIdentifier("status.about")
                }
                if model.chatIsOn {
                    Text(model.paused ? "Paused." : "On.").font(Theme.display(44)).foregroundStyle(.white)
                        .accessibilityIdentifier("status.title")
                    Text(model.paused ? "Nothing is answered until you click Resume." : (MacConfig.storySiteIsLive
                        ? "When anyone types /wrapped in one of these chats, this Mac replies with a picture, a short text and a link to the full story, while it is awake and you are logged in."
                        : "When anyone types /wrapped in one of these chats, this Mac replies with a picture and a short text, while it is awake and you are logged in."))
                        .font(.system(size: 14)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                } else {
                    Text("Off.").font(Theme.display(44)).foregroundStyle(.white).accessibilityIdentifier("status.title")
                    Text("Threadback is not answering any chat.").font(.system(size: 14)).foregroundStyle(Theme.muted)
                }
                HStack(spacing: 8) {
                    Text(model.access).font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(model.accessLost ? StatusView.red : Theme.green)
                        .accessibilityIdentifier("status.access")
                    if model.accessLost {
                        QuietButton(title: "Reconnect", identifier: "status.reconnect") { model.reconnect() }
                    }
                }
                ScrollView {
                    VStack(spacing: 8) {
                        ForEach(Array(model.approved.enumerated()), id: \.element.key) { index, chat in
                            row(chat, index: index)
                        }
                    }
                }
                .frame(maxHeight: 250)
                if let line = model.limitLine {
                    Text(line).font(.system(size: 13, weight: .semibold)).foregroundStyle(StatusView.red)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("status.limit")
                }
                if !model.turnOffNote.isEmpty {
                    Text(model.turnOffNote).font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.green)
                        .accessibilityIdentifier("status.turnOffNote")
                }
                if !model.storyNote.isEmpty {
                    Text(model.storyNote).font(.system(size: 12)).foregroundStyle(Theme.muted)
                }
                HStack(spacing: 10) {
                    PillButton(title: model.chatIsOn ? "Add a chat" : "Turn on a chat\u{2026}", color: Theme.green, identifier: "status.addChat") { model.addChat() }
                    if model.chatIsOn {
                        QuietButton(title: model.paused ? "Resume" : "Pause all", identifier: "status.pause") { model.togglePause() }
                    }
                    PillButton(title: "Quit Threadback", color: StatusView.red, identifier: "status.quit") { model.quitFromWindow() }
                    Spacer()
                    QuietButton(title: "Copy test report", identifier: "status.copyReport") { model.copyTestReport() }
                }
                if !model.copiedNote.isEmpty {
                    Text(model.copiedNote).font(.system(size: 12)).foregroundStyle(Theme.green)
                }
                Spacer(minLength: 0)
                HStack(alignment: .top, spacing: 12) {
                    Text("Closing this window keeps Threadback answering from the menu bar (the speech-bubble icon). To uninstall: click Quit Threadback, then drag Threadback from Applications to the Trash. Its settings stay in ~/Library/Preferences (io.github.averyhsu.threadback.mac.plist) and ~/Library/Application Support/Threadback, and the pictures it sent stay in ~/Pictures/Threadback; delete those too for a clean slate. Threadback never goes online by itself.")
                        .font(.system(size: 11)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("status.uninstall")
                    QuietButton(title: "Check for updates", identifier: "status.updates") { model.checkForUpdates() }
                }
            }
            .padding(36)
        }
        .frame(width: 720, height: 640)
        .preferredColorScheme(.dark)
    }

    private func row(_ chat: ChatRef, index: Int) -> some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(chat.name).font(.system(size: 15, weight: .bold)).foregroundStyle(.white).lineLimit(1)
                Text(lastLine(chat)).font(.system(size: 12)).foregroundStyle(Theme.muted).lineLimit(1)
                    .accessibilityIdentifier("status.last.\(index)")
            }
            Spacer()
            if model.needsReconsent.contains(where: { $0.key == chat.key }) {
                PillButton(title: "Keep on", color: Theme.green, identifier: "status.keepOn.\(index)") { model.keepOn(chat) }
            } else {
                QuietButton(title: "\u{25B6} Play the story", identifier: "status.playStory.\(index)") { model.playStory(chat) }
            }
            QuietButton(title: "Turn off", identifier: "status.turnOff.\(index)") { model.turnOff(chat) }
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .background(RoundedRectangle(cornerRadius: 14).fill(Theme.card))
    }

    private func lastLine(_ chat: ChatRef) -> String {
        if model.needsReconsent.contains(where: { $0.key == chat.key }) {
            return "Not answering: replies now include a link. Keep on, or Turn off."
        }
        guard let last = model.lastByChat[chat.key] else { return "No /wrapped yet." }
        let formatter = DateFormatter()
        formatter.dateStyle = .short
        formatter.timeStyle = .short
        return "Last /wrapped \(formatter.string(from: last.time)): \(last.summary)"
    }
}
