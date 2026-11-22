import Foundation

/// One HTTP layer for the whole app. Every screen calls these methods and
/// renders what comes back — no business rules live on this side of the wire
/// (AGENTS.md §3). The paths match `client/src/api.ts` exactly.
actor APIClient {
    static let shared = APIClient()

    private let session: URLSession
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    init(session: URLSession = .shared) {
        self.session = session
    }

    // MARK: - Base URL

    /// Set in Info.plist (`SmartPackAPIBaseURL`) so the simulator, a LAN
    /// device, and a deployed backend can all be pointed at without a rebuild.
    nonisolated static var baseURL: URL {
        let configured = Bundle.main.object(forInfoDictionaryKey: "SmartPackAPIBaseURL") as? String
        let raw = (configured?.isEmpty == false ? configured! : "http://localhost:4177")
        return URL(string: raw) ?? URL(string: "http://localhost:4177")!
    }

    nonisolated static func url(_ path: String) -> URL {
        URL(string: path, relativeTo: baseURL) ?? baseURL
    }

    // MARK: - Request

    /// The API's error envelope: `{ "error": "…" }`.
    private struct ErrorBody: Decodable { let error: String? }

    struct APIError: LocalizedError {
        let message: String
        /// HTTP status, or nil when the server could not be reached at all.
        var status: Int? = nil
        var errorDescription: String? { message }
        /// The stored session is no longer valid; signing in again is the fix.
        var isUnauthorized: Bool { status == 401 }
        /// Offline, timed out, or the backend is still waking up.
        var isUnreachable: Bool { status == nil }
    }

    /// Posted when a request made with a session token comes back 401, so the
    /// app returns to sign-in instead of every screen failing on its own.
    nonisolated static let sessionExpired = Notification.Name("WearRouteSessionExpired")

    private func request<T: Decodable>(
        _ path: String,
        method: String = "GET",
        body: Data? = nil
    ) async throws -> T {
        var req = URLRequest(url: Self.url(path))
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let token = TokenStore.token
        if let token {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        req.httpBody = body

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            // A dead backend otherwise surfaces as a bare "cancelled" or
            // "could not connect", which reads like a bug in this app.
            throw APIError(message: Strings.backendUnreachable(path, error.localizedDescription))
        }

        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            if status == 401, token != nil {
                NotificationCenter.default.post(name: Self.sessionExpired, object: nil)
            }
            let detail = (try? decoder.decode(ErrorBody.self, from: data))?.error
            throw APIError(message: detail ?? "Request failed (\(status))", status: status)
        }
        return try decoder.decode(T.self, from: data)
    }

    /// Photo bytes, fetched with the Authorization header like every other call.
    func wardrobePhoto(id: String) async throws -> Data {
        var req = URLRequest(url: Self.url("/api/wardrobe/photo/\(query(id))"))
        if let token = TokenStore.token {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let (data, response) = try await session.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else { throw APIError(message: "Photo unavailable", status: status) }
        return data
    }

    private func send<T: Decodable, Body: Encodable>(
        _ path: String,
        method: String,
        _ payload: Body
    ) async throws -> T {
        try await request(path, method: method, body: try encoder.encode(payload))
    }

    private func query(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlQueryValueAllowed) ?? value
    }

    // MARK: - Auth

    struct OK: Decodable { let ok: Bool? }

    func login(email: String, password: String) async throws -> AuthResponse {
        try await send("/api/login", method: "POST", ["email": email, "password": password])
    }

    func checkEmail(_ email: String) async throws -> OK {
        try await send("/api/check-email", method: "POST", ["email": email])
    }

    func register(credentials: Credentials, profile: Profile) async throws -> AuthResponse {
        var payload = profile
        payload["email"] = .text(credentials.email)
        payload["password"] = .text(credentials.password)
        return try await send("/api/register", method: "POST", payload)
    }

    func me() async throws -> UserResponse {
        try await request("/api/me")
    }

    func logout() async throws -> OK {
        try await request("/api/logout", method: "POST")
    }

    func profileOptions() async throws -> ProfileFieldsResponse {
        try await request("/api/profile-options")
    }

    func updateProfile(_ profile: Profile) async throws -> UserResponse {
        try await send("/api/profile", method: "PUT", profile)
    }

    func analyzePersonalColor(imageDataURL: String) async throws -> PersonalColorResponse {
        try await send("/api/personal-color/analyze", method: "POST", ["image": imageDataURL])
    }

    // MARK: - Catalog

    func scenarios() async throws -> ScenariosResponse {
        try await request("/api/scenarios")
    }

    /// Without coordinates the server answers for its default city.
    func weather(lat: Double? = nil, lon: Double? = nil) async throws -> Weather {
        guard let lat, let lon else { return try await request("/api/weather") }
        return try await request("/api/weather?lat=\(lat)&lon=\(lon)")
    }

    // MARK: - Wardrobe

    func wardrobeItems() async throws -> WardrobeItemsResponse {
        try await request("/api/wardrobe/items")
    }

    func recognizeClothing(imageDataURL: String) async throws -> RecognizeResponse {
        try await send("/api/wardrobe/recognize", method: "POST", ["image": imageDataURL])
    }

    func deleteWardrobeItem(id: String) async throws -> OK {
        try await request("/api/wardrobe/items/\(query(id))", method: "DELETE")
    }

    // MARK: - Assistant

    func chat(messages: [ChatMessage]) async throws -> ChatResponse {
        try await send("/api/chat", method: "POST", ["messages": messages])
    }

    // MARK: - Trip plans

    func searchPlaces(_ text: String, lang: Lang) async throws -> PlacesResponse {
        try await request("/api/places?q=\(query(text))&lang=\(lang.rawValue)")
    }

    func generateTripPlan(_ plan: NewTripPlan) async throws -> TripPlanResponse {
        try await send("/api/trip-plans/generate", method: "POST", plan)
    }

    func tripPlan(id: String) async throws -> TripPlanResponse {
        try await request("/api/trip-plans/\(query(id))")
    }

    func tripPlans() async throws -> TripPlansResponse {
        try await request("/api/trip-plans")
    }

    func tripWeather(id: String) async throws -> TripWeatherResponse {
        try await request("/api/trip-plans/\(query(id))/weather")
    }

    func deleteTripPlan(id: String) async throws -> OK {
        try await request("/api/trip-plans/\(query(id))", method: "DELETE")
    }

    // MARK: - Itinerary

    func itineraryTrips(scenario: String?) async throws -> TripsResponse {
        let suffix = scenario.map { "?scenario=\(query($0))" } ?? ""
        return try await request("/api/itinerary/trips\(suffix)")
    }

    func itineraryTrip(id: String) async throws -> SingleTripResponse {
        try await request("/api/itinerary/trips/\(query(id))")
    }

    func stopPhoto(stopId: String) async throws -> StopPhotoResponse {
        try await request("/api/itinerary/photo/\(query(stopId))")
    }

    // MARK: - Packing and outfits

    /// balance: 0 = pack lightest, 100 = most outfit variety.
    func packingPlan(balance: Double, tripPlanId: String) async throws -> PackingPlanResponse {
        try await request("/api/packing?balance=\(Int(balance))&tripPlanId=\(query(tripPlanId))")
    }

    private struct PackingCheckBody: Encodable {
        let tripPlanId: String
        let itemId: String
        let checked: Bool
        let balance: Double
    }

    /// Ticks are stored per trip on the server; the reply is the refreshed plan.
    func setPackingCheck(tripPlanId: String, itemId: String, checked: Bool, balance: Double) async throws -> PackingPlanResponse {
        try await send(
            "/api/packing/checks",
            method: "PUT",
            PackingCheckBody(tripPlanId: tripPlanId, itemId: itemId, checked: checked, balance: balance)
        )
    }

    /// Sends the device's calendar day so "today" never falls back to UTC.
    func outfitPlan(tripPlanId: String?) async throws -> OutfitPlanResponse {
        let trip = tripPlanId.map { "&tripPlanId=\(query($0))" } ?? ""
        return try await request("/api/outfit-plan?today=\(TripDate.todayISO)\(trip)")
    }
}

private extension CharacterSet {
    /// `urlQueryAllowed` still permits `&`, `?` and `+`, which corrupt values.
    static let urlQueryValueAllowed = CharacterSet.urlQueryAllowed
        .subtracting(CharacterSet(charactersIn: "&?+=/"))
}
