import SwiftUI
import UIKit

/// A wardrobe photo loaded through `APIClient`, so the request carries the
/// Authorization header. `AsyncImage` cannot send headers, and the old
/// workaround — the session token in the query string — leaked it into
/// server logs and URL caches.
struct AuthorizedPhoto: View {
    let itemId: String
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().aspectRatio(contentMode: .fill)
            } else {
                Theme.bg
            }
        }
        .task(id: itemId) {
            guard let data = try? await APIClient.shared.wardrobePhoto(id: itemId) else { return }
            image = UIImage(data: data)
        }
    }
}
