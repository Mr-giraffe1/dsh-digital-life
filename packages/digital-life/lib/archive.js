/**
 * A minimal ZIP writer/reader — enough for `.dshlife`, no dependencies.
 *
 * Writes a real archive (local headers + central directory + EOCD) so the file
 * can be opened by 7-Zip or Explorer, not just by us. Reads by walking local
 * headers, which is what our own writer produces.
 */

import { deflateRawSync, inflateRawSync } from 'node:zlib'

/** CRC32 lookup table. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let value = i
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[i] = value >>> 0
  }
  return table
})()

/**
 * CRC32 of a buffer.
 *
 * @param {Buffer} buffer - bytes.
 * @returns {number} unsigned 32-bit checksum.
 */
export function crc32(buffer) {
  let crc = 0xffffffff
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** MS-DOS date/time pair for the archive members. */
function dosStamp(date) {
  const year = Math.max(1980, date.getFullYear())
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  }
}

/**
 * Build a ZIP archive.
 *
 * @param {Array<{ name: string, data: Buffer | string }>} entries - members.
 * @param {Date} [now] - timestamp written into every member.
 * @returns {Buffer} the archive bytes.
 */
export function zipWrite(entries, now = new Date()) {
  const stamp = dosStamp(now)
  const locals = []
  const central = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = Buffer.from(String(entry.name).replace(/\\/g, '/'), 'utf8')
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8')
    const deflated = deflateRawSync(raw, { level: 6 })
    const useDeflate = deflated.length < raw.length
    const body = useDeflate ? deflated : raw
    const method = useDeflate ? 8 : 0
    const checksum = crc32(raw)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(stamp.time, 10)
    local.writeUInt16LE(stamp.date, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)

    locals.push(local, nameBytes, body)
    central.push({ nameBytes, checksum, compressed: body.length, size: raw.length, method, offset })
    offset += 30 + nameBytes.length + body.length
  }

  const directory = []
  let directorySize = 0
  for (const item of central) {
    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(20, 6)
    header.writeUInt16LE(0x0800, 8)
    header.writeUInt16LE(item.method, 10)
    header.writeUInt16LE(stamp.time, 12)
    header.writeUInt16LE(stamp.date, 14)
    header.writeUInt32LE(item.checksum, 16)
    header.writeUInt32LE(item.compressed, 20)
    header.writeUInt32LE(item.size, 24)
    header.writeUInt16LE(item.nameBytes.length, 28)
    header.writeUInt16LE(0, 30)
    header.writeUInt16LE(0, 32)
    header.writeUInt16LE(0, 34)
    header.writeUInt16LE(0, 36)
    header.writeUInt32LE(0, 38)
    header.writeUInt32LE(item.offset, 42)
    directory.push(header, item.nameBytes)
    directorySize += 46 + item.nameBytes.length
  }

  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(central.length, 8)
  end.writeUInt16LE(central.length, 10)
  end.writeUInt32LE(directorySize, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...locals, ...directory, end])
}

/**
 * Read a ZIP archive produced by {@link zipWrite}.
 *
 * @param {Buffer} buffer - archive bytes.
 * @returns {Map<string, Buffer>} member bytes by name.
 */
export function zipRead(buffer) {
  const entries = new Map()
  let cursor = 0
  while (cursor + 30 <= buffer.length && buffer.readUInt32LE(cursor) === 0x04034b50) {
    const method = buffer.readUInt16LE(cursor + 8)
    const checksum = buffer.readUInt32LE(cursor + 14)
    const compressedSize = buffer.readUInt32LE(cursor + 18)
    const nameLength = buffer.readUInt16LE(cursor + 26)
    const extraLength = buffer.readUInt16LE(cursor + 28)
    const name = buffer.toString('utf8', cursor + 30, cursor + 30 + nameLength)
    const dataStart = cursor + 30 + nameLength + extraLength
    const body = buffer.subarray(dataStart, dataStart + compressedSize)
    if (dataStart + compressedSize > buffer.length) throw new Error(`归档被截断：${name}`)
    let raw
    if (method === 0) raw = Buffer.from(body)
    else if (method === 8) raw = inflateRawSync(body)
    else throw new Error(`不支持的压缩方式 ${method}：${name}`)
    if (crc32(raw) !== checksum) throw new Error(`校验失败（文件可能损坏）：${name}`)
    entries.set(name, raw)
    cursor = dataStart + compressedSize
  }
  if (entries.size === 0) throw new Error('这不是一个 .dshlife 归档，或者里面是空的')
  return entries
}
