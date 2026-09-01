const JOULE_SERVICE_UUID = "700b4321-9836-4383-a2b2-31a9098d1473"
const WRITE_CHARACTERISTIC_UUID = "700b4322-9836-4383-a2b2-31a9098d1473"
const READ_CHARACTERISTIC_UUID = "700b4323-9836-4383-a2b2-31a9098d1473"
const SUBSCRIBE_CHARACTERISTIC_UUID = "700b4325-9836-4383-a2b2-31a9098d1473"
const GENERIC_ATTRIBUTE_SERVICE_UUID = "00001801-0000-1000-8000-00805f9b34fb"
const SERVICE_CHANGED_CHARACTERISTIC_UUID = "00002a05-0000-1000-8000-00805f9b34fb"
const AUTH_KEY_PREFIX = "chrome-joule-auth-key:"
const MANUFACTURER_DATA_STORAGE_KEY = "chrome-joule-manufacturer-data"
const JOULE_MANUFACTURER_ID = 0x0159

const field = {
  startProgramRequest: 50,
  startProgramReply: 51,
  stopCirculatorRequest: 60,
  stopCirculatorReply: 61,
  beginLiveFeedRequest: 70,
  circulatorDataPoint: 90,
  startKeyExchangeRequest: 120,
  startKeyExchangeReply: 121,
  submitKeyRequest: 130,
  submitKeyReply: 131,
  identifyCirculatorRequest: 152,
  describeFeedRequest: 95,
  describeFeedReply: 96,
}

export interface JouleData {
  bathTemp: number
  programStep: number
  timeRemaining: number
  feedId: number
  sequenceNumber: number
  setPoint?: number
  cookTime?: number
}

interface DecodedMessage {
  type?: number
  body?: Uint8Array
  data?: JouleData
  key?: Uint8Array
  result?: number
  setPoint?: number
  cookTime?: number
}

function concat(...values: Uint8Array[]) {
  const length = values.reduce((total, value) => total + value.length, 0)
  const result = new Uint8Array(length)
  let offset = 0
  values.forEach((value) => {
    result.set(value, offset)
    offset += value.length
  })
  return result
}

function varint(value: number) {
  const bytes: number[] = []
  while (value > 127) {
    bytes.push((value & 127) | 128)
    value = Math.floor(value / 128)
  }
  bytes.push(value)
  return new Uint8Array(bytes)
}

function tag(fieldNumber: number, wireType: number) {
  return varint((fieldNumber << 3) | wireType)
}

function bytesField(fieldNumber: number, value: Uint8Array) {
  return concat(tag(fieldNumber, 2), varint(value.length), value)
}

function integerField(fieldNumber: number, value: number) {
  return concat(tag(fieldNumber, 0), varint(value))
}

function floatField(fieldNumber: number, value: number) {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setFloat32(0, value, true)
  return concat(tag(fieldNumber, 5), bytes)
}

function fixed32Field(fieldNumber: number, value: number) {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, value, true)
  return concat(tag(fieldNumber, 5), bytes)
}

function readVarint(data: Uint8Array, offset: number) {
  let value = 0
  let shift = 0
  while (offset < data.length) {
    const byte = data[offset++]
    value += (byte & 127) * Math.pow(2, shift)
    if ((byte & 128) === 0) {
      return { value, offset }
    }
    shift += 7
    if (shift > 35) {
      throw new Error("Invalid protobuf varint")
    }
  }
  throw new Error("Truncated protobuf varint")
}

function decodeFields(data: Uint8Array) {
  const fields: Array<{ number: number, wireType: number, value: number | Uint8Array }> = []
  let offset = 0
  while (offset < data.length) {
    const decodedTag = readVarint(data, offset)
    offset = decodedTag.offset
    const wireType = decodedTag.value & 7
    const number = decodedTag.value >> 3
    let value: number | Uint8Array
    if (wireType === 0) {
      const decodedValue = readVarint(data, offset)
      value = decodedValue.value
      offset = decodedValue.offset
    } else if (wireType === 1) {
      value = data.slice(offset, offset + 8)
      offset += 8
    } else if (wireType === 2) {
      const decodedLength = readVarint(data, offset)
      offset = decodedLength.offset
      value = data.slice(offset, offset + decodedLength.value)
      offset += decodedLength.value
    } else if (wireType === 5) {
      value = data.slice(offset, offset + 4)
      offset += 4
    } else {
      throw new Error(`Unsupported protobuf wire type ${wireType}`)
    }
    fields.push({ number, wireType, value })
  }
  return fields
}

