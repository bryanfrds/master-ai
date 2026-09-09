// The window for Master AI.app: a native WKWebView that owns the dashboard
// server. Built by app.mjs; see the Mac app section of the README.
//
// This is deliberately a real compiled binary. macOS will not launch an app
// whose executable is a script, and a browser tab is not an app window.
import Cocoa
import WebKit
import UserNotifications

let port = ProcessInfo.processInfo.environment["DASHBOARD_PORT"] ?? "4783"
let root = URL(string: "http://127.0.0.1:\(port)")!
let dashboard = root.appendingPathComponent("runs")
let logPath = ("~/Library/Logs/Master AI.log" as NSString).expandingTildeInPath

// Startup notes go to the same log as the server, so a launch that fails
// under Finder (where there is no console) can still be explained.
func note(_ line: String) {
    let stamp = ISO8601DateFormatter().string(from: Date())
    guard let data = "\(stamp) \(line)\n".data(using: .utf8) else { return }
    // O_APPEND, because the server is writing to this same file: seeking to the
    // end first would let the two writers interleave mid-line.
    let fd = open(logPath, O_WRONLY | O_APPEND | O_CREAT, 0o644)
    guard fd >= 0 else { return }
    data.withUnsafeBytes { _ = write(fd, $0.baseAddress, $0.count) }
    close(fd)
}

func nodeBinary() -> String? {
    // Launched from Finder there is almost no PATH, so ask a login shell.
    for shell in ["/bin/zsh", "/bin/bash"] {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: shell)
        task.arguments = ["-lc", "command -v node"]
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = FileHandle.nullDevice
        guard (try? task.run()) != nil else { continue }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        task.waitUntilExit()
        let found = String(decoding: data, as: UTF8.self)
            .split(separator: "\n").last.map(String.init)?
            .trimmingCharacters(in: .whitespaces) ?? ""
        if !found.isEmpty, FileManager.default.isExecutableFile(atPath: found) { return found }
    }
    return nil
}

func serverIsAwake() -> Bool {
    var request = URLRequest(url: root.appendingPathComponent("api/state"))
    request.timeoutInterval = 1.5
    let waiting = DispatchSemaphore(value: 0)
    var alive = false
    URLSession.shared.dataTask(with: request) { _, response, _ in
        alive = (response as? HTTPURLResponse)?.statusCode == 200
        waiting.signal()
    }.resume()
    _ = waiting.wait(timeout: .now() + 2)
    return alive
}

