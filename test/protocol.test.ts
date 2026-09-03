// Unit tests for the hand-rolled protobuf-like wire encoding/decoding helpers
// in JouleBleClient.ts. These are pure functions with no Bluetooth/DOM
// dependency, so they are tested directly and exhaustively here since they
// underpin every request/response exchanged with a real Joule.
import {
  bytesField,
  concat,
  decodeDataPoint,
  decodeFields,
  decodeMessage,
  field,
  fixed32Field,
  floatField,
  hexToKey,
  integerField,
  keyToHex,
  readVarint,
  tag,
  varint,
} from "../src/JouleBleClient"

describe("concat", () => {
  it("concatenates byte arrays in order", () => {
    const result = concat(new Uint8Array([1, 2]), new Uint8Array([]), new Uint8Array([3]))
    expect(Array.from(result)).toEqual([1, 2, 3])
  })

  it("returns an empty array when given nothing", () => {
    expect(Array.from(concat())).toEqual([])
  })
})

describe("varint / readVarint", () => {
  it.each([0, 1, 127, 128, 300, 16384, 2097151, 2097152, 0xffffffff])(
    "round-trips %p",
    (value) => {
      const encoded = varint(value)
      const { value: decoded, offset } = readVarint(encoded, 0)
      expect(decoded).toBe(value)
      expect(offset).toBe(encoded.length)
    },
  )

  it("encodes single-byte values as themselves", () => {
    expect(Array.from(varint(5))).toEqual([5])
  })

  it("sets the continuation bit on every byte but the last", () => {
    // 300 = 0b1_0010_1100 -> low 7 bits 0101100 with continuation, then 10
    expect(Array.from(varint(300))).toEqual([0xac, 0x02])
  })

  it("reads a varint starting at a nonzero offset without consuming preceding bytes", () => {
    const data = concat(new Uint8Array([0xff]), varint(300))
    const { value, offset } = readVarint(data, 1)
    expect(value).toBe(300)
    expect(offset).toBe(data.length)
  })

  it("throws on a truncated varint (continuation bit set but no more bytes)", () => {
    expect(() => readVarint(new Uint8Array([0x80]), 0)).toThrow("Truncated protobuf varint")
  })

  it("throws when a varint is implausibly long (corrupt data)", () => {
    const corrupt = new Uint8Array(10).fill(0x80)
    expect(() => readVarint(corrupt, 0)).toThrow("Invalid protobuf varint")
  })
})

describe("tag", () => {
  it("packs the field number and wire type as (fieldNumber << 3) | wireType", () => {
    expect(Array.from(tag(1, 0))).toEqual([0x08])
    expect(Array.from(tag(2, 2))).toEqual([0x12])
  })
})

describe("field encoders", () => {
  it("bytesField encodes a length-delimited field", () => {
    const encoded = bytesField(5, new Uint8Array([0xaa, 0xbb]))
    expect(Array.from(encoded)).toEqual([tag(5, 2)[0], 2, 0xaa, 0xbb])
  })

  it("integerField encodes a varint field", () => {
    const encoded = integerField(3, 300)
    expect(Array.from(encoded)).toEqual([tag(3, 0)[0], 0xac, 0x02])
  })

  it("floatField and fixed32Field both use wire type 5 (32-bit)", () => {
    expect(floatField(10, 1)[0]).toBe(tag(10, 5)[0])
    expect(fixed32Field(1, 42)[0]).toBe(tag(1, 5)[0])
  })

  it("floatField round-trips an IEEE-754 float32 value", () => {
    const encoded = floatField(10, 55.5)
    const view = new DataView(encoded.buffer, encoded.byteOffset + 1, 4)
    expect(view.getFloat32(0, true)).toBeCloseTo(55.5, 5)
  })

  it("fixed32Field round-trips a little-endian uint32 value", () => {
    const encoded = fixed32Field(1, 0x01020304)
    const view = new DataView(encoded.buffer, encoded.byteOffset + 1, 4)
    expect(view.getUint32(0, true)).toBe(0x01020304)
  })
})

