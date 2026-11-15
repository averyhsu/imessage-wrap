import UIKit

/// The live message bubble (transcript presentation style): chat name, a big message
/// count and "Tap to play". Deliberately plain UIKit with no web view: Messages creates
/// one of these per bubble in the transcript, so it has to be cheap.
/// It uses the story's cover look: blue gradient with a lighter rounded blob.
final class RecapBubbleView: UIView {
    /// Called when the bubble is tapped.
    var onTap: (() -> Void)?

    private let gradientLayer = CAGradientLayer()
    private let blobLayer = CAShapeLayer()
    private let eyebrowLabel = UILabel()
    private let nameLabel = UILabel()
    private let countLabel = UILabel()
    private let unitLabel = UILabel()
    private let playLabel = UILabel()

    /// The top-left area Messages covers with its app-icon badge: text starts to the right
    /// of `width` on the first line and below `height` otherwise.
    static let badgeClearance = CGSize(width: 46, height: 34)

    /// The bubble size for the space Messages offers. Never larger than `maximum`.
    static func preferredSize(fitting maximum: CGSize) -> CGSize {
        let width = min(maximum.width, 300)
        let height = min(maximum.height, 188)
        return CGSize(width: max(width, 0), height: max(height, 0))
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        setUp()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    private func setUp() {
        backgroundColor = WrappedTheme.blueUI
        clipsToBounds = true

        gradientLayer.colors = WrappedTheme.coverCGColors
        gradientLayer.locations = [0.0, 0.38, 1.0]
        gradientLayer.startPoint = CGPoint(x: 0.37, y: 0)
        gradientLayer.endPoint = CGPoint(x: 0.63, y: 1)
        layer.addSublayer(gradientLayer)

        blobLayer.fillColor = WrappedTheme.blobLightUI.cgColor
        layer.addSublayer(blobLayer)

        eyebrowLabel.font = WrappedTheme.displayFont(ofSize: 10.5, weight: .heavy)
        eyebrowLabel.textColor = UIColor.white.withAlphaComponent(0.86)
        eyebrowLabel.numberOfLines = 1

        nameLabel.font = WrappedTheme.displayFont(ofSize: 17, weight: .black)
        nameLabel.textColor = .white
        nameLabel.numberOfLines = 1
        nameLabel.lineBreakMode = .byTruncatingTail

        countLabel.font = WrappedTheme.displayFont(ofSize: 46, weight: .black)
        countLabel.textColor = .white
        countLabel.numberOfLines = 1
        countLabel.adjustsFontSizeToFitWidth = true
        countLabel.minimumScaleFactor = 0.5
        countLabel.baselineAdjustment = .alignBaselines

        unitLabel.font = WrappedTheme.displayFont(ofSize: 14, weight: .black)
        unitLabel.textColor = .white
        unitLabel.numberOfLines = 1

        playLabel.font = UIFont.systemFont(ofSize: 13, weight: .heavy)
        playLabel.textColor = WrappedTheme.coverBottomUI
        playLabel.text = "▶  Tap to play"
        playLabel.textAlignment = .center
        playLabel.backgroundColor = .white
        playLabel.layer.cornerRadius = 15
        playLabel.layer.masksToBounds = true

        let textStack = UIStackView(arrangedSubviews: [nameLabel, countLabel, unitLabel])
        textStack.axis = .vertical
        textStack.alignment = .leading
        textStack.spacing = 1
        textStack.setCustomSpacing(3, after: nameLabel)
        textStack.setCustomSpacing(0, after: countLabel)
        textStack.translatesAutoresizingMaskIntoConstraints = false
        eyebrowLabel.translatesAutoresizingMaskIntoConstraints = false
        playLabel.translatesAutoresizingMaskIntoConstraints = false

        addSubview(eyebrowLabel)
        addSubview(textStack)
        addSubview(playLabel)

        // Messages lays its app-icon badge over the top-left corner of a live bubble
        // (roughly 38 x 30 pt, seen in the Simulator on iOS 26). The eyebrow therefore
        // starts to the right of it and everything else starts below it.
        // Messages also draws the bubble tail on the trailing side, so keep room there.
        let bottom = playLabel.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -14)
        bottom.priority = UILayoutPriority(999)
        NSLayoutConstraint.activate([
            eyebrowLabel.topAnchor.constraint(equalTo: topAnchor, constant: 12),
            eyebrowLabel.leadingAnchor.constraint(equalTo: leadingAnchor, constant: RecapBubbleView.badgeClearance.width),
            eyebrowLabel.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -20),
            textStack.topAnchor.constraint(equalTo: topAnchor, constant: RecapBubbleView.badgeClearance.height),
            textStack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
            textStack.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -20),
            countLabel.widthAnchor.constraint(lessThanOrEqualTo: widthAnchor, constant: -36),
            playLabel.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
            playLabel.heightAnchor.constraint(equalToConstant: 30),
            playLabel.widthAnchor.constraint(equalToConstant: 128),
            bottom
        ])

        isAccessibilityElement = true
        accessibilityTraits = .button
        accessibilityIdentifier = "bubble.recap"

        let tap = UITapGestureRecognizer(target: self, action: #selector(handleTap))
        addGestureRecognizer(tap)
        configure(with: nil)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        gradientLayer.frame = bounds

        // A rounded blob leaning in from the lower right, as on the story's cover.
        let blobSize = CGSize(width: bounds.width * 0.62, height: bounds.height * 0.78)
        let blobRect = CGRect(x: -blobSize.width / 2, y: -blobSize.height / 2, width: blobSize.width, height: blobSize.height)
        blobLayer.path = UIBezierPath(roundedRect: blobRect, cornerRadius: blobSize.height * 0.36).cgPath
        blobLayer.bounds = CGRect(origin: .zero, size: .zero)
        blobLayer.position = CGPoint(x: bounds.maxX - blobSize.width * 0.12, y: bounds.maxY + blobSize.height * 0.02)
        blobLayer.setAffineTransform(CGAffineTransform(rotationAngle: -12 * .pi / 180))
        CATransaction.commit()
    }

    /// Shows a recap, or a neutral "open" state when the message carries none we can read.
    func configure(with summary: RecapSummary?, eyebrow: String? = nil) {
        if let summary = summary {
            eyebrowLabel.attributedText = NSAttributedString(
                string: eyebrow ?? summary.reviewLabel.uppercased(),
                attributes: [.kern: 1.2]
            )
            nameLabel.text = summary.chatName
            countLabel.text = summary.formattedTotal
            unitLabel.text = summary.totalMessages == 1 ? "message" : "messages"
            accessibilityLabel = "\(summary.caption). \(summary.messagesLine). Tap to play."
        } else {
            eyebrowLabel.attributedText = NSAttributedString(
                string: "IN REVIEW",
                attributes: [.kern: 1.2]
            )
            nameLabel.text = WrappedConfig.productName
            countLabel.text = "▶"
            unitLabel.text = "Open to play this recap"
            accessibilityLabel = "\(WrappedConfig.productName) recap. Tap to play."
        }
    }

    @objc private func handleTap() {
        onTap?()
    }
}
