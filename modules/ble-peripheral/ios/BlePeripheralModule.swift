import CoreBluetooth
import ExpoModulesCore

/// Minimal BLE peripheral: one service with a writable "inbox" characteristic
/// (peers write messages into it) and a readable "profile" characteristic
/// (peers read our handle from it). Advertises the service UUID + local name.
public class BlePeripheralModule: Module {
  private var delegate: PeripheralDelegate?

  public func definition() -> ModuleDefinition {
    Name("BlePeripheral")

    Events("onWrite", "onError")

    AsyncFunction("start") { (serviceUuid: String, inbox: String, profile: String, profileB64: String, localName: String, promise: Promise) in
      self.delegate?.stop()
      let d = PeripheralDelegate(
        service: CBUUID(string: serviceUuid),
        inbox: CBUUID(string: inbox),
        profile: CBUUID(string: profile),
        profileValue: Data(base64Encoded: profileB64) ?? Data(),
        localName: localName
      )
      d.onStarted = { error in
        if let error = error {
          promise.reject("E_START", error)
        } else {
          promise.resolve(nil)
        }
      }
      d.onWrite = { [weak self] device, data in
        self?.sendEvent("onWrite", ["device": device, "value": data.base64EncodedString()])
      }
      d.onError = { [weak self] message in
        self?.sendEvent("onError", ["message": message])
      }
      self.delegate = d
      d.begin()
    }.runOnQueue(.main)

    Function("setProfile") { (profileB64: String) in
      self.delegate?.profileValue = Data(base64Encoded: profileB64) ?? Data()
    }

    Function("stop") {
      self.delegate?.stop()
      self.delegate = nil
    }

    OnDestroy {
      self.delegate?.stop()
    }
  }
}

final class PeripheralDelegate: NSObject, CBPeripheralManagerDelegate {
  private let serviceUuid: CBUUID
  private let inboxUuid: CBUUID
  private let profileUuid: CBUUID
  private let localName: String
  private var manager: CBPeripheralManager?
  var profileValue: Data

  var onStarted: ((String?) -> Void)?
  var onWrite: ((String, Data) -> Void)?
  var onError: ((String) -> Void)?

  init(service: CBUUID, inbox: CBUUID, profile: CBUUID, profileValue: Data, localName: String) {
    self.serviceUuid = service
    self.inboxUuid = inbox
    self.profileUuid = profile
    self.profileValue = profileValue
    self.localName = localName
  }

  func begin() {
    manager = CBPeripheralManager(delegate: self, queue: nil)
  }

  func stop() {
    if manager?.isAdvertising == true {
      manager?.stopAdvertising()
    }
    manager?.removeAllServices()
    manager?.delegate = nil
    manager = nil
  }

  private func finishStart(_ error: String?) {
    onStarted?(error)
    onStarted = nil
  }

  func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
    switch peripheral.state {
    case .poweredOn:
      let inbox = CBMutableCharacteristic(
        type: inboxUuid,
        properties: [.write, .writeWithoutResponse],
        value: nil,
        permissions: [.writeable]
      )
      let profile = CBMutableCharacteristic(
        type: profileUuid,
        properties: [.read],
        value: nil,
        permissions: [.readable]
      )
      let service = CBMutableService(type: serviceUuid, primary: true)
      service.characteristics = [inbox, profile]
      peripheral.removeAllServices()
      peripheral.add(service)
    case .poweredOff:
      finishStart("Bluetooth is turned off")
      onError?("Bluetooth is turned off")
    case .unauthorized:
      finishStart("Bluetooth permission denied")
    case .unsupported:
      finishStart("This device does not support BLE peripheral mode")
    default:
      break
    }
  }

  func peripheralManager(_ peripheral: CBPeripheralManager, didAdd service: CBService, error: Error?) {
    if let error = error {
      finishStart(error.localizedDescription)
      return
    }
    peripheral.startAdvertising([
      CBAdvertisementDataServiceUUIDsKey: [serviceUuid],
      CBAdvertisementDataLocalNameKey: localName,
    ])
  }

  func peripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: Error?) {
    finishStart(error?.localizedDescription)
  }

  func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveRead request: CBATTRequest) {
    guard request.characteristic.uuid == profileUuid, request.offset <= profileValue.count else {
      peripheral.respond(to: request, withResult: .invalidOffset)
      return
    }
    request.value = profileValue.subdata(in: request.offset..<profileValue.count)
    peripheral.respond(to: request, withResult: .success)
  }

  func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
    // Long writes arrive as several requests with increasing offsets; stitch them.
    var buffers: [UUID: Data] = [:]
    for request in requests where request.characteristic.uuid == inboxUuid {
      guard let value = request.value else { continue }
      buffers[request.central.identifier, default: Data()].append(value)
    }
    for (central, data) in buffers {
      onWrite?(central.uuidString, data)
    }
    if let first = requests.first {
      peripheral.respond(to: first, withResult: .success)
    }
  }
}
