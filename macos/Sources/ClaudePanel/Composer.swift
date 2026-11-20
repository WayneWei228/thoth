import AppKit
import UniformTypeIdentifiers
import QuickLookThumbnailing

/// Where pasted and dropped images are stored. Their paths go into the message;
/// Claude Code reads image files by path, and the chat view shows files from here.
enum Attachments {
    static let dir: URL = {
        let u = URL(fileURLWithPath: Instance.home).appendingPathComponent("attachments")
        try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true)
        return u
    }()
    static let imageExts: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "heic"]
    /// Documents Claude Code can read by path (same list as the server's ATTACH_EXT).
    static let docExts: Set<String> = ["pdf", "txt", "md", "csv", "tsv", "json", "yaml", "yml", "xml", "html", "htm", "log", "ipynb",
                                       "py", "js", "ts", "swift", "java", "go", "rs", "c", "cpp", "h", "rb", "sh", "sql"]
    static var allExts: Set<String> { imageExts.union(docExts) }
    static func isImage(_ u: URL) -> Bool { imageExts.contains(u.pathExtension.lowercased()) }

    static func newURL(ext: String) -> URL {
        dir.appendingPathComponent("\(Int(Date().timeIntervalSince1970 * 1000))-\(UUID().uuidString.prefix(6)).\(ext)")
    }

    /// Copy an image or document into the attachments folder (the original is not
    /// touched). The copy keeps the file name, so Claude and the chat show it.
    static func importFile(_ url: URL) -> URL? {
        let ext = url.pathExtension.lowercased()
        guard allExts.contains(ext) else { return nil }
        let safe = url.deletingPathExtension().lastPathComponent
            .replacingOccurrences(of: "[^A-Za-z0-9._-]+", with: "-", options: .regularExpression).prefix(60)
        let dst = imageExts.contains(ext) ? newURL(ext: ext)
            : dir.appendingPathComponent("\(Int(Date().timeIntervalSince1970 * 1000))-\(safe).\(ext)")
        do { try FileManager.default.copyItem(at: url, to: dst); return dst } catch { return nil }
    }

    /// Save raw image data (a screenshot on the pasteboard) as PNG.
    static func importImage(_ image: NSImage) -> URL? {
        guard let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:]) else { return nil }
        let dst = newURL(ext: "png")
        do { try png.write(to: dst); return dst } catch { return nil }
    }

    /// Attachments on a pasteboard, following the Claude app's rule: files are
    /// attached; image data is attached when there is no text to paste.
    static func images(from pb: NSPasteboard) -> [URL] {
        if let urls = pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] {
            let files = urls.filter { allExts.contains($0.pathExtension.lowercased()) }
            if !files.isEmpty { return files.compactMap(importFile) }
        }
        let hasText = (pb.string(forType: .string)?.isEmpty == false)
        if !hasText, pb.canReadObject(forClasses: [NSImage.self], options: nil),
           let img = (pb.readObjects(forClasses: [NSImage.self], options: nil) as? [NSImage])?.first {
            return [importImage(img)].compactMap { $0 }
        }
        return []
    }
}

/// Text view where Enter sends and Shift+Enter adds a new line. Shows a placeholder.
/// Pasting an image attaches it instead of inserting text.
final class ComposerTextView: NSTextView {
    var onSubmit: (() -> Void)?
    var onImages: (([URL]) -> Void)?
    /// Sees each key first; true = the key is used (the command list under the Ask box: CommandMenu.swift).
    var onKey: ((NSEvent) -> Bool)?
    var placeholder = "" { didSet { needsDisplay = true; setAccessibilityPlaceholderValue(placeholder) } }

    override func keyDown(with event: NSEvent) {
        // not while an input method composes text (Chinese): its Enter and arrows belong to it
        if !hasMarkedText(), onKey?(event) == true { return }
        let isReturn = event.keyCode == 36 || event.keyCode == 76
        if isReturn && !event.modifierFlags.contains(.shift) && !hasMarkedText() {
            onSubmit?()
            return
        }
        super.keyDown(with: event)
    }

    // A plain-text view only accepts string types, so AppKit disables Paste
    // when the pasteboard holds an image. Declaring image types keeps Paste
    // enabled; paste(_:) then turns images into attachments.
    override var readablePasteboardTypes: [NSPasteboard.PasteboardType] {
        super.readablePasteboardTypes + [.png, .tiff, .fileURL]
    }

    override func paste(_ sender: Any?) {
        let imgs = Attachments.images(from: Instance.pasteboard)
        if !imgs.isEmpty { onImages?(imgs); return }
        if Instance.background {   // the instance's own pasteboard, not the system one
            if let s = Instance.pasteboard.string(forType: .string) { insertText(s, replacementRange: selectedRange()) }
            return
        }
        pasteAsPlainText(sender)
    }

