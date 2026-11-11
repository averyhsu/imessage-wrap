// Archive genuine attributed strings with NSArchiver, the "typedstream" encoder
// that Messages itself uses for message.attributedBody, and write them out as
// JSON so both decoders (wrapped/typedstream.py and web/make/engine.js) can be
// checked against Apple's real format rather than against our own writer.
//
//     swift tests/conformance/real_typedstream.swift OUT.json
//
// macOS only (NSArchiver does not exist elsewhere). Everything is invented text.
// Output: [{"name", "string", "mutable", "messages_layout", "hex"}, ...] where
// "messages_layout" marks the samples built exactly like a plain Messages row
// (one run carrying __kIMMessagePartAttributeName = 0), which the fixture
// writer in tests/fixtures/build_fixture.py must reproduce byte for byte.

import Foundation

let partKey = NSAttributedString.Key("__kIMMessagePartAttributeName")
let fileKey = NSAttributedString.Key("__kIMFileTransferGUIDAttributeName")
let linkKey = NSAttributedString.Key("__kIMLinkAttributeName")
let objectReplacement = "\u{FFFC}"

var samples: [[String: Any]] = []
var failures = 0
setvbuf(stdout, nil, _IONBF, 0)     // keep the log complete if Foundation raises an exception

func hex(_ data: Data) -> String {
    return data.map { String(format: "%02x", $0) }.joined()
}

func pattern(_ count: Int) -> String {
    // "0123456789" repeated, so a decoder that is off by a few bytes is caught
    let digits = Array("0123456789")
    var out = String()
    out.reserveCapacity(count)
    for index in 0..<count {
        out.append(digits[index % 10])
    }
    return out
}

func record(_ name: String, _ value: NSAttributedString, mutable: Bool, messagesLayout: Bool,
            roundTrip: Bool = false) {
    print("archiving \(name) (\(value.string.utf8.count) bytes of UTF-8)")
    let data = NSArchiver.archivedData(withRootObject: value)
    // For the plain samples, check that Apple's own decoder reads the archive
    // back. (Not for every shape: NSUnarchiver raises Objective-C exceptions,
    // which a Swift script cannot catch, on input it dislikes.)
    if roundTrip {
        if let back = NSUnarchiver.unarchiveObject(with: data) as? NSAttributedString {
            if back.string != value.string {
                print("ROUND TRIP MISMATCH: \(name)")
                failures += 1
            }
        } else {
            print("NSUnarchiver could not read its own archive: \(name)")
            failures += 1
        }
    }
    samples.append([
        "name": name,
        "string": value.string,
        "mutable": mutable,
        "messages_layout": messagesLayout,
        "hex": hex(data),
    ])
}

/// One run with the attribute Messages puts on every plain text message.
func plain(_ name: String, _ text: String, roundTrip: Bool = true) {
    let attributes: [NSAttributedString.Key: Any] = [partKey: NSNumber(value: Int32(0))]
    record(name, NSAttributedString(string: text, attributes: attributes),
           mutable: false, messagesLayout: true, roundTrip: roundTrip)
    record(name + "_mutable", NSMutableAttributedString(string: text, attributes: attributes),
           mutable: true, messagesLayout: true, roundTrip: roundTrip)
}

// ---- every length encoding ----------------------------------------------------
// (An empty string cannot carry attributes: NSUnarchiver raises a range
// exception on such an archive, so the empty case is archived without any.)
record("len0", NSAttributedString(string: ""), mutable: false, messagesLayout: false)
record("len0_mutable", NSMutableAttributedString(string: ""), mutable: true, messagesLayout: false)
for count in [1, 2, 12, 126, 127, 128, 129, 200, 255, 256, 257, 300, 1000, 2359,
              32767, 32768, 40000, 65535, 65536, 70000] {
    plain("len\(count)", pattern(count))
}

