import SwiftUI
import UIKit

enum CinemaTheme {
    static let background = adaptive(light: 0xf7f4ed, dark: 0x101313)
    static let panel = adaptive(light: 0xeeeae2, dark: 0x191d1c)
    static let ink = adaptive(light: 0x182322, dark: 0xf3f0e8)
    static let muted = adaptive(light: 0x4e5b56, dark: 0xaab3af, highLight: 0x263c34, highDark: 0xe2e8e3)
    static let accent = adaptive(light: 0x933d26, dark: 0xf18c70, highLight: 0x79301f, highDark: 0xffb398)
    static let buttonFill = Color(red: 0.95, green: 0.57, blue: 0.45)
    static let onAccent = Color(red: 0.10, green: 0.08, blue: 0.07)
    static let hairline = adaptive(light: 0xd1cec5, dark: 0x3b4542, highLight: 0x737b75, highDark: 0x929e99)

    static func filmFont(_ size: CGFloat, relativeTo style: Font.TextStyle = .title) -> Font {
        .custom("CormorantGaramond-Regular", size: size, relativeTo: style)
    }

    private static func adaptive(light: Int, dark: Int, highLight: Int? = nil, highDark: Int? = nil) -> Color {
        Color(uiColor: UIColor { traits in
            let high = traits.accessibilityContrast == .high
            let hex = traits.userInterfaceStyle == .dark ? (high ? highDark ?? dark : dark) : (high ? highLight ?? light : light)
            return UIColor(red: CGFloat(hex >> 16) / 255, green: CGFloat((hex >> 8) & 255) / 255,
                           blue: CGFloat(hex & 255) / 255, alpha: 1)
        })
    }
}

struct CinemaPrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 16).padding(.vertical, 13)
            .frame(maxWidth: .infinity, minHeight: 50)
            .foregroundStyle(isEnabled ? CinemaTheme.onAccent : CinemaTheme.muted)
            .background {
                RoundedRectangle(cornerRadius: 10).fill(isEnabled ? CinemaTheme.buttonFill : CinemaTheme.panel)
                    .brightness(configuration.isPressed ? -0.08 : 0)
            }
            .contentShape(.rect)
    }
}

struct CinemaSecondaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 16).padding(.vertical, 13)
            .frame(maxWidth: .infinity, minHeight: 50)
            .foregroundStyle(isEnabled ? CinemaTheme.ink : CinemaTheme.muted)
            .background(CinemaTheme.panel.opacity(configuration.isPressed ? 1 : 0.3), in: RoundedRectangle(cornerRadius: 10))
            .overlay { RoundedRectangle(cornerRadius: 10).strokeBorder(CinemaTheme.hairline) }
            .contentShape(.rect)
    }
}

struct CinemaWordmark: View {
    @ScaledMetric(relativeTo: .title2) private var markSize: CGFloat = 34
    var body: some View {
        HStack(spacing: 8) {
            Image(decorative: "RavanMark").resizable().scaledToFit()
                .frame(width: markSize, height: markSize)
            // Use the same single-line brand artwork at every text size and in both appearances.
            Image(decorative: "RavanWord").resizable().renderingMode(.template).scaledToFit()
                .foregroundStyle(CinemaTheme.ink)
                .frame(maxWidth: markSize * 3.5, maxHeight: markSize * 0.76)
        }
        .fixedSize(horizontal: false, vertical: true)
        .layoutPriority(1)
        .accessibilityElement(children: .ignore).accessibilityLabel("Ravān")
    }
}

struct CinemaSectionTitle: View {
    let text: LocalizedStringKey
    var body: some View {
        Text(text).font(.headline).foregroundStyle(CinemaTheme.ink)
            .accessibilityAddTraits(.isHeader)
    }
}

enum CinemaTime {
    static func stamp(_ seconds: Double) -> String {
        guard seconds.isFinite, seconds >= 0, seconds < Double(Int.max) else { return "0:00" }
        let whole = Int(seconds)
        if whole >= 3600 {
            return String(format: "%d:%02d:%02d", whole / 3600, (whole / 60) % 60, whole % 60)
        }
        return String(format: "%d:%02d", whole / 60, whole % 60)
    }
}

/// Fixed geometry makes a quiet title poster even before a file has artwork.
struct CinemaPoster: View {
    let title: String
    let isSample: Bool
    var wide = false
    var aspectRatio: CGFloat?

    var body: some View {
        Rectangle().fill(Color(red: 0.09, green: 0.17, blue: 0.17))
            .aspectRatio(aspectRatio ?? (wide ? 1.85 : 0.72), contentMode: .fit)
            .overlay {
                if isSample {
                    Image(wide ? "TideLandscape" : "TidePoster")
                        .resizable().scaledToFill()
                } else {
                    Canvas { context, size in
                        let stride = size.height / 25
                        for index in 0..<18 {
                            let y = size.height * 0.25 + CGFloat(index) * stride
                            var path = Path()
                            path.move(to: CGPoint(x: -1, y: y))
                            path.addCurve(to: CGPoint(x: size.width + 1, y: y - size.height * 0.22),
                                          control1: CGPoint(x: size.width * 0.38, y: y - size.height * 0.28),
                                          control2: CGPoint(x: size.width * 0.73, y: y + size.height * 0.15))
                            context.stroke(path, with: .color(.white.opacity(0.14)), lineWidth: 0.7)
                        }
                    }
                    LinearGradient(colors: [.clear, .black.opacity(0.68)], startPoint: .top, endPoint: .bottom)
                    VStack(alignment: .leading, spacing: 9) {
                        Spacer()
                        Rectangle().fill(CinemaTheme.buttonFill).frame(width: 24, height: 2)
                        Text(verbatim: title).font(CinemaTheme.filmFont(wide ? 39 : 25, relativeTo: .title2))
                            .lineLimit(3).foregroundStyle(.white)
                    }
                    .padding(wide ? 22 : 13)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
                }
            }
            .clipped().clipShape(RoundedRectangle(cornerRadius: 8))
            .accessibilityHidden(true)
    }
}
