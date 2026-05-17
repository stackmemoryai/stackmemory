import SwiftUI

public struct TeleopHomeView: View {
    @StateObject private var session = TeleopSession()

    public init() {}

    public var body: some View {
        ZStack {
            TeleopBackground(state: session.state)

            VStack(spacing: 26) {
                TelemetryStrip(sample: session.telemetry, state: session.state)
                    .padding(.top, 26)

                Spacer(minLength: 20)

                TeleopPulseButton(state: session.state) {
                    session.pressPrimary()
                }

                if !session.agentSummary.isEmpty {
                    AgentCue(text: session.agentSummary)
                        .transition(.opacity.combined(with: .scale(scale: 0.96)))
                }

                Spacer(minLength: 32)
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 20)
        }
        .accessibilityElement(children: .contain)
        .onDisappear {
            session.stop()
        }
    }
}

private struct TeleopBackground: View {
    let state: TeleopConnectionState

    var body: some View {
        LinearGradient(
            colors: backgroundColors,
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
        .ignoresSafeArea()
        .animation(.easeInOut(duration: 0.35), value: state)
    }

    private var backgroundColors: [Color] {
        switch state {
        case .idle:
            return [Color(red: 0.05, green: 0.06, blue: 0.07), Color(red: 0.0, green: 0.09, blue: 0.08)]
        case .connecting:
            return [Color(red: 0.03, green: 0.07, blue: 0.10), Color(red: 0.0, green: 0.18, blue: 0.16)]
        case .live:
            return [Color(red: 0.02, green: 0.11, blue: 0.08), Color(red: 0.10, green: 0.16, blue: 0.07)]
        case .thinking:
            return [Color(red: 0.10, green: 0.09, blue: 0.02), Color(red: 0.16, green: 0.11, blue: 0.02)]
        case .fault:
            return [Color(red: 0.12, green: 0.03, blue: 0.04), Color(red: 0.04, green: 0.02, blue: 0.03)]
        }
    }
}

private struct TelemetryStrip: View {
    let sample: TelemetrySample
    let state: TeleopConnectionState

    var body: some View {
        HStack(spacing: 18) {
            GaugeGlyph(
                systemName: "point.3.connected.trianglepath.dotted",
                value: signalValue,
                tint: .mint
            )
            GaugeGlyph(systemName: "bolt.fill", value: sample.battery, tint: .yellow)
            GaugeGlyph(systemName: "waveform.path.ecg", value: motionValue, tint: .cyan)
        }
        .opacity(state == .idle ? 0.38 : 1)
        .animation(.easeInOut(duration: 0.25), value: state)
        .accessibilityLabel("Telemetry")
    }

    private var signalValue: Double {
        state == .idle ? 0.12 : sample.signal
    }

    private var motionValue: Double {
        state == .idle ? 0.08 : (sample.motion + 1.0) / 2.0
    }
}

private struct GaugeGlyph: View {
    let systemName: String
    let value: Double
    let tint: Color

    var body: some View {
        ZStack {
            Circle()
                .stroke(.white.opacity(0.12), lineWidth: 4)
            Circle()
                .trim(from: 0, to: max(0.05, min(1.0, value)))
                .stroke(tint, style: StrokeStyle(lineWidth: 4, lineCap: .round))
                .rotationEffect(.degrees(-90))
            Image(systemName: systemName)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(.white.opacity(0.86))
        }
        .frame(width: 48, height: 48)
        .animation(.smooth(duration: 0.18), value: value)
    }
}

private struct AgentCue: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.system(size: 13, weight: .medium, design: .rounded))
            .foregroundStyle(.white.opacity(0.82))
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(.white.opacity(0.10), in: Capsule())
            .accessibilityLabel(text)
    }
}

#Preview {
    TeleopHomeView()
        .frame(width: 390, height: 740)
}
