# Teleop Native

Native SwiftUI prototype for low-latency voice teleoperation on macOS and iOS.

## OpenUI Result Summary

- First screen is the control surface, not a landing page.
- One primary animated voice button drives the interaction.
- Visible text is limited to a tiny transient agent cue.
- Telemetry is icon-first: signal, power, and motion are visual gauges.
- Voice/chat owns intent. The button starts, interrupts, resumes, or reconnects.
- WebRTC/media plumbing is intentionally a future integration layer behind the current `TeleopSession` state object.

## Architecture Target

`Mobile or macOS app -> WebRTC session -> global relay -> transceiver -> realtime agent -> teleop gateway -> device`

The app should keep hard safety controls local to the device gateway. The model can interpret intent, but stop limits and degraded-network behavior should not depend on a cloud round trip.

## Run Mac Prototype

```bash
cd apps/teleop-native
swift run TeleopMac
```

## iOS

Open `apps/teleop-native/Package.swift` in Xcode and use `TeleopUI` from a new iOS app target. The shared SwiftUI view is `TeleopHomeView`.
