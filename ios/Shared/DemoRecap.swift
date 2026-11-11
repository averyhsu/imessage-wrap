import Foundation

/// The bundled demo recap: invented data, no real people, chats or messages.
/// It is the cross-language test vector `tests/vectors/payload-v1.json` ("Dinner Club"),
/// the same stats the web story shows for `?demo=1`. Regenerate with
/// `python3 ios/scripts/make-demo-payload.py` if the vector changes.
enum DemoRecap {
    static let payload: String = [
        "fZfNjts2EMdfhdGZ6_JTonxr06JpkE0W7fZQBMGCtri2YllUJHpdd2Eg6K2Hoih6aFE0yCFAn6FA3yYv0DxCh7RsSV5vgD2s",
        "yCH_P84MZ-jb6CYaUxxN59pF49uo1EsTjaPP87I0NXpYrCbow9uf30Q4WprlxNRNNE62OKpMndvMLyj0xBSwghEWg1XjdO3a",
        "zzNC4Q8GTZnthyg9oySCHZx1umj8DkvTNHpm4H-hGOU4Wts6gy8mKeECR9o5PZ0vTelgkFNGcFQbPXW5LWEgDQOZ3jRXfuwG",
        "6DmBAxW2hD3dVePAeBGNlceebK7mdlVH4-dMpAzThElMKWE4ZhxzDh8wyhXHKaWYCq5aExWnmJGYYsbTGDNGvCVN7kzESmCm",
        "khhzGsOGUiSYp4nCgsXyRZBfG7MAWCCISSJBl6Y4FrBBHEuOE8koVizlOE5TuluxtKWbgz2XsQJGlmBBBSikACEEj7EkVOCw",
        "mxQCtGKmsGRSYibgFMTvsmpy74sgfAvOcuYQouSMiBDdfRBiynYBbmypi9yFJbkPYJnP5u7KriFsEL_cFX6Xy7lBT_0Eerab",
        "mBSregITF-B25L09RpSii_MR-qYwpkJ5gzRqVjMfHQjhKPJietEGhnEQLwDwKqgN8yNmSQIpNtc1KJMR5RA5SKSqn7jmZnAa",
        "SCixhS0byMGQvc8Ppud6owe2lCrBevszIeNDNkJkCDlKxsTr92EpIPWy82oG-VjCsPSG3XBtpgZmwKc0JWKL76VPE077QISq",
        "A5CIkztAksohkD_-KSAWk3uABOc9oIs6P3KSEiTuxyARokOC4x8jpYIOkRLI8xNEXKl7iMDLPaLHkJXzYcKmvgJ0RALu8Z6I",
        "y1QeEwWlPlEq2CkiArfnnqAp1SO6BJIBkOTDNKW0A2JC3XHRrl71gGQsTwAxJu4LGmG0B3Su6-lqiCR8keuQiJK0FzV2B4n6",
        "EwyQyCkf-Rp0kigWpAf0xJRHN035GHU4XHU4KlXHRR9K6zCrJT0Bo6g4DSM420IVXFoogWHeD0Id2NWEXpb32kqMh2WSn1Ff",
        "Jp353ne3bys_OUYOit_713-9WuXTBZJomZcrZxAo55V5__oNmusG2evrfJrrotggOI2pTRaqInJrCxsu8jJrdn10NYMyD0cw",
        "ywrW5T-Y0JgL61sa3Xp3HoD3l-AjwMkZTTvgr9DLVePQWoND0EQDrXaosUtjS4PWcwszDSptsMjLmZ9dmhE6t-HLWSjZpVmj",
        "KbQDjGbWZpONQde2NjfAc_cUcniKIXybDR9hT88I67N_-ewSXT76Aj1-9tmDBw8GesE7d-ReDLa_9W3UL-lWMKpS8G2-8PbS",
        "l4gsb9pPFYp6OAdT0G4He0PHx9Gr1a53gUESAmZf5uElEt41VUjIuteU2goxtavS7e5xa9jmaN92H9rWONQasNZrHW7H87YX",
        "b3RVBde34tGHt7-_---fX44683d7s3V40HVdLzNO5_7dBkUOuh7a380RemonNtsg3SxMNop85IIgdPXFkeCv_x6pPdnbHNTa",
        "WHdqGG5-T-xro7MG-SzauDmkGkYNvOQQPDtg15764ekxAPj7p_seIn2GXVM9IMCzj4sDAtLXcCfh5mZBoic5hduR5bocKP7x",
        "45Hiw87qILgP4UHyXGcm1Ar_ykYhtxBkC3I5YPQk55vKDOR-e3ck9wgs0DlUxrw0fck2ww6KjzRctgzZlUMM3oEEOV35a99X",
        "K-EmFHnjhop_Hru0s-rlUNtgurhCEUehgKPKu3Pn3RH6FFW61rNaV3O0e1ICgK_FsNAn_czAjtpZv-u69smafeJ_MTRQIace",
        "IQM0-G7tzOB3BI222_8B"
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
