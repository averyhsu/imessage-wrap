import Foundation

/// The bundled demo recap: invented data, no real people, chats or messages.
/// It is the site's demo (`web/js/demo-data.js`, "Dinner Club"): the same stats the web
/// story shows for `?demo=1`. Regenerate with `python3 ios/scripts/make-demo-payload.py`
/// when the demo changes; `tests/python/test_ios_demo.py` fails when the two differ.
enum DemoRecap {
    static let payload: String = [
        "hZfNjts2EMdfhdGZuxW_JMq3JE3bBN1sgWwPRRAYtMW1GcuiI9HrugsDQW89FC3QQ4ugQQ4F8gy99V3yAs0jdEjb-rC9KbCH",
        "JTXk_Dgz_A99G91EA4Kj8VS5aHAblWquo0H0uSlLXaGHxXKEPr77-W2Eo7mej3RVR4N0g6OFrozN_YJCjXQBK2hME7Cqnarc",
        "bngWE_iDSV3m-ylCzkgcwQ7OOlXUfoe5rms10fA_l5QwHK1slcOIChIzjiPlnBpP57p0MMkIjXFUaTV2xpYwkYWJXK3roZ-7",
        "AXoWw4EKW8Keblg7MJ5FA-mxR-vh1C6raPCc8oxiklKBCYkpTijDjMEAZplkOCMEE87kzkQmGaZxQjBlWYIpjb0lSY8-JJJj",
        "KtMEM5LAhoKnmGWpxJwm4kVwv9J6BrBAkMSpAL8kwwmHDZJEMJwKSrCkGcNJlpHtirkt3RTsmUgkMNIUc8LBQwYQnLMEi5hw",
        "HHYTnIOvhEosqBCYcjhF7HdZ1sbHIji-hWA53aQoPYt5yO4-CQmh2wTXtlSFcWGJ8Qm8NpWe2lr7jM7tSwNTH9-9-QeGzrjC",
        "b3k11eiL1goiD5vAPBEc7T0ghYADI1sidaMrmALLUbGsRv9reI4ulk4j5dAasojsqkSVqWfnkedVs11uKQP-As44LM1k6vol",
        "ltA0hSqdqgp443PCIPlQi4tu7eubXkCgJvkGtqyhjMMFeN6YXqi16tkSIjnt7E-5SJqChuTG8UE9p95_F5YAUqfAhxMoaQgh",
        "Ed6wna70WMMXSAvJYr7Bd9JnKSNdoJjIBogn6RGQIKIP5I9_Cogm8R1AnLEO0DeVOQiS5HHSzUHKeYsExz9EyjjpI6VwVU4Q",
        "MSnvIIIod4ieQGFP-zWfeRFpiThIwZ6IiUwcEgVPXaKM01NEMVzAO5ImZYfoCkh6QIL1y5SQFohyeRSireR1gEQiTgBRyu9K",
        "WkxJB-hCVeNlH4l7nWyRYilIJ2v0CIn4E_SQ4lMx8jJ2kijhcQfoa10e3DTpc9TiMNniyEwe9g1Q535VC3ICRhJ-GoYzugEh",
        "nVtQ0fDdT4IObDWhU-WdzpTgvtKyM-KV1unvfYP8duE_DpADyfzw-s9XSzOeIYHmpvQSB57NQn94_RZNVY3s9bUZG1UUawSn",
        "0ZXOkZc65FYWNpyZMq-3rXg5gU7BvTwvYJ35QYfeXljfFcnGh7MB3l-CTwCnZyRrgR-jl8vaoRVocY5GCmhBh2s717bUaDW1",
        "8KVGpQ0Wppz4r3Ov2DaMnAU5L_UKjaGjYDSxNh-tNbq2lQZtP3EK0T9FH35XDZ9gz85i2mX_8vIKXX31CD25fHDv3r2evxCd",
        "I3cvetvf-k7sl7QrKJEZxNbMvL3wEpGbejeUQdTDOaiEjt3bGx4NOHq1hIZsfHOkKW_6aRZ6L7SjUJBVpyntFGJsl6Xb3uOd",
        "4a5Gu7b71O6Mg9aAtVqpcDue79r5Wi0WIfRtM__9r3___uWgn3-3N1uFN2Hb9XLtlPFPPxA56HpN3z5HT-3I5muk6pnOzyOf",
        "ueBwDMWSG1X2XP7x44G_h61V43F_osblhcp1uDr-3YpCqBEEDzkDFB2X4bYP7aro-Xz_04HPp94MXQazxum2kzYu4bnIuo-T",
        "a7iIcF3z4KLjMryAD-L65vXRIUvIWa18CaBnzYrG915OGu_P4OKHA8MjrHZ7DFCGMAnvJJQlR6c3XiwqO1HOdnk-vP3tAOdx",
        "37DB2FVdQ3HfZxTJmKF9_XbdaVUV6-HIVHnv8L--P_D2yNuhB1u7TlXtWk7jDV6ibbxH2msFytD9C3DptRjMfNFPNKwP4INo",
        "VflizT_zPzpqUMixd5kDCox3drr3U4REm81_"
    ].joined()

    /// Decoded lazily; the fallback only exists so a damaged constant cannot crash the app.
    static let recap: Recap = {
        if let decoded = try? Recap(payload: payload) {
            return decoded
        }
        let summary = RecapSummary(chatName: "Demo chat", periodLabel: "2026", totalMessages: 0)
        return Recap(unvalidatedPayload: payload, summary: summary)
    }()
}
