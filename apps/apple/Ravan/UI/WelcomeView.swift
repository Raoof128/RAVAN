import SwiftUI

struct CinemaWelcomeView: View {
    let openFile: () -> Void
    let openConnection: () -> Void
    let playSample: () -> Void
    let openReading: () -> Void
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        GeometryReader { geometry in
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    HStack {
                        CinemaWordmark()
                        Rectangle().fill(CinemaTheme.hairline).frame(height: 1).padding(.leading, 10)
                            .accessibilityHidden(true)
                    }
                    if geometry.size.width >= 780 && !typeSize.isAccessibilitySize {
                        HStack(spacing: 46) {
                            artwork(height: max(360, min(geometry.size.height - 175, 610)))
                            introduction.frame(maxWidth: 340)
                        }
                    } else {
                        artwork(height: typeSize.isAccessibilitySize ? 140 : max(175, min(geometry.size.height * 0.37, 375)))
                        introduction
                    }
                }
                .frame(maxWidth: 1100)
                .padding(.horizontal, geometry.size.width >= 780 ? 48 : 24)
                .padding(.vertical, 26)
                .frame(maxWidth: .infinity, minHeight: geometry.size.height, alignment: .center)
            }
        }
        .background(CinemaTheme.background)
    }

    private func artwork(height: CGFloat) -> some View {
        Rectangle().fill(CinemaTheme.panel)
            .frame(maxWidth: .infinity).frame(height: height)
            .overlay {
                Image("TideLandscape").resizable().scaledToFill()
            }
            .clipped()
            .overlay(alignment: .bottomLeading) {
                Text("Tide Almanac · Sample film")
                    .font(.footnote.weight(.medium)).foregroundStyle(.white)
                    .padding(.horizontal, 12).padding(.vertical, 7)
                    .background(.black.opacity(0.76), in: Capsule()).padding(14)
            }
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .accessibilityHidden(true)
    }

    private var introduction: some View {
        VStack(alignment: .leading, spacing: 11) {
            Text("Your private cinema")
                .font(CinemaTheme.filmFont(48, relativeTo: .largeTitle))
                .foregroundStyle(CinemaTheme.ink).fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            #if PAIRED
            Text("Open a film from Files, or connect to RAVĀN for your films and books.")
                .foregroundStyle(CinemaTheme.muted)
            #else
            Text("Open a film from Files and pick up where you left off.")
                .foregroundStyle(CinemaTheme.muted)
            #endif
            VStack(spacing: 10) {
                Button(action: openFile) { Label("Open a Film in Files", systemImage: "folder") }
                    .buttonStyle(CinemaPrimaryButtonStyle()).accessibilityIdentifier("welcome.files")
                #if PAIRED
                Button(action: openConnection) { Label("Connect to RAVĀN", systemImage: "link") }
                    .buttonStyle(CinemaSecondaryButtonStyle()).accessibilityIdentifier("welcome.connect")
                Button(action: openReading) { Label("Reading Room", systemImage: "book") }
                    .buttonStyle(CinemaSecondaryButtonStyle()).accessibilityIdentifier("welcome.reading")
                #endif
                Button(action: playSample) {
                    Label("Play Sample Film", systemImage: "play.fill")
                        .font(.subheadline.weight(.semibold)).frame(maxWidth: .infinity, minHeight: 44)
                }
                .foregroundStyle(CinemaTheme.accent).accessibilityIdentifier("welcome.sample")
                .accessibilityHint("Plays Tide Almanac with English and Persian captions.")
            }
            .padding(.top, 9)
        }
    }
}
