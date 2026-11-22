import SwiftUI

/// Category filter for the wardrobe grid. The server classifies every item
/// (`server/wardrobe-kind.ts`); this only maps a chip to that kind, the same
/// way `client/src/lib/wardrobe-filter.ts` does.
enum WardrobeFilter: String, CaseIterable, Identifiable {
    case all, tops, pants, skirts, shoes, accessories

    var id: String { rawValue }

    var label: LocalizedText {
        switch self {
        case .all: return Strings.wardrobeFilterAll
        case .tops: return Strings.wardrobeFilterTops
        case .pants: return Strings.wardrobeFilterPants
        case .skirts: return Strings.wardrobeFilterSkirts
        case .shoes: return Strings.wardrobeFilterShoes
        case .accessories: return Strings.wardrobeFilterAccessories
        }
    }

    /// The server-side kind each chip selects; nil for "all".
    private var kind: WardrobeKind? {
        switch self {
        case .all: return nil
        case .tops: return .top
        case .pants: return .pants
        case .skirts: return .skirt
        case .shoes: return .shoes
        case .accessories: return .accessory
        }
    }

    func apply(to items: [WardrobeItem]) -> [WardrobeItem] {
        guard let kind else { return items }
        return items.filter { $0.kind == kind }
    }
}

/// Filter chips plus the visible/total count.
struct WardrobeFilterBar: View {
    @Binding var selection: WardrobeFilter
    let visibleCount: Int
    let totalCount: Int

    @Environment(\.lang) private var lang

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.space1) {
            ScrollView(.horizontal) {
                HStack(spacing: Theme.space1) {
                    ForEach(WardrobeFilter.allCases) { filter in
                        Button {
                            selection = filter
                        } label: {
                            Text(filter.label(lang))
                                .font(Theme.bold(13))
                                .foregroundStyle(filter == selection ? Theme.white : Theme.text)
                                .padding(.horizontal, 12)
                                .padding(.vertical, 7)
                                .background(filter == selection ? Theme.blue : Theme.white)
                                .overlay(Rectangle().strokeBorder(Theme.black, lineWidth: Theme.hairline))
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(filter == selection ? [.isSelected, .isButton] : .isButton)
                    }
                }
                .padding(.vertical, 2)
            }
            .scrollIndicators(.hidden)
            .accessibilityLabel(Strings.wardrobeFilterAria(lang))

            Text(Strings.wardrobeFilterCount(lang, visible: visibleCount, total: totalCount))
                .font(Theme.bold(12))
                .foregroundStyle(Theme.textSecondary)
                .accessibilityAddTraits(.updatesFrequently)
        }
    }
}