function randomHandle() {
  const values = new Uint32Array(1)
  crypto.getRandomValues(values)
  return values[0] || 1
}

function streamMessage(
  messageType: number,
  body = new Uint8Array(0),
  senderAddress = new Uint8Array(0),
  recipientAddress = new Uint8Array(0),
) {
  // Empty addresses are required by Joule's protobuf schema and match the mobile client.
  return concat(
    fixed32Field(1, randomHandle()),
    bytesField(5, senderAddress),
    bytesField(6, recipientAddress),
    bytesField(messageType, body),
  )
}

function decodeDataPoint(data: Uint8Array): JouleData {
  const point: JouleData = { bathTemp: 0, programStep: 0, timeRemaining: 0, feedId: 0, sequenceNumber: 0 }
  decodeFields(data).forEach((entry) => {
    if (entry.number === 1 && entry.wireType === 0) point.feedId = entry.value as number
    if (entry.number === 2 && entry.wireType === 0) point.sequenceNumber = entry.value as number
    if (entry.number === 10 && entry.wireType === 5) point.bathTemp = new DataView((entry.value as Uint8Array).buffer, (entry.value as Uint8Array).byteOffset, 4).getFloat32(0, true)
    if (entry.number === 11 && entry.wireType === 0) point.programStep = entry.value as number
    if (entry.number === 12 && entry.wireType === 0) point.timeRemaining = entry.value as number
  })
  return point
}

function decodeMessage(data: Uint8Array): DecodedMessage {
  const message: DecodedMessage = {}
  decodeFields(data).forEach((entry) => {
    if (entry.wireType !== 2 || typeof entry.value === "number") return
    if ([field.startKeyExchangeReply, field.submitKeyReply, field.startProgramReply, field.stopCirculatorReply].indexOf(entry.number) !== -1) {
      message.type = entry.number
      message.body = entry.value
      decodeFields(entry.value).forEach((replyField) => {
        if (entry.number === field.startKeyExchangeReply && replyField.number === 1 && replyField.wireType === 2) message.key = replyField.value as Uint8Array
        if (
          replyField.wireType === 0 &&
          ((entry.number === field.startKeyExchangeReply && replyField.number === 2) ||
            (entry.number !== field.startKeyExchangeReply && replyField.number === 1))
        ) message.result = replyField.value as number
      })
    } else if (entry.number === field.circulatorDataPoint) {
      message.type = entry.number
      message.data = decodeDataPoint(entry.value)
    } else if (entry.number === field.describeFeedReply) {
      message.type = entry.number
      decodeFields(entry.value).forEach((replyField) => {
        if (replyField.number === 2 && replyField.wireType === 2) {
          decodeFields(replyField.value as Uint8Array).forEach((programField) => {
            if (programField.number === 1 && programField.wireType === 5) {
              const value = programField.value as Uint8Array
              message.setPoint = new DataView(value.buffer, value.byteOffset, 4).getFloat32(0, true)
            }
            if (programField.number === 2 && programField.wireType === 0) {
              message.cookTime = programField.value as number
            }
          })
        }
      })
    }
  })
  return message
}

function keyToHex(key: Uint8Array) {
  return Array.prototype.map.call(key, (value: number) => (`0${value.toString(16)}`).slice(-2)).join("")
}

function hexToKey(value: string) {
  const bytes = new Uint8Array(value.length / 2)
  for (let index = 0; index < bytes.length; index++) bytes[index] = parseInt(value.substr(index * 2, 2), 16)
  return bytes
}

export default class JouleBleClient {
  private device: any
  private server: any
  private writeCharacteristic: any
  private readCharacteristic: any
  private subscribeCharacteristic: any
  private pendingReply: { type: number, resolve: (message: DecodedMessage) => void, reject: (reason: Error) => void } | null
  private dataListener: (data: JouleData) => void
  private authKey: Uint8Array | null
  private latestData: JouleData
  private readQueue: Promise<void> = Promise.resolve()
  private recipientAddresses: Uint8Array[] = []
  private currentSetPoint: number | null
  private startRequestInProgress = false
  private connected = false
  private statusListener: (status: string) => void
  private disconnectListener: () => void