    // Images dropped on the text area become attachments, not text.
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let imgs = Attachments.images(from: sender.draggingPasteboard)
        if !imgs.isEmpty { onImages?(imgs); return true }
        return super.performDragOperation(sender)
    }

    override func didChangeText() {
        super.didChangeText()
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        if string.isEmpty && !placeholder.isEmpty {
            let attrs: [NSAttributedString.Key: Any] = [.font: font ?? .systemFont(ofSize: 15), .foregroundColor: NSColor.placeholderTextColor]
            (placeholder as NSString).draw(at: NSPoint(x: textContainerInset.width + 5, y: textContainerInset.height), withAttributes: attrs)
        }
    }
}

/// One attached image: thumbnail, file name, remove button (like the Claude app's chip).
final class AttachmentChip: NSView {
    let url: URL
    init(url: URL, index: Int, idPrefix: String, onRemove: @escaping () -> Void, onPreview: @escaping () -> Void) {
        self.url = url
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = 8
        layer?.borderWidth = 1
        translatesAutoresizingMaskIntoConstraints = false
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("Attachment \(url.lastPathComponent)")
        setAccessibilityIdentifier("\(idPrefix).attachment.\(index)")

        let picture = Attachments.isImage(url) ? NSImage(contentsOf: url) : NSWorkspace.shared.icon(forFile: url.path)
        let img = NSImageView(image: picture ?? Theme.icon("doc", nil)!)
        if !Attachments.isImage(url) {
            // documents: a sharp first-page thumbnail (Quick Look, at the screen's scale)
            let scale = NSScreen.main?.backingScaleFactor ?? 2
            let req = QLThumbnailGenerator.Request(fileAt: url, size: CGSize(width: 34, height: 34), scale: scale, representationTypes: .thumbnail)
            QLThumbnailGenerator.shared.generateBestRepresentation(for: req) { rep, _ in
                guard let rep else { return }
                DispatchQueue.main.async { img.image = rep.nsImage }
            }
        }
        img.imageScaling = .scaleProportionallyUpOrDown
        img.wantsLayer = true
        img.layer?.cornerRadius = 5
        img.layer?.masksToBounds = true
        img.translatesAutoresizingMaskIntoConstraints = false
        let preview = ActionButton("", symbol: nil) { onPreview() }
        preview.isBordered = false
        preview.translatesAutoresizingMaskIntoConstraints = false
        preview.toolTip = "Preview"
        // copies are named "<millis>-<original>"; show the original name
        let shown = url.lastPathComponent.replacingOccurrences(of: "^[0-9]{10,}-", with: "", options: .regularExpression)
        let name = label(shown, size: 11, color: .secondaryLabelColor)
        let remove = ActionButton("", symbol: "xmark") { onRemove() }
        remove.isBordered = false
        remove.toolTip = "Remove image"
        remove.setAccessibilityLabel("Remove image")
        remove.setAccessibilityIdentifier("\(idPrefix).attachment.\(index).remove")
        [img, preview, name, remove].forEach { addSubview($0) }
        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: 44),
            widthAnchor.constraint(lessThanOrEqualToConstant: 220),
            img.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 5),
            img.centerYAnchor.constraint(equalTo: centerYAnchor),
            img.widthAnchor.constraint(equalToConstant: 34), img.heightAnchor.constraint(equalToConstant: 34),
            preview.leadingAnchor.constraint(equalTo: img.leadingAnchor), preview.trailingAnchor.constraint(equalTo: img.trailingAnchor),
            preview.topAnchor.constraint(equalTo: img.topAnchor), preview.bottomAnchor.constraint(equalTo: img.bottomAnchor),
            name.leadingAnchor.constraint(equalTo: img.trailingAnchor, constant: 7),
            name.centerYAnchor.constraint(equalTo: centerYAnchor),
            name.widthAnchor.constraint(lessThanOrEqualToConstant: 140),
            remove.leadingAnchor.constraint(equalTo: name.trailingAnchor, constant: 4),
            remove.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -6),
            remove.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }
    required init?(coder: NSCoder) { fatalError() }
    override func viewDidChangeEffectiveAppearance() { refresh() }
    override func viewDidMoveToWindow() { refresh() }
    private func refresh() {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            layer?.borderColor = (Theme.web ? Theme.ink : NSColor.separatorColor).cgColor
            layer?.backgroundColor = Theme.paper.cgColor
        }
    }
}

