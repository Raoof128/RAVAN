import SwiftUI
import UIKit

/// The bar participates in the root's vertical layout. Its intrinsic height changes with
/// Dynamic Type, so the scroll viewport and tab controls always occupy separate regions.
struct CinemaTaskBar: View {
    let selection: CinemaDestination
    let select: (CinemaDestination) -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Namespace private var indicator
    @ScaledMetric(relativeTo: .caption) private var iconSize: CGFloat = 19

    var body: some View {
        HStack(alignment: .top, spacing: 2) {
            ForEach(CinemaDestination.allCases) { tab in
                let selected = tab == selection
                VStack(spacing: 4) {
                    ZStack {
                        Color.clear
                        if selected {
                            Capsule().fill(CinemaTheme.accent)
                                .matchedGeometryEffect(id: "active tab", in: indicator)
                        }
                    }
                    .frame(width: 25, height: 3)
                    .accessibilityHidden(true)

                    Image(systemName: tab.icon)
                        .symbolVariant(selected ? .fill : .none)
                        .font(.system(size: iconSize, weight: selected ? .semibold : .regular))
                        .scaleEffect(selected && !reduceMotion ? 1.06 : 1)
                        .accessibilityHidden(true)
                    Text(tab.title)
                        .font(.caption.weight(selected ? .bold : .medium))
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.vertical, 5)
                .padding(.horizontal, 2)
                .frame(maxWidth: .infinity, minHeight: 48)
                .foregroundStyle(selected ? CinemaTheme.accent : CinemaTheme.ink)
                .background(CinemaTheme.panel)
                .accessibilityHidden(true)
                .overlay {
                    CinemaTabButton(title: String(localized: tab.title), identifier: "destination." + tab.rawValue,
                                    selected: selected) { select(tab) }
                }
                .background {
                    Button(tab.title) { select(tab) }
                        .keyboardShortcut(tab.shortcut, modifiers: .command)
                        .hidden().accessibilityHidden(true)
                }
            }
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: selection)
        .padding(.horizontal, 8).padding(.bottom, 2)
        .fixedSize(horizontal: false, vertical: true)
        .overlay(alignment: .top) { Rectangle().fill(CinemaTheme.hairline).frame(height: 1).accessibilityHidden(true) }
        .background(CinemaTheme.panel.ignoresSafeArea(edges: .bottom))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("cinema.taskbar")
    }
}

// Keep one native control per destination. The artwork and the hardware shortcut
// should not become separately focusable children of the selected button.
private struct CinemaTabButton: UIViewRepresentable {
    let title: String
    let identifier: String
    let selected: Bool
    let activate: () -> Void

    func makeUIView(context: Context) -> UIButton {
        let button = UIButton(type: .custom)
        button.addTarget(context.coordinator, action: #selector(Coordinator.tap), for: .primaryActionTriggered)
        return button
    }

    func updateUIView(_ button: UIButton, context: Context) {
        context.coordinator.activate = activate
        button.accessibilityLabel = title
        button.accessibilityIdentifier = identifier
        button.accessibilityTraits = selected ? [.button, .selected] : .button
    }

    func makeCoordinator() -> Coordinator { Coordinator(activate) }

    @MainActor final class Coordinator: NSObject {
        var activate: () -> Void
        init(_ activate: @escaping () -> Void) { self.activate = activate }
        @objc func tap() { activate() }
    }
}
