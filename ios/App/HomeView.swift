import SwiftUI
import UIKit

/// The containing app's home: play the demo, learn the three steps, open a pasted link.
struct HomeView: View {
    @EnvironmentObject private var model: AppModel

    private static let demoCardImage: UIImage = RecapCardRenderer.image(for: DemoRecap.recap.summary, scale: 2)

    var body: some View {
        ZStack {
            WrappedTheme.background
                .ignoresSafeArea()
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
            BrandMark(size: 34)
            Text(WrappedConfig.productName)
                .font(.system(size: 19, weight: .bold, design: .rounded))
                .foregroundStyle(Color.white)
                .accessibilityIdentifier("home.title")
            Spacer(minLength: 0)
        }
    }

    private var hero: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: -2) {
                Text("Your group chat,")
                    .font(.system(size: 40, weight: .heavy, design: .rounded))
                    .foregroundStyle(Color.white)
                Text("in review.")
                    .font(.system(size: 40, weight: .heavy, design: .rounded))
                    .foregroundStyle(WrappedTheme.brandGradientHorizontal)
            }
            .minimumScaleFactor(0.7)
            .lineLimit(1)
            .accessibilityElement(children: .combine)

            Text("The year your chat had, told as a story you can play right inside Messages.")
                .font(.system(size: 17, weight: .regular))
                .foregroundStyle(Color.white.opacity(0.72))
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var demoCard: some View {
        Button(action: { model.playDemo() }) {
            Image(uiImage: HomeView.demoCardImage)
                .resizable()
                .aspectRatio(contentMode: .fit)
                .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
                .overlay(alignment: .topTrailing) {
                    Image(systemName: "play.fill")
                        .font(.system(size: 18, weight: .bold))
                        .foregroundStyle(Color.white)
                        .frame(width: 48, height: 48)
                        .background(Color.black.opacity(0.32), in: Circle())
                        .padding(14)
                }
                .shadow(color: WrappedTheme.violet.opacity(0.5), radius: 28, x: 0, y: 14)
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
                .font(.system(size: 22, weight: .bold, design: .rounded))
                .foregroundStyle(Color.white)
                .accessibilityIdentifier("home.howTo")
            HowToStep(
                number: 1,
                title: "Open a conversation",
                detail: "In Messages, tap the + next to the text field and choose \(WrappedConfig.productName) from your apps."
            )
            HowToStep(
                number: 2,
                title: "Pick a recap",
                detail: "Send the demo, or paste a recap link made from your own group chat."
            )
            HowToStep(
                number: 3,
                title: "Send it",
                detail: "It lands as a card everyone can tap. With the app it plays as a story; without it, the link opens the same story on the web."
            )
        }
    }

    private var privacy: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "lock.fill")
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(WrappedTheme.violet)
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
    let title: String
    let detail: String

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            Text("\(number)")
                .font(.system(size: 17, weight: .heavy, design: .rounded))
                .foregroundStyle(Color.white)
                .frame(width: 36, height: 36)
                .background(WrappedTheme.brandGradient, in: Circle())
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Color.white)
                Text(detail)
                    .font(.system(size: 15, weight: .regular))
                    .foregroundStyle(Color.white.opacity(0.68))
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}
