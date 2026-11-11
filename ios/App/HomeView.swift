import SwiftUI
import UIKit

/// The containing app's home: play the demo, learn the three steps, open a pasted link.
struct HomeView: View {
    @EnvironmentObject private var model: AppModel

    private static let demoCardImage: UIImage = RecapCardRenderer.image(for: DemoRecap.recap.summary, scale: 2)

    var body: some View {
        ZStack {
            ThemeBackground()
            ScrollView(.vertical, showsIndicators: false) {
                VStack(alignment: .leading, spacing: 26) {
                    brandRow
                    hero
                    demoCard
                    actions
                    howTo
                    privacy
                }
                .padding(.horizontal, 22)
                .padding(.top, 18)
                .padding(.bottom, 40)
                .frame(maxWidth: 560, alignment: .leading)
                .frame(maxWidth: .infinity)
            }
        }
    }

    // MARK: Pieces

    private var brandRow: some View {
        HStack(spacing: 10) {
            BrandMark(size: 26)
            Text(WrappedConfig.productName)
                .font(WrappedTheme.display(17, weight: .heavy))
                .foregroundStyle(Color.white)
                .accessibilityIdentifier("home.title")
            Spacer(minLength: 0)
        }
    }

    private var hero: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(WrappedConfig.productDescriptor.uppercased())
                .font(WrappedTheme.display(11.5, weight: .heavy))
                .kerning(1.3)
                .foregroundStyle(Color.white.opacity(0.62))

            VStack(alignment: .leading, spacing: -4) {
                Text("Your group chat,")
                    .font(WrappedTheme.display(38))
                    .foregroundStyle(Color.white)
                Text("in review.")
                    .font(WrappedTheme.display(38))
                    .foregroundStyle(WrappedTheme.popBlue)
            }
            .minimumScaleFactor(0.6)
            .lineLimit(1)
            .accessibilityElement(children: .combine)

            Text("The year your chat had, told as a story you can play right inside Messages.")
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(Color.white.opacity(0.78))
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var demoCard: some View {
        Button(action: { model.playDemo() }) {
            Image(uiImage: HomeView.demoCardImage)
                .resizable()
                .aspectRatio(contentMode: .fit)
                .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
                .shadow(color: WrappedTheme.blue.opacity(0.45), radius: 28, x: 0, y: 14)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Play the demo recap")
        .accessibilityIdentifier("home.demoCard")
    }

    private var actions: some View {
        VStack(spacing: 10) {
            Button(action: { model.playDemo() }) {
                Label("Play the demo", systemImage: "play.fill")
            }
            .buttonStyle(PrimaryActionStyle())
            .accessibilityIdentifier("home.playDemo")

            Button(action: { model.pasteLink() }) {
                Label("Paste a recap link", systemImage: "link")
            }
            .buttonStyle(SecondaryActionStyle())
            .accessibilityIdentifier("home.paste")

            if let notice = model.notice {
                Text(notice)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Color.white.opacity(0.8))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 2)
                    .accessibilityIdentifier("home.notice")
            }
        }
    }

    private var howTo: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("How to use it in Messages")
                .font(WrappedTheme.display(20))
                .foregroundStyle(Color.white)
                .accessibilityIdentifier("home.howTo")
            HowToStep(
                number: 1,
                tint: WrappedTheme.blue,
                title: "Open a conversation",
                detail: "In Messages, tap the + next to the text field and choose \(WrappedConfig.productName) from your apps."
            )
            HowToStep(
                number: 2,
                tint: WrappedTheme.green,
                title: "Pick a recap",
                detail: "Send the demo, or paste a recap link made from your own group chat."
            )
            HowToStep(
                number: 3,
                tint: WrappedTheme.pink,
                title: "Send it",
                detail: "It lands as a card everyone can tap. With the app it plays as a story; without it, the link opens the same story on the web."
            )
        }
    }

    private var privacy: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "lock.fill")
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(WrappedTheme.popBlue)
                .padding(.top, 2)
            Text("Private by design. A recap lives entirely inside its link: no account, no server, and this app never reads your messages.")
                .font(.system(size: 13, weight: .regular))
                .foregroundStyle(Color.white.opacity(0.55))
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

private struct HowToStep: View {
    let number: Int
    let tint: Color
    let title: String
    let detail: String

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            Text("\(number)")
                .font(WrappedTheme.display(16))
                .foregroundStyle(tint == WrappedTheme.green ? WrappedTheme.ink : Color.white)
                .frame(width: 36, height: 36)
                .background(tint, in: Circle())
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.system(size: 17, weight: .bold))
                    .foregroundStyle(Color.white)
                Text(detail)
                    .font(.system(size: 15, weight: .regular))
                    .foregroundStyle(Color.white.opacity(0.7))
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .background(Color.white.opacity(0.07), in: RoundedRectangle(cornerRadius: 26, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}
