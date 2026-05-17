import SwiftUI
import TeleopUI

@main
struct TeleopMacApp: App {
    var body: some Scene {
        WindowGroup {
            TeleopHomeView()
                .frame(minWidth: 360, minHeight: 620)
        }
        .windowStyle(.hiddenTitleBar)
    }
}
