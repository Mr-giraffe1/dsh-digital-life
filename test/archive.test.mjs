import { crc32, zipRead, zipWrite } from '../packages/digital-life/lib/archive.js'

const failures = []
function check(name, ok, detail = '') {
  if (!ok) failures.push(name)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

// known CRC32 vector
check('CRC32 对 "123456789" 是 0xCBF43926', crc32(Buffer.from('123456789')) === 0xcbf43926, crc32(Buffer.from('123456789')).toString(16))

const binary = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255])
const archive = zipWrite([
  { name: 'manifest.json', data: '{"a":1}' },
  { name: 'portrait/soul.json', data: '{"name":"悠悠"}' },
  { name: 'portrait/voice.md', data: '# 悠悠怎么说话\n\n你看你看！\n' },
  { name: 'blob.bin', data: binary },
  { name: 'empty.txt', data: '' }
])

check('产出真实 ZIP 签名', archive.subarray(0, 4).toString('hex') === '504b0304', archive.subarray(0, 4).toString('hex'))
check('末尾有 EOCD', archive.subarray(archive.length - 22, archive.length - 18).toString('hex') === '504b0506')

const back = zipRead(archive)
check('成员数正确', back.size === 5, String(back.size))
check('文本成员一致', back.get('manifest.json').toString('utf8') === '{"a":1}')
check('中文成员一致', back.get('portrait/soul.json').toString('utf8') === '{"name":"悠悠"}')
check('换行完好', back.get('portrait/voice.md').toString('utf8').includes('\n\n你看你看！'))
check('二进制逐字节一致', Buffer.compare(back.get('blob.bin'), binary) === 0)
check('空成员可读', back.get('empty.txt').length === 0)

// 压缩真的发生了（长文本）
const redundant = '重复'.repeat(2000)
const big = zipWrite([{ name: 'big.txt', data: redundant }])
check('长文本比原文小', big.length < redundant.length, `${big.length} < ${redundant.length}`)
check('解压回得去', zipRead(big).get('big.txt').toString('utf8') === redundant)

// 损坏必须被发现，不能悄悄给出错数据
// 这个小成员会被原样存储（压缩不了），所以数据起点是确定的。
const one = zipWrite([{ name: 'x.bin', data: Buffer.from([1, 2, 3]) }])
const dataStart = 30 + Buffer.from('x.bin').length
const tampered = Buffer.from(one)
tampered[dataStart] = 9
let caught = false
try {
  zipRead(tampered)
} catch (error) {
  caught = String(error.message).includes('校验')
}
check('篡改会被校验拦下', caught)

let emptyCaught = false
try {
  zipRead(Buffer.from('not a zip at all'))
} catch {
  emptyCaught = true
}
check('不是归档时报错', emptyCaught)

const truncated = archive.subarray(0, 40)
let truncatedCaught = false
try {
  zipRead(truncated)
} catch {
  truncatedCaught = true
}
check('截断的归档报错', truncatedCaught)

// 反斜杠路径统一成正斜杠
const slashes = zipWrite([{ name: 'a\\b\\c.json', data: 'x' }])
check('路径分隔符统一', slashes.includes(Buffer.from('a/b/c.json')))

console.log(failures.length === 0 ? '\nall archive checks passed' : `\n${failures.length} failed: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
