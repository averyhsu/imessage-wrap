import Messages
import UIKit

/// Builds the `MSMessage` for a recap.
///
/// - `url` is the https story link carrying the payload, so people without the app (and
///   Macs, where the bubble opens the link in a browser) still get the web story.
/// - The template layout (share card image, caption, subcaption) is what everyone sees.
/// - When `WrappedConfig.useLiveLayout` is on (experimental, off by default), members who
///   have the app get the native live bubble instead and the template becomes the
///   alternate layout.
/// - The built-in sample is labelled "Sample" on the card and in the caption.
enum RecapMessageComposer {
    static func templateLayout(for recap: Recap) -> MSMessageTemplateLayout {
        let template = MSMessageTemplateLayout()
        template.image = RecapCardRenderer.image(for: recap.summary, eyebrow: recap.eyebrow)
        template.caption = recap.caption
        template.subcaption = recap.summary.subcaption
        return template
    }

    static func layout(for recap: Recap, live: Bool = WrappedConfig.useLiveLayout) -> MSMessageLayout {
        let template = templateLayout(for: recap)
        if live {
            return MSMessageLiveLayout(alternateLayout: template)
        }
        return template
    }

    /// Throws `RecapPayloadError.linkTooLong` when the recap cannot be trimmed into the
    /// link budget (`MSMessage.url` rejects URLs over 5,000 characters).
    static func message(
        for recap: Recap,
        session: MSSession? = nil,
        live: Bool = WrappedConfig.useLiveLayout
    ) throws -> MSMessage {
        let link = try RecapLinkBuilder.fit(payload: recap.payload)
        let message = MSMessage(session: session ?? MSSession())
        message.layout = layout(for: recap, live: live)
        message.url = link.url
        message.summaryText = recap.caption
        message.accessibilityLabel = "\(recap.caption). \(recap.summary.messagesLine)."
        return message
    }

    /// The recap a message carries, if it is one of ours.
    static func recap(from message: MSMessage?) -> Recap? {
        guard let url = message?.url else {
            return nil
        }
        return RecapLink.recap(from: url)
    }
}