/// A rounded input box: attachments strip, growing text view, attach and send buttons.
/// Accepts pasted and dropped images; keeps a draft per `draftKey`.
final class ComposerBox: NSView {
    let text = ComposerTextView()
    let scroll = NSScrollView()
    let send: ActionButton
    let attach: ActionButton
    private let strip = NSStackView()
    private var heightC: NSLayoutConstraint!
    private(set) var attachments: [URL] = []
    var minHeight: CGFloat = 60
    var maxHeight: CGFloat = 220
    private let idPrefix: String
    /// Asked before a send; true = do not send and keep the text (a command waits for its session).
    var interceptSend: ((String, [String]) -> Bool)?
    private var submitAction: (() -> Void)?
    private var dragging = false { didSet { refreshColors() } }
    private var draftWork: DispatchWorkItem?
    var draftKey: String? { didSet { if !withoutLoad { loadDraft() } } }

    init(placeholder: String, fontSize: CGFloat = 15, idPrefix: String, onSend: @escaping (String, [String]) -> Void) {
        self.idPrefix = idPrefix
        send = ActionButton("", symbol: "arrow.up", prominent: true) {}
        attach = ActionButton("", symbol: "paperclip") {}
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = 16
        layer?.borderWidth = 1
        translatesAutoresizingMaskIntoConstraints = false
        registerForDraggedTypes([.fileURL, .png, .tiff])

        text.font = .systemFont(ofSize: fontSize)
        text.placeholder = placeholder
        text.isRichText = false
        text.allowsUndo = true
        text.drawsBackground = false
        text.textContainerInset = NSSize(width: 8, height: 10)
        text.isVerticallyResizable = true
        text.isHorizontallyResizable = false
        text.autoresizingMask = [.width]
        text.textContainer?.widthTracksTextView = true
        text.isAutomaticQuoteSubstitutionEnabled = false
        text.isAutomaticDashSubstitutionEnabled = false
        text.setAccessibilityIdentifier("\(idPrefix).input")
        scroll.documentView = text
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.borderType = .noBorder
        scroll.translatesAutoresizingMaskIntoConstraints = false

        strip.orientation = .horizontal
        strip.spacing = 6
        strip.alignment = .centerY
        strip.translatesAutoresizingMaskIntoConstraints = false
        strip.isHidden = true

        send.bezelStyle = .circular
        send.toolTip = "Send (Enter)"
        send.setAccessibilityIdentifier("\(idPrefix).send")
        attach.isBordered = false
        attach.toolTip = "Attach images or files (or paste / drop them here)"
        attach.setAccessibilityLabel("Attach files")
        attach.setAccessibilityIdentifier("\(idPrefix).attach")

        [strip, scroll, attach, send].forEach { addSubview($0) }
        heightC = scroll.heightAnchor.constraint(equalToConstant: minHeight)
        NSLayoutConstraint.activate([
            strip.topAnchor.constraint(equalTo: topAnchor, constant: 8),
            strip.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            strip.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -12),
            scroll.topAnchor.constraint(equalTo: strip.bottomAnchor, constant: 2),
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            scroll.trailingAnchor.constraint(equalTo: send.leadingAnchor, constant: -6),
            scroll.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -6),
            heightC,
            send.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            send.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -10),
            attach.trailingAnchor.constraint(equalTo: send.leadingAnchor, constant: -4),
            attach.centerYAnchor.constraint(equalTo: send.centerYAnchor),
        ])
        stripHeight = strip.heightAnchor.constraint(equalToConstant: 0)
        stripHeight.isActive = true

        let submit = { [weak self] in
            guard let self else { return }
            let t = self.text.string.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !t.isEmpty || !self.attachments.isEmpty else { return }
            if self.interceptSend?(t, self.attachments.map(\.path)) == true { return }
            onSend(t, self.attachments.map(\.path))
            self.clear()
        }
        submitAction = submit
        text.onSubmit = submit
        send.handler = submit
        text.onImages = { [weak self] urls in self?.add(urls) }
        attach.handler = { [weak self] in self?.pickImages() }
        NotificationCenter.default.addObserver(forName: NSText.didChangeNotification, object: text, queue: .main) { [weak self] _ in
            self?.fit(); self?.scheduleDraft()
        }
        refreshColors()
    }
    required init?(coder: NSCoder) { fatalError() }
    private var stripHeight: NSLayoutConstraint!

    // MARK: attachments

    func add(_ urls: [URL]) { setAttachments(attachments + urls) }

    /// Send what is in the box (as Enter does).
    func submit() { submitAction?() }

    /// Empty the box after its text was sent.
    func clear() {
        text.string = ""
        setAttachments([])
        saveDraftNow()
        fit()
    }

    /// Replace the text (a command picked from the list); the cursor goes to the end.
    func setText(_ t: String) {
        text.string = t
        text.setSelectedRange(NSRange(location: (t as NSString).length, length: 0))
        text.needsDisplay = true
        saveDraftNow()
        fit()
    }

    /// Put text and files back in the box (a request that failed), unless the user typed something new.
    func setDraft(_ t: String, files: [URL]) {
        guard text.string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        text.string = t
        setAttachments(files.filter { FileManager.default.fileExists(atPath: $0.path) })
        saveDraftNow()
        fit()
    }

    private func setAttachments(_ urls: [URL]) {
        attachments = urls
        strip.arrangedSubviews.forEach { $0.removeFromSuperview() }
        for (i, u) in urls.enumerated() {
            let chip = AttachmentChip(url: u, index: i + 1, idPrefix: idPrefix,
                                      onRemove: { [weak self] in self?.setAttachments((self?.attachments ?? []).filter { $0 != u }) },
                                      onPreview: { NSWorkspace.shared.open(u) })
            strip.addArrangedSubview(chip)
        }
        strip.isHidden = urls.isEmpty
        stripHeight.constant = urls.isEmpty ? 0 : 44
        scheduleDraft()
        window?.makeFirstResponder(text)
    }

    private func pickImages() {
        let p = NSOpenPanel()
        p.allowsMultipleSelection = true
        p.canChooseDirectories = false
        p.allowedContentTypes = Attachments.allExts.compactMap { UTType(filenameExtension: $0) }
        p.prompt = "Attach"
        guard let w = window else { return }
        p.beginSheetModal(for: w) { [weak self] r in
            guard r == .OK else { return }
            self?.add(p.urls.compactMap(Attachments.importFile))
        }
    }

    // MARK: drag and drop

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        let ok = sender.draggingPasteboard.canReadObject(forClasses: [NSURL.self, NSImage.self], options: nil)
        dragging = ok
        return ok ? .copy : []
    }
    override func draggingExited(_ sender: NSDraggingInfo?) { dragging = false }
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        dragging = false
        let imgs = Attachments.images(from: sender.draggingPasteboard)
        add(imgs)
        return !imgs.isEmpty
    }

    // MARK: drafts (like the Claude app: saved 400 ms after typing stops)

    private func scheduleDraft() {
        draftWork?.cancel()
        let w = DispatchWorkItem { [weak self] in self?.saveDraftNow() }
        draftWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4, execute: w)
    }
    // Text and attached files are both kept, so a crash or a force quit loses neither.
    private func saveDraftNow() {
        guard let k = draftKey else { return }
        let d = UserDefaults.standard
        let t = text.string
        if t.isEmpty { d.removeObject(forKey: "draft.\(k)") } else { d.set(t, forKey: "draft.\(k)") }
        if attachments.isEmpty { d.removeObject(forKey: "draftFiles.\(k)") } else { d.set(attachments.map(\.path), forKey: "draftFiles.\(k)") }
    }
    private func loadDraft() {
        guard let k = draftKey else { return }
        text.string = UserDefaults.standard.string(forKey: "draft.\(k)") ?? ""
        let files = (UserDefaults.standard.stringArray(forKey: "draftFiles.\(k)") ?? [])
            .filter { FileManager.default.fileExists(atPath: $0) }.map { URL(fileURLWithPath: $0) }
        setAttachments(files)
        fit()
    }
    /// Keep the draft that is in the box under a new key (the session got its transcript id).
    func moveDraft(to key: String) {
        guard let old = draftKey, old != key else { return }
        draftWork?.cancel()
        // an empty box (opened before the server state came): show the draft saved under the new key
        if text.string.isEmpty && attachments.isEmpty { draftKey = key; return }
        // the session already has a saved draft (a restore): it wins over the text shown under the
        // window id, which may be an old draft of another conversation that had the same id
        let d = UserDefaults.standard
        if d.string(forKey: "draft.\(key)") != nil || d.stringArray(forKey: "draftFiles.\(key)") != nil {
            if old.hasPrefix("@") { d.removeObject(forKey: "draft.\(old)"); d.removeObject(forKey: "draftFiles.\(old)") }
            draftKey = key; return
        }
        UserDefaults.standard.removeObject(forKey: "draft.\(old)")
        UserDefaults.standard.removeObject(forKey: "draftFiles.\(old)")
        withoutLoad = true; draftKey = key; withoutLoad = false
        saveDraftNow()
    }
    private var withoutLoad = false

    // MARK: layout

    private func fit() {
        guard let lm = text.layoutManager, let tc = text.textContainer else { return }
        lm.ensureLayout(for: tc)
        let h = lm.usedRect(for: tc).height + text.textContainerInset.height * 2 + 4
        heightC.constant = min(max(h, minHeight), maxHeight)
    }

    override func viewDidChangeEffectiveAppearance() { refreshColors() }
    private func refreshColors() {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            layer?.backgroundColor = Theme.panel.cgColor
            layer?.borderColor = (dragging ? Theme.you : Theme.web ? Theme.ink : NSColor.separatorColor).cgColor
            layer?.borderWidth = Theme.web ? (dragging ? 3 : 2) : (dragging ? 2 : 1)
            Theme.hardShadow(layer, flipped: isFlipped)
        }
    }
}
