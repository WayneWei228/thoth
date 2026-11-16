import Foundation

/// The app's bundle id was a person-named id before (product contract P1). A new bundle id means a
/// new UserDefaults domain, so the first launch under the new id copies the old domain once
/// (drafts, view modes, window frames). The old domain is only read, never changed.
/// The old id comes from Info.plist (`CCPanelLegacyDefaults`, written by macos/build-app.sh);
/// an app without the key (a verify instance) migrates nothing.
/// Not migrated (macOS ties these to the bundle id): notification permission, privacy permissions.
enum LegacyDefaults {
    static let doneKey = "CCPanelLegacyDefaultsMigrated"

    /// Copies the keys the new domain does not have yet. Returns the number of keys copied.
    @discardableResult
    static func migrate() -> Int {
        let d = UserDefaults.standard
        guard let own = Bundle.main.bundleIdentifier,
              let legacy = Bundle.main.object(forInfoDictionaryKey: "CCPanelLegacyDefaults") as? String,
              !legacy.isEmpty, legacy != own, !d.bool(forKey: doneKey) else { return 0 }
        let old = d.persistentDomain(forName: legacy) ?? [:]
        let mine = d.persistentDomain(forName: own) ?? [:]
        var copied = 0
        for (key, value) in old where mine[key] == nil {
            d.set(value, forKey: key)
            copied += 1
        }
        d.set(true, forKey: doneKey)
        return copied
    }
}
