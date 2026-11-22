import Foundation

/// Packing screen state. Every packing rule lives on the server (AGENTS.md
/// §3): this only holds the slider value and whatever plan came back. Ticked
/// items are part of that plan, stored per trip on the server.
@Observable
@MainActor
final class PackingModel {
    private static let balanceKey = "smartpack_packing_balance"

    /// 0 = pack lightest · 100 = most outfit variety.
    var balance: Double {
        didSet { UserDefaults.standard.set(balance, forKey: Self.balanceKey) }
    }

    private(set) var plan: PackingPlan?
    private(set) var loading = true
    private(set) var error: String?

    private let tripPlanId: String
    private var reloadTask: Task<Void, Never>?

    init(tripPlanId: String) {
        self.tripPlanId = tripPlanId
        let stored = UserDefaults.standard.object(forKey: Self.balanceKey) as? Double
        balance = stored ?? 50
    }

    /// Progress is computed by the server over the items currently shown, so
    /// ticks from another trip or a hidden row never inflate it.
    var packedCount: Int { plan?.packedCount ?? 0 }
    var totalItems: Int { plan?.totalCount ?? 0 }

    func isChecked(_ id: String) -> Bool { plan?.checked.contains(id) ?? false }

    func toggle(_ id: String) {
        reloadTask?.cancel()
        let requested = balance
        let checked = !isChecked(id)
        reloadTask = Task {
            do {
                plan = try await APIClient.shared.setPackingCheck(
                    tripPlanId: tripPlanId, itemId: id, checked: checked, balance: requested
                ).plan
                error = nil
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled else { return }
                self.error = error.localizedDescription
            }
        }
    }

    /// Debounces the slider so dragging does not fire a request per pixel.
    /// The task is replaced on every change, so only the last value is fetched.
    func reload(debounce: Bool) {
        reloadTask?.cancel()
        let requested = balance
        reloadTask = Task {
            if debounce {
                try? await Task.sleep(for: .milliseconds(250))
                guard !Task.isCancelled else { return }
            }
            loading = true
            defer { loading = false }
            do {
                plan = try await APIClient.shared.packingPlan(balance: requested, tripPlanId: tripPlanId).plan
                error = nil
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled else { return }
                self.error = error.localizedDescription
            }
        }
    }
}
