import Foundation
import Network
import IOKit
import IOKit.hid
import CryptoKit

private struct Sample {
    let t: Double
    let x: Double
    let y: Double
    let z: Double
}

private enum SensorType {
    case accel
    case gyro

    var name: String { self == .accel ? "accelerometer" : "gyroscope" }
    var messageType: String { self == .accel ? "accel" : "gyro" }
}

private final class InputContext {
    unowned let bridge: SensorBridge
    let type: SensorType

    init(_ bridge: SensorBridge, _ type: SensorType) {
        self.bridge = bridge
        self.type = type
    }
}

private final class SensorBridge {
    private let lock = NSLock()
    private var accelSamples: [Sample] = []
    private var gyroSamples: [Sample] = []
    private var manager: IOHIDManager?
    private var reportBuffers: [UnsafeMutablePointer<UInt8>] = []
    private var inputContexts: [InputContext] = []
    private var openedDevice = false
    private var openFailureReported = false
    var onError: ((String) -> Void)?

    deinit { reportBuffers.forEach { $0.deallocate() } }

    func start() {
        wakeSensorDriver()
        let manager = IOHIDManagerCreate(kCFAllocatorDefault, IOOptionBits(kIOHIDOptionsTypeNone))
        self.manager = manager
        let accelMatching: [String: Any] = [
            kIOHIDPrimaryUsagePageKey as String: 0xFF00,
            kIOHIDPrimaryUsageKey as String: 3
        ]
        let gyroMatching: [String: Any] = [
            kIOHIDPrimaryUsagePageKey as String: 0xFF00,
            kIOHIDPrimaryUsageKey as String: 9
        ]
        IOHIDManagerSetDeviceMatchingMultiple(manager, [accelMatching, gyroMatching] as CFArray)
        IOHIDManagerRegisterDeviceMatchingCallback(manager, deviceMatched, Unmanaged.passUnretained(self).toOpaque())
        IOHIDManagerScheduleWithRunLoop(manager, CFRunLoopGetCurrent(), CFRunLoopMode.defaultMode.rawValue)
        let result = IOHIDManagerOpen(manager, IOOptionBits(kIOHIDOptionsTypeNone))
        if result != kIOReturnSuccess {
            reportOpenFailure(result)
        }
    }

    func drain() -> (accel: [Sample], gyro: [Sample]) {
        lock.lock(); defer { lock.unlock() }
        let result = (accelSamples, gyroSamples)
        accelSamples.removeAll(keepingCapacity: true)
        gyroSamples.removeAll(keepingCapacity: true)
        return result
    }

    fileprivate func matched(_ device: IOHIDDevice) {
        var className = [CChar](repeating: 0, count: 128)
        let service = IOHIDDeviceGetService(device)
        guard IOObjectGetClass(service, &className) == KERN_SUCCESS,
              String(cString: className) == "AppleSPUHIDDevice" else { return }
        guard let usage = IOHIDDeviceGetProperty(device, kIOHIDPrimaryUsageKey as CFString) as? NSNumber,
              let type = usage.intValue == 3 ? SensorType.accel : usage.intValue == 9 ? SensorType.gyro : nil else { return }
        let result = IOHIDDeviceOpen(device, IOOptionBits(kIOHIDOptionsTypeNone))
        guard result == kIOReturnSuccess else { reportOpenFailure(result); return }
        openedDevice = true
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 64)
        reportBuffers.append(buffer) // IOHID retains only the pointer, not its storage.
        let context = InputContext(self, type)
        inputContexts.append(context)
        IOHIDDeviceRegisterInputReportCallback(device, buffer, 64, inputReport, Unmanaged.passUnretained(context).toOpaque())
        fputs("Opened AppleSPUHIDDevice \(type.name).\n", stderr)
    }

    fileprivate func receive(_ type: SensorType, _ report: UnsafePointer<UInt8>?, length: Int) {
        guard let report, length >= 18 else { return }
        func int32LE(_ offset: Int) -> Int32 {
            let u = UInt32(report[offset]) | UInt32(report[offset + 1]) << 8 |
                    UInt32(report[offset + 2]) << 16 | UInt32(report[offset + 3]) << 24
            return Int32(bitPattern: u)
        }
        let sample = Sample(t: ProcessInfo.processInfo.systemUptime,
                            x: Double(int32LE(6)) / 65536.0,
                            y: Double(int32LE(10)) / 65536.0,
                            z: Double(int32LE(14)) / 65536.0)
        lock.lock()
        if type == .accel { accelSamples.append(sample) } else { gyroSamples.append(sample) }
        lock.unlock()
    }

    private func reportOpenFailure(_ result: IOReturn) {
        guard !openFailureReported else { return }
        openFailureReported = true
        let reason = String(cString: mach_error_string(result))
        let message = "Could not open AppleSPUHIDDevice (IOKit: \(reason), \(result)). This usually requires root privileges; try sudo drum-bridge."
        fputs(message + "\n", stderr)
        onError?(message)
    }

    private func wakeSensorDriver() {
        var iterator: io_iterator_t = 0
        guard IOServiceGetMatchingServices(kIOMainPortDefault, IOServiceMatching("AppleSPUHIDDriver"), &iterator) == KERN_SUCCESS else { return }
        defer { IOObjectRelease(iterator) }
        var service = IOIteratorNext(iterator)
        while service != 0 {
            for (key, value) in [("SensorPropertyReportingState", 1), ("SensorPropertyPowerState", 1), ("ReportInterval", 1000)] {
                IORegistryEntrySetCFProperty(service, key as CFString, NSNumber(value: value))
            }
            IOObjectRelease(service)
            service = IOIteratorNext(iterator)
        }
    }
}

