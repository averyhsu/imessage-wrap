import Foundation

/// Building and parsing recap links (docs/SCHEMA.md §5).
enum RecapLink {
    // MARK: Parsing

    /// Extracts the payload from a recap URL. Accepts the fragment form (`#w1=…`), the
    /// query form (`?w1=…`), any scheme (https, the app's custom scheme, file) and extra
    /// parameters around it. The fragment wins when both are present.
    static func payload(from url: URL) -> String? {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return payload(inText: url.absoluteString)
        }
        if let fragment = components.percentEncodedFragment,
           let found = parameter(WrappedConfig.payloadKey, in: fragment) {
            return found
        }
        if let query = components.percentEncodedQuery,
           let found = parameter(WrappedConfig.payloadKey, in: query) {
            return found
        }
        return nil
    }

    /// Finds a recap link inside free text (for example the clipboard) and returns its
    /// payload. The text may contain other words around the link.
    static func payload(inText text: String) -> String? {
        let pattern = "[#?&]" + WrappedConfig.payloadKey + "=([A-Za-z0-9_\\-]+)"
        guard let regex = try? NSRegularExpression(pattern: pattern, options: []) else {
            return nil
        }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        guard let match = regex.firstMatch(in: text, options: [], range: range),
              match.numberOfRanges > 1,
              let captured = Range(match.range(at: 1), in: text) else {
            return nil
        }
        let value = String(text[captured])
        return value.isEmpty ? nil : value
    }

    /// `a=1&w1=abc&b=2` → `abc`
    private static func parameter(_ key: String, in string: String) -> String? {
        let prefix = key + "="
        for part in string.split(separator: "&") {
            guard part.hasPrefix(prefix) else {
                continue
            }
            let raw = String(part.dropFirst(prefix.count))
            let decoded = raw.removingPercentEncoding ?? raw
            if !decoded.isEmpty {
                return decoded
            }
        }
        return nil
    }

    /// Decodes the recap carried by a URL, or nil when the URL carries none.
    static func recap(from url: URL) -> Recap? {
        guard let found = payload(from: url) else {
            return nil
        }
        return try? Recap(payload: found)
    }

    /// Decodes the recap carried by a link somewhere in `text`, or nil.
    static func recap(inText text: String) -> Recap? {
        guard let found = payload(inText: text) else {
            return nil
        }
        return try? Recap(payload: found)
    }

    // MARK: Building

    /// The public https story link for a payload.
    static func storyURL(
        payload: String,
        form: RecapLinkForm = WrappedConfig.linkForm,
        base: String = WrappedConfig.baseURLString
    ) -> URL? {
        guard var components = URLComponents(string: base) else {
            return nil
        }
        apply(payload: payload, form: form, to: &components)
        return components.url
    }

    /// `imessagewrapped://recap#w1=<payload>`: opens the recap in the containing app.
    static func appURL(payload: String) -> URL? {
        var components = URLComponents()
        components.scheme = WrappedConfig.appURLScheme
        components.host = "recap"
        components.fragment = WrappedConfig.payloadKey + "=" + payload
        return components.url
    }

    /// The bundled story page for a payload, plus the directory WebKit may read.
    /// `web/index.html?embed=ios#w1=<payload>` (docs/SCHEMA.md §6).
    static func bundledStoryLocation(
        payload: String,
        bundle: Bundle = Bundle.main
    ) -> (url: URL, directory: URL)? {
        guard let index = bundle.url(forResource: "index", withExtension: "html", subdirectory: "web"),
              var components = URLComponents(url: index, resolvingAgainstBaseURL: false) else {
            return nil
        }
        components.queryItems = [URLQueryItem(name: "embed", value: "ios")]
        components.fragment = WrappedConfig.payloadKey + "=" + payload
        guard let url = components.url else {
            return nil
        }
        return (url, index.deletingLastPathComponent())
    }

    private static func apply(payload: String, form: RecapLinkForm, to components: inout URLComponents) {
        switch form {
        case .fragment:
            components.fragment = WrappedConfig.payloadKey + "=" + payload
        case .query:
            var items = components.queryItems ?? []
            items.removeAll { (item: URLQueryItem) -> Bool in
                return item.name == WrappedConfig.payloadKey
            }
            items.append(URLQueryItem(name: WrappedConfig.payloadKey, value: payload))
            components.queryItems = items
        }
    }
}

