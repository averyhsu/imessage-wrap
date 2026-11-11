import Foundation

/// Errors from decoding, encoding or fitting a recap link payload.
enum RecapPayloadError: Error, Equatable {
    case invalidBase64URL
    case inflateFailed
    case deflateFailed
    case notAStatsObject
    case linkTooLong(length: Int, limit: Int)
    case invalidBaseURL
}

extension RecapPayloadError: LocalizedError {
    var errorDescription: String? {
        switch self {
        case .invalidBase64URL:
            return "That link does not contain a readable recap."
        case .inflateFailed:
            return "The recap in that link is damaged."
        case .deflateFailed:
            return "The recap could not be packed into a link."
        case .notAStatsObject:
            return "That link does not contain a recap."
        case .linkTooLong(let length, let limit):
            return "This recap is too large to send (\(length) characters, the limit is \(limit))."
        case .invalidBaseURL:
            return "The recap link could not be built."
        }
    }
}

/// Link payload codec (docs/SCHEMA.md §5):
/// `payload = base64url( raw-DEFLATE( UTF-8( JSON ) ) )`, no padding.
enum RecapPayload {
    /// Upper bound for the inflated JSON. A 5,000-character link cannot legitimately get
    /// anywhere near this; it only stops a crafted payload from ballooning in memory.
    static let maxInflatedBytes = 4 * 1024 * 1024

    static func base64URLDecode(_ text: String) -> Data? {
        var s = text
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while s.hasSuffix("=") {
            s.removeLast()
        }
        let remainder = s.count % 4
        if remainder == 1 {
            return nil
        }
        if remainder > 0 {
            s += String(repeating: "=", count: 4 - remainder)
        }
        return Data(base64Encoded: s)
    }

    static func base64URLEncode(_ data: Data) -> String {
        return data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Decodes a payload to the UTF-8 JSON bytes of the stats object.
    static func decode(_ payload: String) throws -> Data {
        guard !payload.isEmpty,
              let compressed = base64URLDecode(payload),
              !compressed.isEmpty else {
            throw RecapPayloadError.invalidBase64URL
        }
        let inflated: Data
        do {
            // `.zlib` is raw DEFLATE (RFC 1951) on Apple platforms: no zlib or gzip header.
            inflated = try (compressed as NSData).decompressed(using: .zlib) as Data
        } catch {
            throw RecapPayloadError.inflateFailed
        }
        guard !inflated.isEmpty, inflated.count <= maxInflatedBytes else {
            throw RecapPayloadError.inflateFailed
        }
        return inflated
    }

    /// Encodes the UTF-8 JSON bytes of a stats object as a payload.
    static func encode(json: Data) throws -> String {
        guard !json.isEmpty else {
            throw RecapPayloadError.deflateFailed
        }
        do {
            let deflated = try (json as NSData).compressed(using: .zlib) as Data
            return base64URLEncode(deflated)
        } catch {
            throw RecapPayloadError.deflateFailed
        }
    }

    /// Decodes a payload into a JSON dictionary (all keys preserved, including unknown ones).
    static func decodeObject(_ payload: String) throws -> [String: Any] {
        let json = try decode(payload)
        guard let object = try? JSONSerialization.jsonObject(with: json, options: []),
              let stats = object as? [String: Any] else {
            throw RecapPayloadError.notAStatsObject
        }
        return stats
    }

    /// Serialises a stats dictionary compactly and encodes it as a payload.
    static func encode(object: [String: Any]) throws -> String {
        let canonical = canonicalize(object)
        guard JSONSerialization.isValidJSONObject(canonical),
              let json = try? JSONSerialization.data(
                withJSONObject: canonical,
                options: [.sortedKeys, .withoutEscapingSlashes]
              ) else {
            throw RecapPayloadError.deflateFailed
        }
        return try encode(json: json)
    }

    /// Rewrites floating-point numbers so they serialise in their shortest form
    /// (`0.2456`, not `0.24560000000000001`), which keeps re-encoded links short.
    static func canonicalize(_ value: Any) -> Any {
        if let dictionary = value as? [String: Any] {
            var result: [String: Any] = [:]
            for (key, item) in dictionary {
                result[key] = canonicalize(item)
            }
            return result
        }
        if let array = value as? [Any] {
            return array.map { (item: Any) -> Any in
                return canonicalize(item)
            }
        }
        if let number = value as? NSNumber {
            if CFGetTypeID(number) == CFBooleanGetTypeID() {
                return number
            }
            if CFNumberIsFloatType(number) {
                let double = number.doubleValue
                if !double.isFinite {
                    return NSNumber(value: 0)
                }
                if double == double.rounded(), abs(double) < 1e15 {
                    return NSNumber(value: Int64(double))
                }
                let decimal = NSDecimalNumber(string: "\(double)")
                if decimal == NSDecimalNumber.notANumber {
                    return number
                }
                return decimal
            }
            return number
        }
        return value
    }
}
