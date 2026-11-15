import Compression
import Foundation

/// Errors from decoding, encoding or fitting a recap link payload.
enum RecapPayloadError: Error, Equatable {
    case invalidBase64URL
    case payloadTooLong(length: Int, limit: Int)
    case inflateFailed
    case inflatedTooLarge(limit: Int)
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
        case .payloadTooLong, .inflatedTooLarge:
            return "That link is too large to be a recap."
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
    /// Longest payload that is decoded at all. Links are capped at 4,800 characters
    /// (docs/SCHEMA.md §5); anything much longer is not a recap link.
    static let maxPayloadCharacters = 8000

    /// Hard cap for the inflated JSON. A real recap is a few kilobytes. Inflating stops at
    /// this size, so a crafted payload (a "deflate bomb") cannot balloon in memory, which
    /// matters most inside the iMessage extension.
    static let maxInflatedBytes = 256 * 1024

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
    /// Input comes from links, the clipboard and other people's messages, so it is treated
    /// as hostile: length-checked before decoding and inflated with a hard output cap.
    static func decode(_ payload: String) throws -> Data {
        let length = payload.utf8.count
        guard length <= maxPayloadCharacters else {
            throw RecapPayloadError.payloadTooLong(length: length, limit: maxPayloadCharacters)
        }
        guard !payload.isEmpty,
              let compressed = base64URLDecode(payload),
              !compressed.isEmpty else {
            throw RecapPayloadError.invalidBase64URL
        }
        return try inflateRaw(compressed, limit: maxInflatedBytes)
    }

    /// Inflates raw DEFLATE (RFC 1951, no zlib or gzip header) in chunks and gives up as
    /// soon as the output would pass `limit`. Throws `.inflatedTooLarge` in that case and
    /// `.inflateFailed` for corrupt or truncated input.
    static func inflateRaw(_ compressed: Data, limit: Int) throws -> Data {
        guard !compressed.isEmpty else {
            throw RecapPayloadError.inflateFailed
        }
        let stream = UnsafeMutablePointer<compression_stream>.allocate(capacity: 1)
        defer {
            stream.deallocate()
        }
        // COMPRESSION_ZLIB is raw DEFLATE on Apple platforms.
        guard compression_stream_init(stream, COMPRESSION_STREAM_DECODE, COMPRESSION_ZLIB) == COMPRESSION_STATUS_OK else {
            throw RecapPayloadError.inflateFailed
        }
        defer {
            compression_stream_destroy(stream)
        }

        let chunkSize = 16 * 1024
        let chunk = UnsafeMutablePointer<UInt8>.allocate(capacity: chunkSize)
        defer {
            chunk.deallocate()
        }

        var output = Data()
        try compressed.withUnsafeBytes { (raw: UnsafeRawBufferPointer) -> Void in
            guard let source = raw.bindMemory(to: UInt8.self).baseAddress else {
                throw RecapPayloadError.inflateFailed
            }
            stream.pointee.src_ptr = source
            stream.pointee.src_size = raw.count
            let flags = Int32(COMPRESSION_STREAM_FINALIZE.rawValue)
            var idleRounds = 0

            while true {
                stream.pointee.dst_ptr = chunk
                stream.pointee.dst_size = chunkSize
                let status = compression_stream_process(stream, flags)
                guard status == COMPRESSION_STATUS_OK || status == COMPRESSION_STATUS_END else {
                    throw RecapPayloadError.inflateFailed
                }
                let produced = chunkSize - stream.pointee.dst_size
                if output.count + produced > limit {
                    throw RecapPayloadError.inflatedTooLarge(limit: limit)
                }
                if produced > 0 {
                    output.append(chunk, count: produced)
                }
                if status == COMPRESSION_STATUS_END {
                    return
                }
                // Not at the end of the stream, the output chunk was not filled and
                // there is no input left: the DEFLATE data stops short.
                if produced < chunkSize && stream.pointee.src_size == 0 {
                    throw RecapPayloadError.inflateFailed
                }
                // Belt and braces: never spin without making progress.
                idleRounds = produced == 0 ? idleRounds + 1 : 0
                if idleRounds > 2 {
                    throw RecapPayloadError.inflateFailed
                }
            }
        }
        guard !output.isEmpty else {
            throw RecapPayloadError.inflateFailed
        }
        return output
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
