import Foundation
import OpenClawIPC
import OpenClawKit
import OpenClawProtocol
import OSLog

private let computerUseServerId = "computer-use"
private let computerUseRequiredPermissions = [Capability.accessibility.rawValue, Capability.screenRecording.rawValue]
private let computerUseEnvCommandKey = "OPENCLAW_COMPUTER_USE_MCP_COMMAND"
private let computerUseEnvArgsKey = "OPENCLAW_COMPUTER_USE_MCP_ARGS"
private let computerUseEnvPackageDirKey = "OPENCLAW_COMPUTER_USE_MCP_PACKAGE_DIR"
private let computerUseEnvInstallDirKey = "OPENCLAW_COMPUTER_USE_MCP_INSTALL_DIR"
private let computerUseAppSupportDirName = "CodexComputerUseMCP"
private let computerUsePackageDirName = "computer-use"
private let computerUseBundledResourcePath = "CodexComputerUseMCP/computer-use"
private let computerUseManagedMetadataFileName = ".openclaw-computer-use-source.json"

struct MacMcpLaunchConfig {
    var command: URL
    var args: [String]
    var cwd: URL?
    var source: String
}

private struct MacMcpPackageSource {
    var directory: URL
    var source: String
}

private struct MacMcpPackageFingerprint: Codable, Equatable {
    var fileCount: Int
    var totalSize: UInt64
    var latestModifiedAt: TimeInterval
}

private struct MacMcpManagedPackageMetadata: Codable, Equatable {
    var source: String
    var sourcePath: String
    var sourceFingerprint: MacMcpPackageFingerprint
}

private struct CodexMcpManifest: Decodable {
    struct Server: Decodable {
        var command: String
        var args: [String]?
        var cwd: String?
    }

    var mcpServers: [String: Server]
}

private final class ActiveMacMcpSession: @unchecked Sendable {
    let sessionId: String
    let nodeId: String
    let process: Process
    let input: Pipe
    var nextSeq = 0
    var closeRequested = false

    init(sessionId: String, nodeId: String, process: Process, input: Pipe) {
        self.sessionId = sessionId
        self.nodeId = nodeId
        self.process = process
        self.input = input
    }
}