private func deviceMatched(_ context: UnsafeMutableRawPointer?, _: IOReturn, _: UnsafeMutableRawPointer?, device: IOHIDDevice) {
    guard let context else { return }
    Unmanaged<SensorBridge>.fromOpaque(context).takeUnretainedValue().matched(device)
}

private func inputReport(_ context: UnsafeMutableRawPointer?, _: IOReturn, _: UnsafeMutableRawPointer?, _: IOHIDReportType, _: UInt32, report: UnsafeMutablePointer<UInt8>, reportLength: CFIndex) {
    guard let context else { return }
    let input = Unmanaged<InputContext>.fromOpaque(context).takeUnretainedValue()
    input.bridge.receive(input.type, UnsafePointer(report), length: Int(reportLength))
}

private final class WebServer {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "drum.bridge.http")
    private let webRoot: URL
    private var clients: [UUID: NWConnection] = [:]
    private var lastError: Data?

    init(port: UInt16, webRoot: URL) throws {
        self.webRoot = webRoot.standardizedFileURL
        // Bind to loopback only: the bridge usually runs as root and should not be reachable from the LAN.
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!)
        listener = try NWListener(using: parameters)
    }

    func start() {
        listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
        listener.stateUpdateHandler = { state in
            if case .failed(let error) = state { fputs("HTTP listener failed: \(error)\n", stderr) }
        }
        listener.start(queue: queue)
        fputs("Serving \(webRoot.path) at http://localhost:8787\n", stderr)
    }

    func broadcast(_ type: SensorType, samples: [Sample]) {
        guard !samples.isEmpty else { return }
        let array = samples.map { [$0.t, $0.x, $0.y, $0.z] }
        guard let data = try? JSONSerialization.data(withJSONObject: ["type": type.messageType, "samples": array]) else { return }
        queue.async { [weak self] in self?.sendFrame(data) }
    }

    func broadcastError(_ message: String) {
        guard let data = try? JSONSerialization.data(withJSONObject: ["type": "error", "message": message]) else { return }
        queue.async { [weak self] in self?.lastError = data; self?.sendFrame(data) }
    }

    private func accept(_ connection: NWConnection) {
        connection.start(queue: queue)
        receiveRequest(connection, data: Data())
    }

    private func receiveRequest(_ connection: NWConnection, data: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16_384) { [weak self] content, _, complete, error in
            guard let self else { return }
            var accumulated = data
            if let content { accumulated.append(content) }
            if let range = accumulated.range(of: Data("\r\n\r\n".utf8)) {
                self.handleRequest(connection, header: String(decoding: accumulated[..<range.lowerBound], as: UTF8.self))
            } else if error == nil && !complete && accumulated.count < 16_384 {
                self.receiveRequest(connection, data: accumulated)
            } else {
                connection.cancel()
            }
        }
    }

    private func handleRequest(_ connection: NWConnection, header: String) {
        let lines = header.components(separatedBy: "\r\n")
        guard let request = lines.first?.split(separator: " "), request.count >= 2, request[0] == "GET" else { return respond(connection, status: "400 Bad Request", body: Data()) }
        let path = String(request[1].split(separator: "?", maxSplits: 1)[0])
        let headers = Dictionary(uniqueKeysWithValues: lines.dropFirst().compactMap { line -> (String, String)? in
            guard let i = line.firstIndex(of: ":") else { return nil }; return (line[..<i].lowercased(), line[line.index(after: i)...].trimmingCharacters(in: .whitespaces))
        })
        if path == "/ws", headers["upgrade"]?.lowercased() == "websocket", let key = headers["sec-websocket-key"] {
            upgrade(connection, key: key)
        } else { serveFile(connection, path: path) }
    }

    private func upgrade(_ connection: NWConnection, key: String) {
        let accept = Data(Insecure.SHA1.hash(data: Data((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").utf8))).base64EncodedString()
        let response = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: \(accept)\r\n\r\n"
        connection.send(content: Data(response.utf8), completion: .contentProcessed { [weak self, weak connection] _ in
            guard let self, let connection else { return }
            let id = UUID(); self.clients[id] = connection
            let hello = try! JSONSerialization.data(withJSONObject: ["type": "hello", "device": "AppleSPUHIDDevice", "rateHz": 800])
            self.sendFrame(hello, only: connection)
            if let error = self.lastError { self.sendFrame(error, only: connection) }
            self.keepWebSocket(connection, id: id)
        })
    }

    private func keepWebSocket(_ connection: NWConnection, id: UUID) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 2048) { [weak self] _, _, done, error in
            guard let self else { return }
            if done || error != nil { self.clients.removeValue(forKey: id) } else { self.keepWebSocket(connection, id: id) }
        }
    }

    private func sendFrame(_ payload: Data, only one: NWConnection? = nil) {
        var frame = Data([0x81])
        if payload.count < 126 { frame.append(UInt8(payload.count)) }
        else if payload.count <= 65_535 { frame.append(126); frame.append(UInt8(payload.count >> 8)); frame.append(UInt8(payload.count & 255)) }
        else { return } // batches at 10 ms are far below this limit
        frame.append(payload)
        let targets = one.map { [$0] } ?? Array(clients.values)
        for client in targets { client.send(content: frame, completion: .contentProcessed { _ in }) }
    }

    private func serveFile(_ connection: NWConnection, path: String) {
        let requested = path == "/" ? "index.html" : String(path.dropFirst())
        guard !requested.contains(".."), let decoded = requested.removingPercentEncoding else { return respond(connection, status: "403 Forbidden", body: Data()) }
        let file = webRoot.appendingPathComponent(decoded).standardizedFileURL
        guard file.path.hasPrefix(webRoot.path), let body = try? Data(contentsOf: file) else { return respond(connection, status: "404 Not Found", body: Data("Not found\n".utf8)) }
        let ext = file.pathExtension
        let mime = ["html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8", "css": "text/css; charset=utf-8", "json": "application/json" ][ext] ?? "application/octet-stream"
        respond(connection, status: "200 OK", body: body, type: mime)
    }

    private func respond(_ connection: NWConnection, status: String, body: Data, type: String = "text/plain; charset=utf-8") {
        let header = "HTTP/1.1 \(status)\r\nContent-Type: \(type)\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n"
        var output = Data(header.utf8); output.append(body)
        connection.send(content: output, completion: .contentProcessed { _ in connection.cancel() })
    }
}

let arguments = CommandLine.arguments
let dump = arguments.contains("--dump")
let webIndex = arguments.firstIndex(of: "--web")
let webPath = webIndex.flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil } ?? "web"
if arguments.contains("--help") { print("Usage: drum-bridge [--web <directory>] [--dump]"); exit(0) }