/// Keeps recap links inside the length budget by trimming the stats (docs/SCHEMA.md §5).
enum RecapLinkBuilder {
    struct FittedLink: Equatable {
        /// The https story link, at most `limit` characters long.
        let url: URL
        /// The payload inside `url` (the original one when nothing had to be trimmed).
        let payload: String
        /// How many trim steps (0...6) were applied.
        let trimSteps: Int
    }

    static let trimStepCount = 6

    /// Builds the story link for a payload, trimming the stats if the link would be too long.
    static func fit(
        payload: String,
        form: RecapLinkForm = WrappedConfig.linkForm,
        base: String = WrappedConfig.baseURLString,
        limit: Int = WrappedConfig.maxLinkLength
    ) throws -> FittedLink {
        guard let url = RecapLink.storyURL(payload: payload, form: form, base: base) else {
            throw RecapPayloadError.invalidBaseURL
        }
        if url.absoluteString.count <= limit {
            return FittedLink(url: url, payload: payload, trimSteps: 0)
        }

        var stats = try RecapPayload.decodeObject(payload)
        var lastLength = url.absoluteString.count
        for step in 1...trimStepCount {
            applyTrimStep(step, to: &stats)
            let trimmedPayload = try RecapPayload.encode(object: stats)
            guard let trimmedURL = RecapLink.storyURL(payload: trimmedPayload, form: form, base: base) else {
                throw RecapPayloadError.invalidBaseURL
            }
            lastLength = trimmedURL.absoluteString.count
            if lastLength <= limit {
                return FittedLink(url: trimmedURL, payload: trimmedPayload, trimSteps: step)
            }
        }
        throw RecapPayloadError.linkTooLong(length: lastLength, limit: limit)
    }

    /// One step of the trim ladder. Steps are cumulative: call 1, then 2, and so on.
    ///  1. delete `awards[].detail`
    ///  2. truncate every `most_reacted[].text` to 60 characters (plus "…")
    ///  3. keep only the first 8 `senders`
    ///  4. keep only the first `most_reacted` entry
    ///  5. delete `awards`
    ///  6. keep only the first 5 `senders`
    static func applyTrimStep(_ step: Int, to stats: inout [String: Any]) {
        switch step {
        case 1:
            if let awards = stats["awards"] as? [Any] {
                stats["awards"] = awards.map { (item: Any) -> Any in
                    guard var award = item as? [String: Any] else {
                        return item
                    }
                    award.removeValue(forKey: "detail")
                    return award
                }
            }
        case 2:
            if let entries = stats["most_reacted"] as? [Any] {
                stats["most_reacted"] = entries.map { (item: Any) -> Any in
                    guard var entry = item as? [String: Any],
                          let text = entry["text"] as? String,
                          text.count > 60 else {
                        return item
                    }
                    entry["text"] = String(text.prefix(60)) + "…"
                    return entry
                }
            }
        case 3:
            keepFirst(8, of: "senders", in: &stats)
        case 4:
            keepFirst(1, of: "most_reacted", in: &stats)
        case 5:
            stats.removeValue(forKey: "awards")
        case 6:
            keepFirst(5, of: "senders", in: &stats)
        default:
            break
        }
    }

    private static func keepFirst(_ count: Int, of key: String, in stats: inout [String: Any]) {
        guard let items = stats[key] as? [Any], items.count > count else {
            return
        }
        stats[key] = Array(items.prefix(count))
    }
}
