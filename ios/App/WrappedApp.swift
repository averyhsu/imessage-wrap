import SwiftUI

@main
struct WrappedApp: App {
    @StateObject private var model = AppModel()

    init() {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--ui-testing") {
            StoryViewController.showsBridgeStatusForTesting = true
        }
        #endif
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .preferredColorScheme(.dark)
                .onOpenURL { (url: URL) in
                    _ = model.open(url)
                }
        }
    }
}

/// Home, or the debug gallery when launched with `--gallery`; the story plays on top.
struct RootView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        Group {
            if model.showsGallery {
                DebugGalleryView()
            } else {
                HomeView()
            }
        }
        .fullScreenCover(item: $model.playing) { (recap: Recap) in
            StoryScreen(recap: recap, onClose: {
                model.playing = nil
            })
            .ignoresSafeArea()
        }
        .onAppear {
            // Start the story's web view while the person reads the home screen, so the
            // first story opens without waiting for a web process and a page load.
            StoryWebViewPool.prewarm()
        }
    }
}