private let sensor = SensorBridge()
private let server: WebServer? = dump ? nil : try? WebServer(port: 8787, webRoot: URL(fileURLWithPath: webPath, relativeTo: URL(fileURLWithPath: FileManager.default.currentDirectoryPath)))
if !dump && server == nil { fputs("Could not listen on port 8787.\n", stderr); exit(1) }
sensor.onError = { server?.broadcastError($0) }
server?.start()
sensor.start()

var accelCount = 0
var gyroCount = 0
var lastRate = ProcessInfo.processInfo.systemUptime
// A non-main queue keeps batching active while the main run loop services HID.
let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .userInitiated))
timer.schedule(deadline: .now() + .milliseconds(10), repeating: .milliseconds(10))
timer.setEventHandler {
    let samples = sensor.drain()
    if dump {
        for s in samples.accel { print(String(format: "A %.6f  x=% .5f  y=% .5f  z=% .5f", s.t, s.x, s.y, s.z)) }
        for s in samples.gyro { print(String(format: "G %.6f  x=% .5f  y=% .5f  z=% .5f", s.t, s.x, s.y, s.z)) }
        accelCount += samples.accel.count
        gyroCount += samples.gyro.count
        let now = ProcessInfo.processInfo.systemUptime
        if now - lastRate >= 1 { print("rate: accel \(accelCount) Hz, gyro \(gyroCount) Hz"); fflush(stdout); accelCount = 0; gyroCount = 0; lastRate = now }
    } else {
        server?.broadcast(.accel, samples: samples.accel)
        server?.broadcast(.gyro, samples: samples.gyro)
    }
}
timer.resume()
RunLoop.main.run()
