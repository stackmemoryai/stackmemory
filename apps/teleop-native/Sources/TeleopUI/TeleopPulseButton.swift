import SwiftUI

struct TeleopPulseButton: View {
    let state: TeleopConnectionState
    let action: () -> Void

    @State private var pulse = false

    var body: some View {
        Button(action: action) {
            ZStack {
                ForEach(0..<3, id: \.self) { index in
                    Circle()
                        .stroke(ringColor.opacity(0.30), lineWidth: 2)
                        .frame(width: 170 + CGFloat(index * 42), height: 170 + CGFloat(index * 42))
                        .scaleEffect(pulse ? 1.12 : 0.86)
                        .opacity(pulse ? 0.0 : 0.55)
                        .animation(
                            .easeOut(duration: 1.45)
                                .repeatForever(autoreverses: false)
                                .delay(Double(index) * 0.18),
                            value: pulse
                        )
                }

                Circle()
                    .fill(buttonFill)
                    .frame(width: 168, height: 168)
                    .shadow(color: ringColor.opacity(0.34), radius: 30, y: 16)

                Image(systemName: iconName)
                    .font(.system(size: 58, weight: .semibold))
                    .foregroundStyle(.white)
                    .symbolEffect(.pulse, options: .repeating, value: isAnimated)
            }
            .frame(width: 280, height: 280)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilityLabel)
        .onAppear {
            pulse = true
        }
        .onChange(of: state) { _, newState in
            pulse = newState != .idle
        }
    }

    private var iconName: String {
        switch state {
        case .idle:
            return "mic.fill"
        case .connecting:
            return "antenna.radiowaves.left.and.right"
        case .live:
            return "waveform"
        case .thinking:
            return "hand.raised.fill"
        case .fault:
            return "exclamationmark.triangle.fill"
        }
    }

    private var accessibilityLabel: String {
        switch state {
        case .idle:
            return "Start voice teleoperation"
        case .connecting:
            return "Cancel connection"
        case .live:
            return "Interrupt or stop motion"
        case .thinking:
            return "Resume live control"
        case .fault:
            return "Reconnect"
        }
    }

    private var buttonFill: LinearGradient {
        LinearGradient(
            colors: [ringColor.opacity(0.95), ringColor.opacity(0.48)],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }

    private var ringColor: Color {
        switch state {
        case .idle:
            return .teal
        case .connecting:
            return .cyan
        case .live:
            return .green
        case .thinking:
            return .orange
        case .fault:
            return .red
        }
    }

    private var isAnimated: Bool {
        state == .connecting || state == .live || state == .thinking
    }
}