  public setManufacturerData(value: string) {
    const normalized = value.trim().replace(/^0x/i, "").replace(/[^0-9a-f]/gi, "")
    if (normalized.length < 16 || normalized.length % 2 !== 0) {
      throw new Error("Manufacturer data must contain at least 8 complete bytes of hexadecimal data.")
    }

    this.recipientAddresses = []
    this.addRecipientAddress(hexToKey(normalized.slice(0, 16)))
    this.addRecipientAddress(hexToKey(normalized.slice(-16)))
    localStorage.setItem(MANUFACTURER_DATA_STORAGE_KEY, normalized)
  }

  public async connect(
    onStatus: (status: string) => void,
    onData: (data: JouleData) => void,
    onDisconnect: () => void,
  ) {
    const bluetooth = (navigator as any).bluetooth
    if (!bluetooth) throw new Error("Web Bluetooth is unavailable. Use Chrome on Windows with Bluetooth enabled.")

    this.dataListener = onData
    this.statusListener = onStatus
    this.disconnectListener = onDisconnect
    const savedManufacturerData = localStorage.getItem(MANUFACTURER_DATA_STORAGE_KEY)
    if (savedManufacturerData && this.recipientAddresses.length === 0) this.setManufacturerData(savedManufacturerData)
    onStatus("Choose your Joule from the Bluetooth picker.")
    this.device = await bluetooth.requestDevice({
      filters: [{ services: [JOULE_SERVICE_UUID] }],
      optionalServices: [GENERIC_ATTRIBUTE_SERVICE_UUID],
      optionalManufacturerData: [JOULE_MANUFACTURER_ID],
    })
    this.device.addEventListener("gattserverdisconnected", this.handleDisconnection)
    this.device.addEventListener("advertisementreceived", this.handleAdvertisement)
    try {
      await this.device.watchAdvertisements()
    } catch (error) {
      console.info("Joule advertiser data is unavailable on this Bluetooth adapter.", error)
    }
    onStatus("Connecting to Joule...")
    this.server = await this.device.gatt.connect()
    this.connected = true
    const service = await this.server.getPrimaryService(JOULE_SERVICE_UUID)
    this.writeCharacteristic = await service.getCharacteristic(WRITE_CHARACTERISTIC_UUID)
    this.readCharacteristic = await service.getCharacteristic(READ_CHARACTERISTIC_UUID)
    this.subscribeCharacteristic = await service.getCharacteristic(SUBSCRIBE_CHARACTERISTIC_UUID)

    try {
      const genericAttribute = await this.server.getPrimaryService(GENERIC_ATTRIBUTE_SERVICE_UUID)
      const serviceChanged = await genericAttribute.getCharacteristic(SERVICE_CHANGED_CHARACTERISTIC_UUID)
      await serviceChanged.startNotifications()
    } catch (error) {
      console.info("Service Changed indications are unavailable on this Bluetooth adapter.", error)
    }

    this.subscribeCharacteristic.addEventListener("characteristicvaluechanged", this.handleNotification)
    await this.subscribeCharacteristic.startNotifications()
    await this.processMessage(await this.readCharacteristic.readValue())

    const storageKey = AUTH_KEY_PREFIX + this.device.id
    const savedKey = localStorage.getItem(storageKey)
    if (savedKey) {
      onStatus("Authorizing Joule...")
      this.authKey = hexToKey(savedKey)
      await this.submitKey()
    } else {
      onStatus("Press the button on top of your Joule within 60 seconds to pair.")
      const keyReply = await this.sendAndWait(streamMessage(field.startKeyExchangeRequest), field.startKeyExchangeReply, 60000)
      if (!keyReply.key || keyReply.result !== 0) throw new Error("Joule key exchange was rejected.")
      this.authKey = keyReply.key
      localStorage.setItem(storageKey, keyToHex(this.authKey))
      await this.submitKey()
    }

    await this.startLiveFeed(true)
    await this.loadCurrentProgram()
    onStatus("Connected to Joule.")
  }

