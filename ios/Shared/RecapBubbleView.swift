import UIKit

/// The live message bubble (transcript presentation style): chat name, a big message
/// count and "Tap to play". Deliberately plain UIKit with no web view: Messages creates
/// one of these per bubble in the transcript, so it has to be cheap.
final class RecapBubbleView: UIView {
    /// Called when the bubble is tapped.
    var onTap: (() -> Void)?

    private let gradientLayer = CAGradientLayer()
    private let eyebrowLabel = UILabel()
    private let nameLabel = UILabel()
    private let countLabel = UILabel()
    private let unitLabel = UILabel()
    private let playLabel = UILabel()

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
        backgroundColor = WrappedTheme.violetUI
        clipsToBounds = true

        gradientLayer.colors = WrappedTheme.brandCGColors
        gradientLayer.locations = [0.0, 0.55, 1.0]
        gradientLayer.startPoint = CGPoint(x: 0, y: 0)
        gradientLayer.endPoint = CGPoint(x: 1, y: 1)
        layer.addSublayer(gradientLayer)

        eyebrowLabel.font = UIFont.systemFont(ofSize: 11, weight: .bold)
        eyebrowLabel.textColor = UIColor.white.withAlphaComponent(0.86)
        eyebrowLabel.numberOfLines = 1

        nameLabel.font = WrappedTheme.roundedFont(ofSize: 19, weight: .heavy)
        nameLabel.textColor = .white
        nameLabel.numberOfLines = 1
        nameLabel.lineBreakMode = .byTruncatingTail

        countLabel.font = WrappedTheme.roundedFont(ofSize: 50, weight: .black)
        countLabel.textColor = .white
        countLabel.numberOfLines = 1
        countLabel.adjustsFontSizeToFitWidth = true
        countLabel.minimumScaleFactor = 0.5
        countLabel.baselineAdjustment = .alignBaselines

        unitLabel.font = UIFont.systemFont(ofSize: 14, weight: .semibold)
        unitLabel.textColor = UIColor.white.withAlphaComponent(0.9)
        unitLabel.numberOfLines = 1

        playLabel.font = UIFont.systemFont(ofSize: 13, weight: .bold)
        playLabel.textColor = .white
        playLabel.text = "▶  Tap to play"
        playLabel.textAlignment = .center
        playLabel.backgroundColor = UIColor.black.withAlphaComponent(0.28)
        playLabel.layer.cornerRadius = 15
        playLabel.layer.masksToBounds = true

        let textStack = UIStackView(arrangedSubviews: [eyebrowLabel, nameLabel, countLabel, unitLabel])
        textStack.axis = .vertical
        textStack.alignment = .leading
        textStack.spacing = 1
        textStack.setCustomSpacing(4, after: nameLabel)
        textStack.setCustomSpacing(-4, after: countLabel)
        textStack.translatesAutoresizingMaskIntoConstraints = false
        playLabel.translatesAutoresizingMaskIntoConstraints = false

        addSubview(textStack)
        addSubview(playLabel)

        // Messages draws the bubble tail on the trailing side, so keep a little extra room there.
        let bottom = playLabel.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -14)
        bottom.priority = UILayoutPriority(999)
        NSLayoutConstraint.activate([
            textStack.topAnchor.constraint(equalTo: topAnchor, constant: 14),
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
        CATransaction.commit()
    }

    /// Shows a recap, or a neutral "open" state when the message carries none we can read.
    func configure(with summary: RecapSummary?) {
        if let summary = summary {
            eyebrowLabel.attributedText = NSAttributedString(
                string: summary.reviewLabel.uppercased(),
                attributes: [.kern: 1.3]
            )
            nameLabel.text = summary.chatName
            countLabel.text = summary.formattedTotal
            unitLabel.text = summary.totalMessages == 1 ? "message" : "messages"
            accessibilityLabel = "\(summary.caption). \(summary.messagesLine). Tap to play."
        } else {
            eyebrowLabel.attributedText = NSAttributedString(
                string: "IN REVIEW",
                attributes: [.kern: 1.3]
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