actor MacComputerUseMcpHost {
    private let logger = Logger(subsystem: "ai.openclaw", category: "mac-mcp")
    private var sessions: [String: ActiveMacMcpSession] = [:]

    nonisolated static func computerUseDescriptor(permissions: [String: Bool]) -> NodeMcpServerDescriptor {
        let hasRequiredPermissions = computerUseRequiredPermissions.allSatisfy { permissions[$0] == true }
        let launch = Self.resolveComputerUseLaunchConfig()
        let status = if !hasRequiredPermissions {
            "missing_permissions"
        } else if launch == nil {
            "missing_backend"
        } else {
            "ready"
        }
        var metadata: [String: AnyCodable] = [:]
        if let launch {
            metadata["source"] = AnyCodable(launch.source)
            metadata["command"] = AnyCodable(launch.command.lastPathComponent)
        }
        return NodeMcpServerDescriptor(
            id: computerUseServerId,
            displayname: "Computer Use",
            provider: "codex",
            transport: "stdio",
            source: launch?.source ?? "codex-bundled",
            status: status,
            requiredpermissions: computerUseRequiredPermissions,
            metadata: metadata.isEmpty ? nil : metadata)
    }

    func open(_ event: NodeMcpSessionOpenEvent, gateway: GatewayNodeSession) async {
        guard event.serverid == computerUseServerId else {
            await gateway.sendMcpSessionOpenResult(Self.openResult(
                event: event,
                ok: false,
                errorCode: "UNKNOWN_SERVER",
                message: "unknown MCP server"))
            return
        }
        guard let launch = Self.resolveComputerUseLaunchConfig() else {
            await gateway.sendMcpSessionOpenResult(Self.openResult(
                event: event,
                ok: false,
                errorCode: "MISSING_BACKEND",
                message: "Codex Computer Use MCP backend is not installed"))
            return
        }

        let process = Process()
        process.executableURL = launch.command
        process.arguments = launch.args
        process.currentDirectoryURL = launch.cwd

        let stdin = Pipe()
        let stdout = Pipe()
        let stderr = Pipe()
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = stderr

        let active = ActiveMacMcpSession(
            sessionId: event.sessionid,
            nodeId: event.nodeid,
            process: process,
            input: stdin)
        self.sessions[event.sessionid] = active

        stdout.fileHandleForReading.readabilityHandler = { [weak self] fileHandle in
            let data = fileHandle.availableData
            guard !data.isEmpty else { return }
            Task { await self?.emitOutput(sessionId: event.sessionid, stream: "stdout", data: data, gateway: gateway) }
        }
        stderr.fileHandleForReading.readabilityHandler = { [weak self] fileHandle in
            let data = fileHandle.availableData
            guard !data.isEmpty else { return }
            Task { await self?.emitOutput(sessionId: event.sessionid, stream: "stderr", data: data, gateway: gateway) }
        }
        process.terminationHandler = { [weak self] process in
            Task { await self?.handleTermination(sessionId: event.sessionid, process: process, gateway: gateway) }
        }

        do {
            try process.run()
        } catch {
            stdout.fileHandleForReading.readabilityHandler = nil
            stderr.fileHandleForReading.readabilityHandler = nil
            self.sessions[event.sessionid] = nil
            await gateway.sendMcpSessionOpenResult(Self.openResult(
                event: event,
                ok: false,
                errorCode: "SPAWN_FAILED",
                message: error.localizedDescription))
            return
        }

        await gateway.sendMcpSessionOpenResult(NodeMcpSessionOpenResultParams(
            sessionid: event.sessionid,
            nodeid: event.nodeid,
            serverid: event.serverid,
            ok: true,
            pid: Int(process.processIdentifier),
            error: nil))
        self.logger.info("computer-use MCP session opened pid=\(process.processIdentifier, privacy: .public)")
    }

    func input(_ event: NodeMcpSessionInputEvent) async {
        guard let active = self.sessions[event.sessionid], active.nodeId == event.nodeid else {
            return
        }
        guard let data = Data(base64Encoded: event.database64) else {
            return
        }
        active.input.fileHandleForWriting.write(data)
    }

    func close(_ event: NodeMcpSessionCloseEvent) async {
        guard let active = self.sessions[event.sessionid], active.nodeId == event.nodeid else {
            return
        }
        active.closeRequested = true
        try? active.input.fileHandleForWriting.close()
        if active.process.isRunning {
            active.process.terminate()
        }
    }

    private func emitOutput(sessionId: String, stream: String, data: Data, gateway: GatewayNodeSession) async {
        guard let active = self.sessions[sessionId] else { return }
        let seq = active.nextSeq
        active.nextSeq += 1
        await gateway.sendMcpSessionOutput(NodeMcpSessionOutputParams(
            sessionid: active.sessionId,
            nodeid: active.nodeId,
            seq: seq,
            stream: stream,
            database64: data.base64EncodedString()))
    }

    private func handleTermination(sessionId: String, process: Process, gateway: GatewayNodeSession) async {
        guard let active = self.sessions.removeValue(forKey: sessionId) else { return }
        let ok = active.closeRequested || process.terminationStatus == 0
        await gateway.sendMcpSessionClosed(NodeMcpSessionClosedParams(
            sessionid: active.sessionId,
            nodeid: active.nodeId,
            ok: ok,
            exitcode: AnyCodable(Int(process.terminationStatus)),
            signal: process.terminationReason == .uncaughtSignal
                ? AnyCodable(Int(process.terminationStatus))
                : nil,
            error: ok
                ? nil
                : [
                    "code": AnyCodable("PROCESS_EXITED"),
                    "message": AnyCodable("MCP backend exited with status \(process.terminationStatus)"),
                ]))
    }

    private static func openResult(
        event: NodeMcpSessionOpenEvent,
        ok: Bool,
        errorCode: String,
        message: String) -> NodeMcpSessionOpenResultParams
    {
        NodeMcpSessionOpenResultParams(
            sessionid: event.sessionid,
            nodeid: event.nodeid,
            serverid: event.serverid,
            ok: ok,
            pid: nil,
            error: [
                "code": AnyCodable(errorCode),
                "message": AnyCodable(message),
            ])
    }

    nonisolated static func resolveComputerUseLaunchConfig(
        env: [String: String] = ProcessInfo.processInfo.environment,
        fileManager: FileManager = .default,
        resourceURL: URL? = Bundle.main.resourceURL,
        codexPluginDir: URL = URL(
            fileURLWithPath: "/Applications/Codex.app/Contents/Resources/plugins/openai-bundled/plugins/computer-use"),
        appSupportRoot: URL? = nil) -> MacMcpLaunchConfig?
    {
        if let rawCommand = env[computerUseEnvCommandKey]?.trimmingCharacters(in: .whitespacesAndNewlines),
           !rawCommand.isEmpty
        {
            let command = URL(fileURLWithPath: NSString(string: rawCommand).expandingTildeInPath)
            return MacMcpLaunchConfig(
                command: command,
                args: Self.parseEnvArgs(env[computerUseEnvArgsKey]) ?? ["mcp"],
                cwd: nil,
                source: "env-command")
        }

        if let rawPackageDir = env[computerUseEnvPackageDirKey]?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !rawPackageDir.isEmpty
        {
            let packageDir = URL(fileURLWithPath: NSString(string: rawPackageDir).expandingTildeInPath)
            if let launch = Self.resolvePackageLaunchConfig(
                packageDir: packageDir,
                source: "env-package",
                fileManager: fileManager)
            {
                return launch
            }
        }

        let managedDir = Self.managedPackageDirectory(
            env: env,
            fileManager: fileManager,
            appSupportRoot: appSupportRoot)
        let managedLaunch = Self.resolvePackageLaunchConfig(
            packageDir: managedDir,
            source: "openclaw-managed",
            fileManager: fileManager)
        let source = Self.approvedPackageSources(
            resourceURL: resourceURL,
            codexPluginDir: codexPluginDir,
            fileManager: fileManager).first

        if let managedLaunch {
            guard
                let source,
                Self.managedPackageNeedsRefresh(
                    managedDir: managedDir,
                    source: source,
                    fileManager: fileManager)
            else {
                return managedLaunch
            }
        }

        if let source,
           Self.installManagedPackage(from: source, to: managedDir, fileManager: fileManager),
           let launch = Self.resolvePackageLaunchConfig(
               packageDir: managedDir,
               source: "openclaw-managed:\(source.source)",
               fileManager: fileManager)
        {
            return launch
        }

        return managedLaunch
    }

    private nonisolated static func approvedPackageSources(
        resourceURL: URL?,
        codexPluginDir: URL,
        fileManager: FileManager) -> [MacMcpPackageSource]
    {
        [
            resourceURL?.appendingPathComponent(computerUseBundledResourcePath, isDirectory: true)
                .map { MacMcpPackageSource(directory: $0, source: "openclaw-bundled") },
            MacMcpPackageSource(directory: codexPluginDir, source: "codex-bundled"),
        ].compactMap { $0 }
            .filter {
                Self.resolvePackageLaunchConfig(
                    packageDir: $0.directory,
                    source: $0.source,
                    fileManager: fileManager) != nil
            }
    }

    private nonisolated static func resolvePackageLaunchConfig(
        packageDir: URL,
        source: String,
        fileManager: FileManager) -> MacMcpLaunchConfig?
    {
        let manifestURL = packageDir.appendingPathComponent(".mcp.json", isDirectory: false)
        guard
            let data = try? Data(contentsOf: manifestURL),
            let manifest = try? JSONDecoder().decode(CodexMcpManifest.self, from: data),
            let server = manifest.mcpServers[computerUseServerId]
        else {
            return nil
        }
        let cwd = Self.resolvePath(server.cwd ?? ".", relativeTo: packageDir)
        let command = Self.resolvePath(server.command, relativeTo: cwd)
        guard fileManager.isExecutableFile(atPath: command.path) else {
            return nil
        }
        return MacMcpLaunchConfig(
            command: command,
            args: server.args ?? [],
            cwd: cwd,
            source: source)
    }

    private nonisolated static func managedPackageDirectory(
        env: [String: String],
        fileManager: FileManager,
        appSupportRoot: URL?) -> URL
    {
        if let rawInstallDir = env[computerUseEnvInstallDirKey]?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !rawInstallDir.isEmpty
        {
            return URL(fileURLWithPath: NSString(string: rawInstallDir).expandingTildeInPath)
        }
        let base = appSupportRoot
            ?? fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
                .appendingPathComponent("OpenClaw", isDirectory: true)
            ?? fileManager.homeDirectoryForCurrentUser
                .appendingPathComponent("Library", isDirectory: true)
                .appendingPathComponent("Application Support", isDirectory: true)
                .appendingPathComponent("OpenClaw", isDirectory: true)
        return base
            .appendingPathComponent(computerUseAppSupportDirName, isDirectory: true)
            .appendingPathComponent(computerUsePackageDirName, isDirectory: true)
    }

    private nonisolated static func managedPackageNeedsRefresh(
        managedDir: URL,
        source: MacMcpPackageSource,
        fileManager: FileManager) -> Bool
    {
        guard let sourceFingerprint = Self.packageFingerprint(
            packageDir: source.directory,
            fileManager: fileManager)
        else {
            return false
        }
        let metadataURL = managedDir.appendingPathComponent(
            computerUseManagedMetadataFileName,
            isDirectory: false)
        guard
            let data = try? Data(contentsOf: metadataURL),
            let metadata = try? JSONDecoder().decode(MacMcpManagedPackageMetadata.self, from: data)
        else {
            return true
        }
        return metadata != MacMcpManagedPackageMetadata(
            source: source.source,
            sourcePath: source.directory.path,
            sourceFingerprint: sourceFingerprint)
    }

    private nonisolated static func installManagedPackage(
        from source: MacMcpPackageSource,
        to destination: URL,
        fileManager: FileManager) -> Bool
    {
        guard let sourceFingerprint = Self.packageFingerprint(
            packageDir: source.directory,
            fileManager: fileManager)
        else {
            return false
        }
        let parent = destination.deletingLastPathComponent()
        let temp = parent.appendingPathComponent(
            ".\(destination.lastPathComponent).\(UUID().uuidString).tmp",
            isDirectory: true)

        do {
            try fileManager.createDirectory(at: parent, withIntermediateDirectories: true)
            if fileManager.fileExists(atPath: temp.path) {
                try fileManager.removeItem(at: temp)
            }
            try fileManager.copyItem(at: source.directory, to: temp)
            let metadata = MacMcpManagedPackageMetadata(
                source: source.source,
                sourcePath: source.directory.path,
                sourceFingerprint: sourceFingerprint)
            let metadataData = try JSONEncoder().encode(metadata)
            try metadataData.write(
                to: temp.appendingPathComponent(computerUseManagedMetadataFileName, isDirectory: false),
                options: [.atomic])

            if fileManager.fileExists(atPath: destination.path) {
                try fileManager.removeItem(at: destination)
            }
            try fileManager.moveItem(at: temp, to: destination)
            return true
        } catch {
            try? fileManager.removeItem(at: temp)
            return false
        }
    }

    private nonisolated static func packageFingerprint(
        packageDir: URL,
        fileManager: FileManager) -> MacMcpPackageFingerprint?
    {
        guard let enumerator = fileManager.enumerator(
            at: packageDir,
            includingPropertiesForKeys: [.isRegularFileKey, .fileSizeKey, .contentModificationDateKey],
            options: [],
            errorHandler: nil)
        else {
            return nil
        }
        var fileCount = 0
        var totalSize: UInt64 = 0
        var latestModifiedAt: TimeInterval = 0
        for case let url as URL in enumerator {
            guard let values = try? url.resourceValues(forKeys: [
                .isRegularFileKey,
                .fileSizeKey,
                .contentModificationDateKey,
            ]), values.isRegularFile == true
            else {
                continue
            }
            fileCount += 1
            totalSize += UInt64(values.fileSize ?? 0)
            latestModifiedAt = max(
                latestModifiedAt,
                values.contentModificationDate?.timeIntervalSince1970 ?? 0)
        }
        guard fileCount > 0 else { return nil }
        return MacMcpPackageFingerprint(
            fileCount: fileCount,
            totalSize: totalSize,
            latestModifiedAt: latestModifiedAt)
    }

    private nonisolated static func parseEnvArgs(_ raw: String?) -> [String]? {
        guard let raw, let data = raw.data(using: .utf8) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String]
    }

    private nonisolated static func resolvePath(_ raw: String, relativeTo base: URL) -> URL {
        let expanded = NSString(string: raw).expandingTildeInPath
        if expanded.hasPrefix("/") {
            return URL(fileURLWithPath: expanded)
        }
        return base.appendingPathComponent(expanded)
    }
}