  public async startProgram(setPoint: number, cookTime: number) {
    this.requireConnection()
    if (this.startRequestInProgress) throw new Error("Joule is already processing a cook request.")
    this.startRequestInProgress = true
    try {
      await this.startLiveFeed(true)
      await this.write(streamMessage(field.identifyCirculatorRequest))
      await this.delay(500)
      await this.readResponse()

      const compactProgram = concat(
        floatField(1, setPoint),
        integerField(5, 0),
      )
      const requestFor = (program: Uint8Array) => concat(
        bytesField(1, program),
        this.latestData ? integerField(2, this.latestData.feedId) : new Uint8Array(0),
        this.latestData ? integerField(3, this.latestData.sequenceNumber) : new Uint8Array(0),
      )

      if (cookTime > 0) {
        const timedProgram = concat(floatField(1, setPoint), integerField(2, cookTime), integerField(5, 0))
        const timedReply = await this.sendAndWait(
          streamMessage(field.startProgramRequest, requestFor(timedProgram)),
          field.startProgramReply,
          10000,
        )
        console.debug("Joule timed start response", { result: timedReply.result, cookTime })
        if (timedReply.result === 0) return this.recordStartedProgram(setPoint, true)
      }

      const compactReply = await this.sendAndWait(
        streamMessage(field.startProgramRequest, requestFor(compactProgram)),
        field.startProgramReply,
        10000,
      )
      console.debug("Joule compact start response", {
        result: compactReply.result,
        feedId: this.latestData && this.latestData.feedId,
        sequenceNumber: this.latestData && this.latestData.sequenceNumber,
      })
      if (compactReply.result === 0) return this.recordStartedProgram(setPoint, false)

      const fullProgram = concat(
        compactProgram,
        bytesField(6, bytesField(4, new TextEncoder().encode(this.cookId()))),
        integerField(7, 0),
      )
      const fullReply = await this.sendAndWait(
        streamMessage(field.startProgramRequest, requestFor(fullProgram)),
        field.startProgramReply,
        10000,
      )
      console.debug("Joule full start response", { result: fullReply.result })
      if (fullReply.result === 0) return this.recordStartedProgram(setPoint, false)

      if (this.recipientAddresses.length === 0) {
        throw new Error(`Joule rejected the cook request (result ${fullReply.result}). Its Bluetooth address was not available for the final compatibility attempt.`)
      }

      let addressResult: number
      for (const recipientAddress of this.recipientAddresses) {
        const addressReply = await this.sendAndWait(
          streamMessage(
            field.startProgramRequest,
            requestFor(fullProgram),
            hexToKey("aabbaabbaabbaabb"),
            recipientAddress,
          ),
          field.startProgramReply,
          10000,
        )
        console.debug("Joule address-aware start response", {
          result: addressReply.result,
          recipientAddress: keyToHex(recipientAddress),
        })
        if (addressReply.result === 0) return this.recordStartedProgram(setPoint, false)
        addressResult = addressReply.result
      }
      throw new Error(`Joule rejected the cook request (result ${addressResult}).`)
    } finally {
      this.startRequestInProgress = false
    }
  }

  public async stopProgram() {
    this.requireConnection()
    const reply = await this.sendAndWait(streamMessage(field.stopCirculatorRequest), field.stopCirculatorReply, 10000)
    if (reply.result !== 0) throw new Error(`Joule rejected the stop request (result ${reply.result}).`)
    if (this.latestData) {
      this.latestData = { ...this.latestData, programStep: 0, timeRemaining: 0 }
      this.dataListener && this.dataListener(this.latestData)
    }
  }

  public async refreshLiveData() {
    this.requireConnection()
    if (this.startRequestInProgress) return
    await this.startLiveFeed()
  }

  public async setTimer(cookTime: number) {
    if (this.currentSetPoint === null) throw new Error("Set a target temperature before adding a timer.")
    await this.stopProgram()
    await this.delay(500)
    return this.startProgram(this.currentSetPoint, cookTime)
  }

  public async updateSetPoint(setPoint: number, cookTime: number) {
    this.requireConnection()
    await this.stopProgram()
    await this.delay(500)
    return this.startProgram(setPoint, cookTime)
  }

  public disconnect() {
    this.handleDisconnection()
    if (this.server && this.server.connected) this.server.disconnect()
  }

  private handleNotification = async (event: any) => {
    if (!this.connected) return
    if (event.target.value.byteLength > 0) {
      try {
        await this.processMessage(event.target.value)
      } catch (error) {
        // Notifications can be a partial data-ready signal; 4323 contains the complete response.
      }
    }

    this.readQueue = this.readQueue
      .then(async () => {
        if (this.connected) await this.processMessage(await this.readCharacteristic.readValue())
      })
      .catch((error) => {
        if (this.connected) console.warn("Could not read Joule response from the data characteristic.", error)
      })
    await this.readQueue
  }