describe("decodeFields", () => {
  it("decodes a mix of varint, 32-bit, and length-delimited fields", () => {
    const message = concat(
      integerField(1, 42),
      fixed32Field(2, 7),
      bytesField(3, new Uint8Array([9, 9])),
    )
    const fields = decodeFields(message)
    expect(fields).toEqual([
      { number: 1, wireType: 0, value: 42 },
      { number: 2, wireType: 5, value: new Uint8Array([7, 0, 0, 0]) },
      { number: 3, wireType: 2, value: new Uint8Array([9, 9]) },
    ])
  })

  it("throws on an unsupported wire type", () => {
    // wire type 3 (start group) is not implemented by this minimal decoder.
    const message = tag(1, 3)
    expect(() => decodeFields(message)).toThrow("Unsupported protobuf wire type 3")
  })

  it("returns an empty list for empty input", () => {
    expect(decodeFields(new Uint8Array(0))).toEqual([])
  })
})

describe("decodeDataPoint", () => {
  it("decodes feedId, sequenceNumber, bathTemp, programStep, and timeRemaining", () => {
    const raw = concat(
      integerField(1, 12345), // feedId
      integerField(2, 7), // sequenceNumber
      floatField(10, 60.25), // bathTemp
      integerField(11, 2), // programStep
      integerField(12, 900), // timeRemaining
    )
    const point = decodeDataPoint(raw)
    expect(point.feedId).toBe(12345)
    expect(point.sequenceNumber).toBe(7)
    expect(point.bathTemp).toBeCloseTo(60.25, 5)
    expect(point.programStep).toBe(2)
    expect(point.timeRemaining).toBe(900)
  })

  it("defaults every field to 0 when no recognized fields are present", () => {
    const point = decodeDataPoint(new Uint8Array(0))
    expect(point).toEqual({ bathTemp: 0, programStep: 0, timeRemaining: 0, feedId: 0, sequenceNumber: 0 })
  })

  it("ignores fields with mismatched wire types instead of misreading them", () => {
    // bathTemp (field 10) is normally 32-bit; feed it a varint instead and
    // confirm the decoder does not attempt to reinterpret it as a float.
    const raw = integerField(10, 5)
    const point = decodeDataPoint(raw)
    expect(point.bathTemp).toBe(0)
  })
})

describe("decodeMessage", () => {
  it("decodes a start-program reply result code", () => {
    const reply = bytesField(field.startProgramReply, integerField(1, 13))
    const message = decodeMessage(reply)
    expect(message.type).toBe(field.startProgramReply)
    expect(message.result).toBe(13)
  })

  it("decodes a stop-circulator reply result code", () => {
    const reply = bytesField(field.stopCirculatorReply, integerField(1, 0))
    const message = decodeMessage(reply)
    expect(message.type).toBe(field.stopCirculatorReply)
    expect(message.result).toBe(0)
  })

  it("decodes a key-exchange reply's key bytes and result using its distinct field numbers", () => {
    const key = new Uint8Array([1, 2, 3, 4])
    const reply = bytesField(field.startKeyExchangeReply, concat(bytesField(1, key), integerField(2, 0)))
    const message = decodeMessage(reply)
    expect(message.type).toBe(field.startKeyExchangeReply)
    expect(message.key).toEqual(key)
    expect(message.result).toBe(0)
  })

  it("decodes a circulator data point", () => {
    const point = integerField(1, 555) // feedId
    const reply = bytesField(field.circulatorDataPoint, point)
    const message = decodeMessage(reply)
    expect(message.type).toBe(field.circulatorDataPoint)
    expect(message.data.feedId).toBe(555)
  })

  it("decodes a describe-feed reply's current program setPoint and cookTime", () => {
    const program = concat(floatField(1, 60), integerField(2, 1800))
    const reply = bytesField(field.describeFeedReply, bytesField(2, program))
    const message = decodeMessage(reply)
    expect(message.type).toBe(field.describeFeedReply)
    expect(message.setPoint).toBeCloseTo(60, 5)
    expect(message.cookTime).toBe(1800)
  })

  it("returns an empty message for unrecognized field numbers", () => {
    const message = decodeMessage(integerField(999, 1))
    expect(message).toEqual({})
  })
})

describe("keyToHex / hexToKey", () => {
  it("round-trips arbitrary byte arrays through hex", () => {
    const key = new Uint8Array([0, 1, 15, 16, 255])
    expect(hexToKey(keyToHex(key))).toEqual(key)
  })

  it("keyToHex zero-pads each byte to two hex digits", () => {
    expect(keyToHex(new Uint8Array([0, 5, 255]))).toBe("0005ff")
  })

  it("hexToKey parses a hex string into the matching bytes", () => {
    expect(Array.from(hexToKey("0af0"))).toEqual([0x0a, 0xf0])
  })
})
