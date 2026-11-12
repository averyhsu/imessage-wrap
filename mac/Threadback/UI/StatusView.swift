import SwiftUI

/// What opening Threadback shows once it is set up: is it on, for which chat, the last
/// reply, and plain ways out (Turn off, Quit Threadback), so nobody depends on finding the
/// menu-bar icon.
struct StatusView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        ZStack(alignment: .topLeading) {
            Theme.page.ignoresSafeArea()
            Circle().fill(Theme.green.opacity(0.22)).frame(width: 420, height: 420).blur(radius: 140).offset(x: -160, y: -200)
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 10) {
                    Image("BrandMark").resizable().frame(width: 30, height: 30)
                    Text(WrappedConfig.productName).font(.system(size: 17, weight: .heavy)).foregroundStyle(.white)
                    Spacer()
                }
                Spacer().frame(height: 6)
                if let chat = model.approved.first, model.chatIsOn {
                    Text(model.paused ? "Paused." : "On.").font(Theme.display(44)).foregroundStyle(.white)
                        .accessibilityIdentifier("status.title")
                    Text("Anyone in \(chat.name) can type /wrapped. This Mac replies while it is awake and you are logged in.")
                        .font(.system(size: 15)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                } else {
                    Text("Off.").font(Theme.display(44)).foregroundStyle(.white).accessibilityIdentifier("status.title")
                    Text("Threadback is not answering any chat.")
                        .font(.system(size: 15)).foregroundStyle(Theme.muted)
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text(model.access).font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(model.accessLost ? Color(nsColor: MacPalette.rgb(0xFF453A)) : Theme.green)
                    if let title = model.lastReplyTitle, let last = model.replies.last {
                        Text(title).font(.system(size: 13, weight: .semibold)).foregroundStyle(.white)
                        Text(last.summary).font(.system(size: 13)).foregroundStyle(Theme.muted)
                    } else if model.chatIsOn {
                        Text("No /wrapped yet.").font(.system(size: 13)).foregroundStyle(Theme.muted)
                    }
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 16).fill(Theme.card))
                if !model.turnOffNote.isEmpty {
                    Text(model.turnOffNote).font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.green)
                        .accessibilityIdentifier("status.turnOffNote")
                }
                HStack(spacing: 10) {
                    if model.chatIsOn {
                        PillButton(title: "Turn off", color: Color.white.opacity(0.16), identifier: "status.turnOff") { model.turnOff() }
                    } else {
                        PillButton(title: "Turn on a chat\u{2026}", color: Theme.green, identifier: "status.setUp") { model.setUpAgain() }
                    }
                    PillButton(title: "Quit Threadback", color: Color(nsColor: MacPalette.rgb(0xFF453A)), identifier: "status.quit") { model.quitFromWindow() }
                    Spacer()
                    QuietButton(title: "Copy test report", identifier: "status.copyReport") { model.copyTestReport() }
                }
                if !model.copiedNote.isEmpty {
                    Text(model.copiedNote).font(.system(size: 12)).foregroundStyle(Theme.green)
                }
                Spacer(minLength: 0)
                Text("Closing this window keeps Threadback answering from the menu bar (the speech-bubble icon). To uninstall: click Quit Threadback, then drag Threadback from Applications to the Trash. Its settings stay behind in ~/Library/Preferences (io.github.averyhsu.threadback.mac.plist) and ~/Library/Application Support/Threadback; delete those too for a clean slate.")
                    .font(.system(size: 11.5)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("status.uninstall")
            }
            .padding(36)
        }
        .frame(width: 720, height: 640)
        .preferredColorScheme(.dark)
    }
}
