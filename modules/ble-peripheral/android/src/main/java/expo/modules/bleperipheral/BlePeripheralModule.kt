package expo.modules.bleperipheral

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.content.Context
import android.os.ParcelUuid
import android.util.Base64
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.ByteArrayOutputStream
import java.util.UUID

/**
 * Minimal BLE peripheral: one service with a writable "inbox" characteristic
 * (peers write messages into it) and a readable "profile" characteristic
 * (peers read our handle from it). Advertises the service UUID so scanners
 * can find us.
 */
@SuppressLint("MissingPermission")
class BlePeripheralModule : Module() {
  private var gattServer: BluetoothGattServer? = null
  private var advertiseCallback: AdvertiseCallback? = null
  private var inboxUuid: UUID? = null
  private var profileUuid: UUID? = null
  private var profileValue: ByteArray = ByteArray(0)
  private val preparedWrites = HashMap<String, ByteArrayOutputStream>()

  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("No React context")

  private val manager: BluetoothManager?
    get() = context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager?

  override fun definition() = ModuleDefinition {
    Name("BlePeripheral")

    Events("onWrite", "onError")

    AsyncFunction("start") { serviceUuid: String, inbox: String, profile: String, profileB64: String, _: String, promise: Promise ->
      stopInternal()
      val mgr = manager
      val adapter = mgr?.adapter
      if (mgr == null || adapter == null) {
        promise.reject("E_NO_BT", "Bluetooth not supported", null)
        return@AsyncFunction
      }
      if (!adapter.isEnabled) {
        promise.reject("E_BT_OFF", "Bluetooth is turned off", null)
        return@AsyncFunction
      }
      val advertiser = adapter.bluetoothLeAdvertiser
      if (advertiser == null) {
        promise.reject("E_NO_ADV", "This device cannot advertise over BLE", null)
        return@AsyncFunction
      }

      inboxUuid = UUID.fromString(inbox)
      profileUuid = UUID.fromString(profile)
      profileValue = Base64.decode(profileB64, Base64.NO_WRAP)

      val service = BluetoothGattService(UUID.fromString(serviceUuid), BluetoothGattService.SERVICE_TYPE_PRIMARY)
      service.addCharacteristic(
        BluetoothGattCharacteristic(
          inboxUuid,
          BluetoothGattCharacteristic.PROPERTY_WRITE or BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
          BluetoothGattCharacteristic.PERMISSION_WRITE
        )
      )
      service.addCharacteristic(
        BluetoothGattCharacteristic(
          profileUuid,
          BluetoothGattCharacteristic.PROPERTY_READ,
          BluetoothGattCharacteristic.PERMISSION_READ
        )
      )

      val server = mgr.openGattServer(context, gattCallback)
      if (server == null) {
        promise.reject("E_GATT", "Could not open GATT server", null)
        return@AsyncFunction
      }
      gattServer = server
      server.addService(service)

      val settings = AdvertiseSettings.Builder()
        .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
        .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
        .setConnectable(true)
        .setTimeout(0)
        .build()
      // A 128-bit UUID fills most of the 31-byte packet, so no device name here.
      val data = AdvertiseData.Builder()
        .setIncludeDeviceName(false)
        .addServiceUuid(ParcelUuid(UUID.fromString(serviceUuid)))
        .build()

      val callback = object : AdvertiseCallback() {
        override fun onStartSuccess(settingsInEffect: AdvertiseSettings?) {
          promise.resolve(null)
        }

        override fun onStartFailure(errorCode: Int) {
          promise.reject("E_ADV_FAIL", "Advertising failed (code $errorCode)", null)
        }
      }
      advertiseCallback = callback
      advertiser.startAdvertising(settings, data, callback)
    }

    Function("setProfile") { profileB64: String ->
      profileValue = Base64.decode(profileB64, Base64.NO_WRAP)
    }

    Function("stop") {
      stopInternal()
    }

    OnDestroy {
      stopInternal()
    }
  }

  private fun stopInternal() {
    try {
      advertiseCallback?.let { manager?.adapter?.bluetoothLeAdvertiser?.stopAdvertising(it) }
    } catch (_: Exception) {
    }
    advertiseCallback = null
    try {
      gattServer?.close()
    } catch (_: Exception) {
    }
    gattServer = null
    preparedWrites.clear()
  }

  private fun emitWrite(device: BluetoothDevice, value: ByteArray) {
    sendEvent(
      "onWrite",
      mapOf(
        "device" to device.address,
        "value" to Base64.encodeToString(value, Base64.NO_WRAP)
      )
    )
  }

  private val gattCallback = object : BluetoothGattServerCallback() {
    override fun onCharacteristicReadRequest(
      device: BluetoothDevice,
      requestId: Int,
      offset: Int,
      characteristic: BluetoothGattCharacteristic
    ) {
      val server = gattServer ?: return
      if (characteristic.uuid != profileUuid || offset > profileValue.size) {
        server.sendResponse(device, requestId, BluetoothGatt.GATT_INVALID_OFFSET, offset, null)
        return
      }
      server.sendResponse(
        device, requestId, BluetoothGatt.GATT_SUCCESS, offset,
        profileValue.copyOfRange(offset, profileValue.size)
      )
    }

    override fun onCharacteristicWriteRequest(
      device: BluetoothDevice,
      requestId: Int,
      characteristic: BluetoothGattCharacteristic,
      preparedWrite: Boolean,
      responseNeeded: Boolean,
      offset: Int,
      value: ByteArray
    ) {
      val server = gattServer ?: return
      if (characteristic.uuid != inboxUuid) {
        if (responseNeeded) server.sendResponse(device, requestId, BluetoothGatt.GATT_WRITE_NOT_PERMITTED, offset, null)
        return
      }
      if (preparedWrite) {
        preparedWrites.getOrPut(device.address) { ByteArrayOutputStream() }.write(value)
      } else {
        emitWrite(device, value)
      }
      if (responseNeeded) server.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value)
    }

    override fun onExecuteWrite(device: BluetoothDevice, requestId: Int, execute: Boolean) {
      val buffered = preparedWrites.remove(device.address)
      if (execute && buffered != null) emitWrite(device, buffered.toByteArray())
      gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
    }
  }
}