final class Delegate: NSObject, NSApplicationDelegate, WKUIDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var web: WKWebView!
    var server: Process?
    var notificationsAllowed = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        note("app: did finish launching")
        // Asked for once; agents run for minutes and the window is usually behind
        // something else by the time one finishes.
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, _ in
            self.notificationsAllowed = granted
            note("notifications: \(granted ? "allowed" : "not allowed")")
            // The page says so rather than promising a banner that cannot appear.
            DispatchQueue.main.async {
                self.web?.evaluateJavaScript("window.dashboardNotifications = \(granted)")
            }
        }
        buildMenu()
        buildWindow()
        note("app: window ready")
        NSApp.activate(ignoringOtherApps: true)
        DispatchQueue.global(qos: .userInitiated).async { self.startServer() }
    }

    func applicationWillFinishLaunching(_ notification: Notification) {
        note("app: will finish launching")
    }

    func buildWindow() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        // The page asks for a folder through this channel; in a plain browser
        // the flag is absent and it falls back to the text field.
        configuration.userContentController.add(self, name: "chooseFolder")
        configuration.userContentController.add(self, name: "notify")
        configuration.userContentController.addUserScript(WKUserScript(
            source: "window.dashboardNative = true;",
            injectionTime: .atDocumentStart, forMainFrameOnly: true))
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1180, height: 800), configuration: configuration)
        web.navigationDelegate = self
        web.uiDelegate = self
        // Dropping a file onto the page would replace the dashboard with it.
        if web.responds(to: Selector(("setAllowsMagnification:"))) { web.allowsMagnification = true }

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1180, height: 800),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        window.title = "Master AI"
        window.contentView = web
        window.minSize = NSSize(width: 720, height: 480)
        // Restore the remembered frame first, then fall back to centring: doing
        // it the other way round lets a stale saved frame win, which can park
        // the window off-screen.
        if !window.setFrameUsingName("MasterAIWindow") { window.center() }
        window.setFrameAutosaveName("MasterAIWindow")
        if let screen = window.screen ?? NSScreen.main,
           !screen.visibleFrame.intersects(window.frame) {
            note("window: saved frame was off-screen, recentring")
            window.setFrame(NSRect(x: 0, y: 0, width: 1180, height: 800), display: false)
            window.center()
        }
        window.makeKeyAndOrderFront(nil)
        show(message: "Starting the dashboard…")
    }

    func show(message: String) {
        let html = """
        <html><head><meta charset="utf-8"><style>
        html,body{height:100%;margin:0}
        body{display:grid;place-items:center;background:#f6f7f4;color:#7a8178;
             font:14px Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
        @media(prefers-color-scheme:dark){body{background:#1d221c;color:#93998e}}
        </style></head><body>\(message)</body></html>
        """
        web.loadHTMLString(html, baseURL: nil)
    }

    func startServer() {
        // Something is already serving: a terminal `npm start`, or a copy of
        // this app that is still shutting down. Use it rather than fighting
        // over the port.
        if serverIsAwake() {
            note("server: already running, reusing it")
            return DispatchQueue.main.async { self.show(dashboard) }
        }

        guard let node = nodeBinary() else {
            note("server: node not found")
            return DispatchQueue.main.async {
                self.fail("Node.js was not found.",
                          "Install Node 22 or newer, then open Master AI again.")
            }
        }
        guard let resources = Bundle.main.resourcePath else { return }
        let entry = resources + "/app/server.mjs"
        guard FileManager.default.fileExists(atPath: entry) else {
            return DispatchQueue.main.async {
                self.fail("Master AI is missing its dashboard files.",
                          "Build it again with npm run app.")
            }
        }

        note("--- starting the dashboard")
        // O_APPEND matters: node inherits this descriptor and keeps its own
        // offset, so without it the server would overwrite our own log lines.
        let fd = open(logPath, O_WRONLY | O_APPEND | O_CREAT, 0o644)
        let log = fd >= 0 ? FileHandle(fileDescriptor: fd, closeOnDealloc: true) : nil

        let task = Process()
        task.executableURL = URL(fileURLWithPath: node)
        task.arguments = [entry]
        // Node must not inherit our stdout; the log is also what the failure
        // message points at.
        task.standardOutput = log ?? FileHandle.nullDevice
        task.standardError = log ?? FileHandle.nullDevice
        do { try task.run() } catch {
            return DispatchQueue.main.async {
                self.fail("The dashboard could not start.", "\(error.localizedDescription)")
            }
        }
        server = task
        note("server: started \(node) (pid \(task.processIdentifier))")

        for _ in 0..<75 {
            if serverIsAwake() {
                note("server: answering, loading the dashboard")
                return DispatchQueue.main.async { self.show(dashboard) }
            }
            if !task.isRunning { break }
            Thread.sleep(forTimeInterval: 0.2)
        }
        DispatchQueue.main.async {
            self.fail("The dashboard did not start.", "See \(self.logPathForDisplay()) for the reason.")
        }
    }

    func logPathForDisplay() -> String {
        logPath.replacingOccurrences(of: NSHomeDirectory(), with: "~")
    }

    func show(_ url: URL) {
        web.load(URLRequest(url: url))
    }

    func fail(_ title: String, _ detail: String) {
        show(message: "The dashboard is not running.")
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = detail
        alert.alertStyle = .critical
        alert.addButton(withTitle: "Quit")
        alert.runModal()
        NSApp.terminate(nil)
    }

    @objc func openNotificationSettings() {
        guard let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension") else { return }
        NSWorkspace.shared.open(url)
    }

    @objc func sendTestNotification() {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            DispatchQueue.main.async {
                guard settings.authorizationStatus == .authorized else {
                    let alert = NSAlert()
                    alert.messageText = "Notifications are turned off for Master AI."
                    alert.informativeText = "Turn them on in System Settings › Notifications › Master AI, then try again. Until then a finished agent bounces the Dock icon instead."
                    alert.addButton(withTitle: "Open Settings")
                    alert.addButton(withTitle: "Not now")
                    if alert.runModal() == .alertFirstButtonReturn { self.openNotificationSettings() }
                    return
                }
                let content = UNMutableNotificationContent()
                content.title = "Master AI"
                content.body = "Notifications are working. You will get one like this when an agent finishes."
                content.sound = .default
                UNUserNotificationCenter.current().add(
                    UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
            }
        }
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "notify" {
            guard let body = message.body as? [String: Any],
                  let title = body["title"] as? String else { return }
            // Re-read rather than trusting the answer from launch: permission can
            // be granted in Settings while the app is running.
            UNUserNotificationCenter.current().getNotificationSettings { settings in
                self.notificationsAllowed = settings.authorizationStatus == .authorized
                DispatchQueue.main.async { self.deliver(title: title, body: body["body"] as? String ?? "") }
            }
            return
        }
        guard message.name == "chooseFolder" else { return }
        showFolderPicker()
    }

    func deliver(title: String, body: String) {
        if notificationsAllowed {
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            content.sound = .default
            UNUserNotificationCenter.current().add(
                UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
        } else if !NSApp.isActive {
            // Without permission there is still one way to get noticed that
            // needs none: bounce the Dock icon until the app is looked at.
            NSApp.requestUserAttention(.informationalRequest)
        }
    }

    func showFolderPicker() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Use this folder"
        panel.message = "Choose the project an agent should work on."
        if let last = UserDefaults.standard.string(forKey: "LastProjectFolder") {
            panel.directoryURL = URL(fileURLWithPath: last)
        }
        panel.beginSheetModal(for: window) { response in
            guard response == .OK, let url = panel.url else { return }
            UserDefaults.standard.set(url.path, forKey: "LastProjectFolder")
            // JSON-encode the path: folder names may contain quotes.
            let encoded = String(decoding: (try? JSONSerialization.data(
                withJSONObject: [url.path], options: [])) ?? Data("[\"\"]".utf8), as: UTF8.self)
            self.web.evaluateJavaScript("window.dashboardFolderChosen(\(encoded)[0])")
        }
    }

    // Sign-in and any other outside link belongs in the real browser, which has
    // the user's session and password manager.
    func webView(_ view: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ view: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url, url.scheme == "http" || url.scheme == "https" else {
            return decisionHandler(.allow)   // about:blank and the loading page
        }
        if url.host == "127.0.0.1" { return decisionHandler(.allow) }
        NSWorkspace.shared.open(url)
        decisionHandler(.cancel)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

    // Quitting kills the agents this app started, so say what is being thrown
    // away rather than discovering it afterwards.
    func applicationShouldTerminate(_ app: NSApplication) -> NSApplication.TerminateReply {
        let busy = activeRunCount()
        guard busy > 0 else { return .terminateNow }
        let alert = NSAlert()
        alert.messageText = busy == 1 ? "One agent is still working." : "\(busy) agents are still working."
        alert.informativeText = "Quitting stops them. Anything they have written so far is committed to their branches, and you can carry on from there next time."
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Keep working")
        alert.addButton(withTitle: "Quit anyway")
        return alert.runModal() == .alertFirstButtonReturn ? .terminateCancel : .terminateNow
    }

    func activeRunCount() -> Int {
        var request = URLRequest(url: root.appendingPathComponent("api/runs"))
        request.timeoutInterval = 2
        let waiting = DispatchSemaphore(value: 0)
        var count = 0
        URLSession.shared.dataTask(with: request) { data, _, _ in
            defer { waiting.signal() }
            guard let data,
                  let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let runs = body["runs"] as? [[String: Any]] else { return }
            count = runs.filter { ["running", "waiting"].contains($0["status"] as? String ?? "") }.count
        }.resume()
        _ = waiting.wait(timeout: .now() + 3)
        return count
    }

    func applicationShouldHandleReopen(_ app: NSApplication, hasVisibleWindows visible: Bool) -> Bool {
        if !visible { window.makeKeyAndOrderFront(nil) }
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        note("app: terminating")
        // Started by us, so it stops with us; a server left behind would hold
        // the port and keep agents running unattended.
        guard let task = server, task.isRunning else { return }
        task.terminate()
        let deadline = Date().addingTimeInterval(3)
        while task.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.05) }
        if task.isRunning { kill(task.processIdentifier, SIGKILL) }
    }

    // Without a menu there is no Cmd-Q, and no Cmd-C/V inside the page.
    func buildMenu() {
        let bar = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Master AI", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        // macOS never asks twice, so once notifications are refused the only way
        // back is Settings. Put the door in the app rather than describing it.
        let settings = NSMenuItem(title: "Notification Settings…", action: #selector(openNotificationSettings), keyEquivalent: "")
        settings.target = self
        appMenu.addItem(settings)
        let test = NSMenuItem(title: "Send a Test Notification", action: #selector(sendTestNotification), keyEquivalent: "")
        test.target = self
        appMenu.addItem(test)
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Master AI", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit Master AI", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        bar.addItem(appItem)

        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        bar.addItem(editItem)

        let viewItem = NSMenuItem()
        let view = NSMenu(title: "View")
        view.addItem(withTitle: "Reload", action: #selector(WKWebView.reload(_:)), keyEquivalent: "r")
        viewItem.submenu = view
        bar.addItem(viewItem)

        NSApp.mainMenu = bar
    }
}

extension Delegate: UNUserNotificationCenterDelegate {
    // Show it even while this app is frontmost: the window may be on another
    // display or behind an editor.
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                               willPresent notification: UNNotification,
                               withCompletionHandler handler: @escaping (UNNotificationPresentationOptions) -> Void) {
        handler([.banner, .sound])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                               didReceive response: UNNotificationResponse,
                               withCompletionHandler handler: @escaping () -> Void) {
        DispatchQueue.main.async {
            NSApp.activate(ignoringOtherApps: true)
            self.window?.makeKeyAndOrderFront(nil)
        }
        handler()
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = Delegate()
app.delegate = delegate
app.run()
