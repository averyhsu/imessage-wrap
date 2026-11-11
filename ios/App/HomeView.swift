import SwiftUI

/// Stage 1 placeholder home screen. Replaced by the real shell in Stage 2.
struct HomeView: View {
    var body: some View {
        ZStack {
            LinearGradient(
                colors: [Color(red: 0.09, green: 0.05, blue: 0.16), Color.black],
                startPoint: .top,
                endPoint: .bottom
            )
            .ignoresSafeArea()

            VStack(spacing: 16) {
                Text(WrappedConfig.productName)
                    .font(.system(size: 52, weight: .heavy, design: .rounded))
                    .foregroundStyle(
                        LinearGradient(
                            colors: [
                                Color(red: 1.0, green: 0.24, blue: 0.5),
                                Color(red: 0.61, green: 0.3, blue: 1.0),
                                Color(red: 0.24, green: 0.55, blue: 1.0)
                            ],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                    )
                    .accessibilityIdentifier("home.title")
                Text(WrappedConfig.productDescriptor)
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.8))
                Text("Stage 1 build check")
                    .font(.footnote)
                    .foregroundStyle(.white.opacity(0.5))
            }
            .padding(24)
        }
    }
}