// ---- text that is not ASCII ------------------------------------------------------
plain("emoji", "ok \u{1F44D}\u{1F3FD} see you \u{1F389}\u{1F389} at the caf\u{E9}")
plain("emoji_280_bytes", String(repeating: "\u{1F602}", count: 70))
plain("family_and_flag", "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466} \u{1F1E8}\u{1F1E6}")
plain("cjk", String(repeating: "\u{660E}\u{65E5}\u{306E}\u{591C}\u{3054}\u{98EF}", count: 30))
plain("accents_127_bytes", String(repeating: "\u{E9}", count: 63) + "a")
plain("accents_128_bytes", String(repeating: "\u{E9}", count: 64))
plain("multiline", "line one\nline two\r\n\tindented")
plain("nul_inside", "nul\u{0}inside")
// NSUnarchiver drops a leading U+FEFF from the string and then raises because
// the attribute run is one character too long, so no round trip for this one.
// Our decoders return what the archive holds: the text with its U+FEFF.
plain("bom_first", "\u{FEFF}leading bom", roundTrip: false)
plain("odd_whitespace", "nbsp\u{A0}and\u{2028}line separator\u{3000}wide")
plain("looks_like_tags", "\u{84}\u{85}\u{86} + NSString +")
plain("decoy_marker", "NSString\u{1}+\u{5}hello NSString\u{1}+")
record("attachment_only", NSAttributedString(string: objectReplacement, attributes: [
    fileKey: "at_0_FAKE-TRANSFER-GUID" as NSString,
    partKey: NSNumber(value: Int32(0)),
]), mutable: false, messagesLayout: false)

// ---- other shapes Messages produces ------------------------------------------------
record("no_attributes", NSAttributedString(string: "plain, no attributes at all"),
       mutable: false, messagesLayout: false)
record("no_attributes_mutable", NSMutableAttributedString(string: "plain, no attributes at all"),
       mutable: true, messagesLayout: false)
record("no_attributes_long", NSAttributedString(string: pattern(5000)),
       mutable: false, messagesLayout: false)

func attachmentAndText(mutable: Bool) -> NSAttributedString {
    let whole = NSMutableAttributedString()
    whole.append(NSAttributedString(string: objectReplacement, attributes: [
        fileKey: "at_0_FAKE-TRANSFER-GUID" as NSString,
        partKey: NSNumber(value: Int32(0)),
    ]))
    whole.append(NSAttributedString(string: "Look at this cover", attributes: [
        partKey: NSNumber(value: Int32(1)),
    ]))
    return mutable ? whole : NSAttributedString(attributedString: whole)
}
record("attachment_and_text", attachmentAndText(mutable: false), mutable: false, messagesLayout: false)
record("attachment_and_text_mutable", attachmentAndText(mutable: true), mutable: true, messagesLayout: false)

func threeRuns(mutable: Bool) -> NSAttributedString {
    let whole = NSMutableAttributedString(string: "see https://example.com/menu for the menu \u{1F32E}",
                                          attributes: [partKey: NSNumber(value: Int32(0))])
    whole.addAttribute(linkKey, value: NSURL(string: "https://example.com/menu")!,
                       range: NSRange(location: 4, length: 24))
    return mutable ? whole : NSAttributedString(attributedString: whole)
}
record("link_run", threeRuns(mutable: false), mutable: false, messagesLayout: false)
record("link_run_mutable", threeRuns(mutable: true), mutable: true, messagesLayout: false)

let int64Part = NSAttributedString(string: "part number stored as a 64-bit integer",
                                   attributes: [partKey: NSNumber(value: Int64(0))])
record("int64_part", int64Part, mutable: false, messagesLayout: false)

let manyRuns = NSMutableAttributedString()
for index in 0..<40 {
    manyRuns.append(NSAttributedString(string: "run \(index) ", attributes: [
        partKey: NSNumber(value: Int32(index)),
    ]))
}
record("forty_runs_mutable", manyRuns, mutable: true, messagesLayout: false)

// ---- write ---------------------------------------------------------------------------
guard CommandLine.arguments.count == 2 else {
    FileHandle.standardError.write("usage: swift real_typedstream.swift OUT.json\n".data(using: .utf8)!)
    exit(2)
}
let json = try JSONSerialization.data(withJSONObject: samples, options: [.sortedKeys])
try json.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
print("wrote \(samples.count) NSArchiver samples to \(CommandLine.arguments[1])")
if failures > 0 {
    print("\(failures) sample(s) failed to round-trip through NSUnarchiver")
    exit(1)
}
