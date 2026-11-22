import SwiftUI

/// Shown at launch when a session is stored but the backend cannot be
/// reached. The session is kept, so a retry continues where the user left off.
struct UnreachableView: View {
    let retry: () async -> Void
    @Environment(\.lang) private var lang
    @State private var retrying = false

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.space2) {
            Rectangle()
                .fill(Theme.red)
                .frame(width: 48, height: 48)
                .accessibilityHidden(true)
            Text(Strings.unreachableTitle(lang))
                .font(Theme.heavy(26))
                .foregroundStyle(Theme.text)
                .accessibilityAddTraits(.isHeader)
            Text(Strings.unreachableBody(lang))
                .font(Theme.bold(15))
                .foregroundStyle(Theme.textSecondary)
            Button {
                Task {
                    retrying = true
                    await retry()
                    retrying = false
                }
            } label: {
                Text(Strings.unreachableRetry(lang))
            }
            .buttonStyle(PrimaryButtonStyle(enabled: !retrying))
            .disabled(retrying)
        }
        .padding(Theme.space3)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .background(Theme.bg.ignoresSafeArea())
    }
}
