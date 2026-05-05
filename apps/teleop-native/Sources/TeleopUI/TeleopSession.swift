import Foundation
import SwiftUI

public enum TeleopConnectionState: Equatable, Sendable {
    case idle
    case connecting
    case live
    case thinking
    case fault
}

public struct TelemetrySample: Equatable, Sendable {
    public var latencyMS: Int
    public var signal: Double
    public var battery: Double
    public var motion: Double

    public static let empty = TelemetrySample(
        latencyMS: 0,
        signal: 0,
        battery: 1,
        motion: 0
    )
}

@MainActor
public final class TeleopSession: ObservableObject {
    @Published public private(set) var state: TeleopConnectionState = .idle
    @Published public private(set) var telemetry: TelemetrySample = .empty
    @Published public private(set) var agentSummary: String = ""

    private var telemetryTask: Task<Void, Never>?

    public init() {}

    public func pressPrimary() {
        switch state {
        case .idle, .fault:
            start()
        case .connecting:
            stop()
        case .live:
            interrupt()
        case .thinking:
            state = .live
            agentSummary = ""
        }
    }

    public func stop() {
        telemetryTask?.cancel()
        telemetryTask = nil
        telemetry = .empty
        agentSummary = ""
        state = .idle
    }

    private func start() {
        telemetryTask?.cancel()
        telemetry = .empty
        agentSummary = ""
        state = .connecting

        telemetryTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(320))
            guard !Task.isCancelled else { return }
            self?.becomeLive()
        }
    }

    private func becomeLive() {
        state = .live
        telemetryTask = Task { [weak self] in
            var tick = 0
            while !Task.isCancelled {
                let latency = 22 + Int.random(in: 0...18)
                let signal = Double.random(in: 0.72...0.98)
                let battery = Double.random(in: 0.68...0.96)
                let motion = sin(Double(tick) / 5.0)
                await MainActor.run {
                    self?.telemetry = TelemetrySample(
                        latencyMS: latency,
                        signal: signal,
                        battery: battery,
                        motion: motion
                    )
                }
                tick += 1
                try? await Task.sleep(for: .milliseconds(180))
            }
        }
    }

    private func interrupt() {
        state = .thinking
        agentSummary = "holding"

        Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(420))
            guard !Task.isCancelled else { return }
            await MainActor.run {
                self?.state = .live
                self?.agentSummary = ""
            }
        }
    }
}