  private handleAdvertisement = (event: any) => {
    const value = event.manufacturerData && event.manufacturerData.get(JOULE_MANUFACTURER_ID)
    if (value && value.byteLength >= 8) {
      const data = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      this.addRecipientAddress(data.slice(0, 8))
      this.addRecipientAddress(data.slice(-8))
    }
  }

  private addRecipientAddress(address: Uint8Array) {
    if (!this.recipientAddresses.some((candidate) => keyToHex(candidate) === keyToHex(address))) {
      this.recipientAddresses.push(address)
    }
  }

  private recordStartedProgram(setPoint: number, timed: boolean) {
    this.currentSetPoint = setPoint
    return timed
  }

  private async processMessage(value: DataView) {
    if (!value || value.byteLength === 0) return
    const message = decodeMessage(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
    if (message.data) {
      this.latestData = message.data
      this.dataListener && this.dataListener(message.data)
    }
    if (this.pendingReply && message.type === this.pendingReply.type) {
      const pending = this.pendingReply
      this.pendingReply = null
      pending.resolve(message)
    }
  }

  private async readResponse() {
    this.readQueue = this.readQueue
      .then(async () => {
        if (this.connected) await this.processMessage(await this.readCharacteristic.readValue())
      })
      .catch((error) => {
        if (this.connected) console.warn("Could not read Joule response from the data characteristic.", error)
      })
    await this.readQueue
  }

  private handleDisconnection = () => {
    if (!this.connected) return
    this.connected = false
    this.startRequestInProgress = false
    if (this.pendingReply) {
      const pending = this.pendingReply
      this.pendingReply = null
      pending.reject(new Error("Joule disconnected before it responded."))
    }
    this.statusListener && this.statusListener("Disconnected from Joule.")
    this.disconnectListener && this.disconnectListener()
  }

  private async submitKey() {
    const reply = await this.sendAndWait(
      streamMessage(field.submitKeyRequest, bytesField(1, this.authKey)),
      field.submitKeyReply,
      10000,
    )
    if (reply.result !== 0) throw new Error("Joule rejected its saved pairing key. Remove and pair the device again.")
  }

  private async startLiveFeed(waitForFreshData = false) {
    const sequenceNumber = this.latestData && this.latestData.sequenceNumber
    await this.write(streamMessage(field.beginLiveFeedRequest, integerField(1, 1)))
    if (waitForFreshData) {
      await this.waitForData(sequenceNumber, 3000)
    } else {
      await this.delay(500)
    }
  }

  private async loadCurrentProgram() {
    if (!this.latestData || [1, 2, 3].indexOf(this.latestData.programStep) === -1) return
    const reply = await this.sendAndWait(
      streamMessage(field.describeFeedRequest, integerField(1, this.latestData.feedId)),
      field.describeFeedReply,
      10000,
    )
    if (reply.setPoint === undefined) return
    this.currentSetPoint = reply.setPoint
    this.latestData = { ...this.latestData, setPoint: reply.setPoint, cookTime: reply.cookTime }
    this.dataListener && this.dataListener(this.latestData)
  }

  private async sendAndWait(payload: Uint8Array, expectedType: number, timeout: number) {
    if (this.pendingReply) throw new Error("Joule is already processing a command.")
    const reply = new Promise<DecodedMessage>((resolve, reject) => {
      this.pendingReply = { type: expectedType, resolve, reject }
      window.setTimeout(() => {
        if (this.pendingReply && this.pendingReply.type === expectedType) {
          this.pendingReply = null
          reject(new Error("Joule did not respond before the request timed out."))
        }
      }, timeout)
    })
    await this.write(payload)
    return reply
  }

  private async write(payload: Uint8Array) {
    this.requireConnection()
    if (this.writeCharacteristic.writeValueWithResponse) {
      await this.writeCharacteristic.writeValueWithResponse(payload)
    } else {
      await this.writeCharacteristic.writeValue(payload)
    }
  }

  private requireConnection() {
    if (!this.connected || !this.server || !this.server.connected) throw new Error("Connect to your Joule first.")
  }

  private delay(milliseconds: number) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds))
  }

  private async waitForData(previousSequenceNumber: number, timeout: number) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (this.latestData && this.latestData.sequenceNumber !== previousSequenceNumber) return
      await this.delay(100)
    }
  }

  private cookId() {
    return "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx".replace(/x/g, () => Math.floor(Math.random() * 16).toString(16))
  }
}
