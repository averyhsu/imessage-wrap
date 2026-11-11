import Foundation

/// Building and parsing recap links (docs/SCHEMA.md §5).
enum RecapLink {
    // MARK: Which links are recap links

    /// Only two kinds of URL are accepted as recap links, so that nothing else can make
    /// the app or the extension play content:
    ///  - the app's own scheme with host `recap`: `threadback://recap#w1=…`
    ///  - the https story page: `https://<story host>/<story path>/` (or its `index.html`)
    ///    with `#w1=…` or `?w1=…`
    static func isRecapLink(_ url: URL) -> Bool {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let scheme = components.scheme?.lowercased() else {
            return false
        }
        let host = (components.host ?? "").lowercased()
        if scheme == WrappedConfig.appURLScheme {
            return host == "recap" && (components.path.isEmpty || components.path == "/")
        }
        guard scheme == "https",
              components.user == nil,
              components.password == nil,
              components.port == nil || components.port == 443,
              let base = URLComponents(string: WrappedConfig.baseURLString),
              let baseHost = base.host?.lowercased(),
              host == baseHost else {
            return false
        }
        let basePath = base.path.hasSuffix("/") ? base.path : base.path + "/"
        let path = components.path
        return path == basePath || path == basePath + "index.html" || path + "/" == basePath
    }

    // MARK: Parsing

    /// Extracts the payload from a URL's fragment (`#w1=…`) or query (`?w1=…`), whatever
    /// its scheme, with other parameters allowed around it. The fragment wins when both
    /// are present. This only parses; `recap(from:)` decides whether the link is trusted.
    static func payload(from url: URL) -> String? {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return nil
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

    /// Decodes the recap carried by a recap link. Nil for any other URL (see
    /// `isRecapLink`) and for links whose payload cannot be read.
    static func recap(from url: URL) -> Recap? {
        guard isRecapLink(url), let found = payload(from: url) else {
            return nil
        }
        return try? Recap(payload: found)
    }

    /// The URLs written in a piece of free text such as the clipboard.
    static func links(inText text: String) -> [URL] {
        let limited = String(text.prefix(60_000))
        let separators = CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: "<>\"'()[]"))
        let trailing = CharacterSet(charactersIn: ".,;:!?")
        var result: [URL] = []
        for token in limited.components(separatedBy: separators) {
            let candidate = token.trimmingCharacters(in: trailing)
            guard candidate.count >= 8, candidate.contains("://"), let url = URL(string: candidate) else {
                continue
            }
            result.append(url)
            if result.count == 20 {
                break
            }
        }
        return result
    }

    /// Decodes the first recap link found in `text`, or nil. The text may contain other
    /// words around the link.
    static func recap(inText text: String) -> Recap? {
        for url in links(inText: text) {
            if let found = recap(from: url) {
                return found
            }
        }
        return nil
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

    /// `threadback://recap#w1=<payload>`: opens the recap in the containing app.
    static func appURL(payload: String) -> URL? {
        var components = URLComponents()
        components.scheme = WrappedConfig.appURLScheme
        components.host = "recap"
        components.fragment = storyFragment(payload: payload)
        return components.url
    }

    /// The bundled story page, plus the directory WebKit may read:
    /// `web/index.html?embed=ios#w1=<payload>` (docs/SCHEMA.md §6). Without a payload the
    /// page loads in embed mode and waits for one (used to warm a web view up early).
    static func bundledStoryLocation(
        payload: String?,
        bundle: Bundle = Bundle.main
    ) -> (url: URL, directory: URL)? {
        guard let index = bundle.url(forResource: "index", withExtension: "html", subdirectory: "web"),
              var components = URLComponents(url: index, resolvingAgainstBaseURL: false) else {
            return nil
        }
        components.queryItems = [URLQueryItem(name: "embed", value: "ios")]
        if let payload = payload {
            components.fragment = storyFragment(payload: payload)
        }
        guard let url = components.url else {
            return nil
        }
        return (url, index.deletingLastPathComponent())
    }

    /// `w1=<payload>`: what goes after the `#` of the story page.
    static func storyFragment(payload: String) -> String {
        return WrappedConfig.payloadKey + "=" + payload
    }

    private static func apply(payload: String, form: RecapLinkForm, to components: inout URLComponents) {
        switch form {
        case .fragment:
            components.fragment = storyFragment(payload: payload)
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
