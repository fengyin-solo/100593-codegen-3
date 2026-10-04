// 端到端验证：用内存版 localStorage 跑通到货验收全部关键约束。
// 运行：node scripts/verify-arrival.mjs（脚本用 esbuild 把 TS 源码临时打包后自测）
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import esbuild from 'esbuild'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const bundlePath = path.join(here, '.tmp-arrival-bundle.mjs')

await esbuild.build({
  stdin: {
    contents: "export * from '@/api/acceptance-rules'\nexport * from '@/api/arrival-service'\n",
    resolveDir: root,
    sourcefile: 'virtual.ts',
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  write: true,
  outfile: bundlePath,
  alias: { '@': path.resolve(root, 'src') },
})

const store = new Map()
globalThis.window = {
  localStorage: {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => void store.set(key, value),
    removeItem: (key) => void store.delete(key),
  },
}
globalThis.localStorage = globalThis.window.localStorage

const rules = await import(pathToFileURL(bundlePath).href)
let passed = 0
function check(name, cond, detail = '') {
  assert.ok(cond, `${name} ${detail}`)
  passed += 1
  console.log(`✓ ${name}`)
}
process.on('exit', () => rmSync(bundlePath, { force: true }))

// 1) 抽样口径：GB/T 2828.1 水平 II / AQL=2.5 的若干批量
check('25 箱 → 字码 D 抽 5 箱 Ac=0', planMatch(rules.samplingPlan(25), 'D', 5, 0))
check('60 箱 → 字码 F 抽 20 箱 Ac=1', planMatch(rules.samplingPlan(60), 'F', 20, 1))
check('150 箱 → 字码 G 抽 32 箱 Ac=2', planMatch(rules.samplingPlan(150), 'G', 32, 2))
check('3 箱 → 全检 3 箱 Ac=0', planMatch(rules.samplingPlan(3), 'B', 3, 0))

// 2) 致命缺陷（隐裂）一票否决，一般缺陷 ≤Ac 放行
const p20 = rules.samplingPlan(20)
check('20 箱抽 5 箱 Ac=0（D 字码箭头引用 C 方案）', planMatch(p20, 'D', 5, 0))
check('隐裂 1 箱 → 整批退换', rules.evaluateBatch(p20, 1, 0).conclusion === '整批退换')
check('一般 1 箱（Ac=0，批量20抽5）→ 整批退换', rules.evaluateBatch(p20, 0, 1).conclusion === '整批退换')
const p60 = rules.samplingPlan(60)
check('一般 1 箱（Ac=1）→ 合格放行', rules.evaluateBatch(p60, 0, 1).conclusion === '合格放行')
check('一般 2 箱（Re=2）→ 整批退换', rules.evaluateBatch(p60, 0, 2).conclusion === '整批退换')

// 3) 种子数据：三张存量到货单，缺日期的那张已被回填
let arrivals = rules.listArrivals()
check('存量到货单 3 张（按到货日期倒序）', arrivals.length === 3)
check('老数据按到货日期回填 2026-09', String(arrivals[2]['到货日期']).startsWith('2026-09-'))
check('回填后已落盘', store.get('pv-plant-ops:entries').includes('到货日期'))

// 4) 登记一张新单：两批 30+30
const reg = rules.registerArrival({
  arrivalNo: 'ASN-TEST-01',
  supplier: '测试厂商',
  moduleModel: 'TEST-M-600',
  declaredBoxes: 60,
  receivedBoxes: 60,
  piecesPerBox: 36,
  arrivalDate: '2026-10-04',
  batchBoxes: [30, 30],
})
check('登记成功', reg.ok, reg.message)
const arrivalId = reg.data
const batches = () => rules.listBatchesByArrival(arrivalId)
check('拆成 2 个批次，各 30 箱', batches().length === 2 && batches()[0]['箱数'] === 30)

// 5) 同一张到货单重复提交：只入库一次
const dup = rules.registerArrival({
  arrivalNo: 'ASN-TEST-01',
  supplier: '测试厂商',
  moduleModel: 'TEST-M-600',
  declaredBoxes: 60,
  receivedBoxes: 60,
  piecesPerBox: 36,
  arrivalDate: '2026-10-04',
  batchBoxes: [30, 30],
})
check('重复提交被识别为重复', dup.ok === false && dup.duplicated === true)
check('没有多生成到货单', rules.listArrivals().length === 4)
check('没有多生成批次', rules.listBatchesByArrival(arrivalId).length === 2)

// 6) 批次箱数合计 ≠ 实收：拒绝登记
const bad = rules.registerArrival({
  arrivalNo: 'ASN-TEST-02', supplier: 'x', moduleModel: 'y',
  declaredBoxes: 10, receivedBoxes: 10, piecesPerBox: 36,
  arrivalDate: '2026-10-04', batchBoxes: [6, 3],
})
check('批次合计与实收不符 → 拒绝', bad.ok === false)

// 7) 照片没传完不能出结论
const b1 = batches()[0]
const noPhoto = rules.submitInspection({ batchId: Number(b1.id), inspectedBoxes: 5, criticalBoxes: 0, generalBoxes: 0, note: '' })
check('照片未传完挡结论', noPhoto.ok === false && noPhoto.message.includes('照片'))

// 8) 断点续传：加 2 张，第 2 张中断；resumePoint 指回这个批次
const add = rules.appendInspectionPhotos(Number(b1.id), [
  { name: 'a.jpg', size: 1 }, { name: 'b.jpg', size: 2 },
])
check('追加 2 张照片', add.ok)
rules.reportPhotoProgress(Number(b1.id), add.data[0].id, '已完成')
rules.reportPhotoProgress(Number(b1.id), add.data[1].id, '中断')
const point = rules.resumePoint(arrivalId)
check('断点定位到第 1 批、剩 1 张', point && point.batchId === Number(b1.id) && point.pending === 1)
// 把断点那批传完
rules.reportPhotoProgress(Number(b1.id), add.data[1].id, '已完成')

// 9) 实抽箱数不符（30 箱应抽 5 箱）→ 拒绝
const wrongCount = rules.submitInspection({ batchId: Number(b1.id), inspectedBoxes: 4, criticalBoxes: 0, generalBoxes: 0, note: '' })
check('实抽箱数不符挡结论', wrongCount.ok === false)

// 10) 第 1 批合格放行；第 2 批隐裂整批退换（模拟题目里的隐裂批次）
const ok1 = rules.submitInspection({ batchId: Number(b1.id), inspectedBoxes: 5, criticalBoxes: 0, generalBoxes: 0, note: '' })
check('B1 提交合格', ok1.ok, ok1.message)

const b2 = batches()[1]
rules.appendInspectionPhotos(Number(b2.id), [{ name: 'c.jpg', size: 3 }])
const c = rules.listBatchesByArrival(arrivalId).find((row) => Number(row.id) === Number(b2.id))
const photos2 = JSON.parse(c['抽检照片'])
rules.reportPhotoProgress(Number(b2.id), photos2[0].id, '已完成')
const crack = rules.submitInspection({ batchId: Number(b2.id), inspectedBoxes: 5, criticalBoxes: 1, generalBoxes: 0, note: 'EL 图像隐裂 2 块' })
check('隐裂批次被判整批退换', crack.ok && crack.message.includes('整批退换'))
check('到货单进入待放行（不是直接入库）', rules.listArrivals().find((r) => r.id === arrivalId).status === '待放行')

// 11) 放行：只把合格的 30 箱计入待入库；退换 30 箱不计
const rel = rules.releaseArrival(arrivalId)
check('放行成功', rel.ok, rel.message)
const after = rules.listArrivals().find((r) => r.id === arrivalId)
check('待入库片数 = 30 箱 × 36 = 1080', Number(after['待入库片数']) === 1080)
const pending = rules.listPendingInbound()
check('备品备件待入库清单读到同一数字', pending.some((item) => item.arrivalId === arrivalId && item.pieces === 1080))
check('待入库合计 1080（两处口径一致）', rules.pendingInboundPieces() === 1080)

// 12) 重复放行不会第二次加量
const rel2 = rules.releaseArrival(arrivalId)
check('重复放行幂等', rel2.ok && rules.pendingInboundPieces() === 1080)

// 13) 入库确认：spare 台账加 1080；重复确认不再加
const beforeStock = spareStock('TEST-M-600')
const conf = rules.confirmInbound(arrivalId)
check('确认入库成功', conf.ok, conf.message)
check('备件台账增加 1080', spareStock('TEST-M-600') - beforeStock === 1080)
const conf2 = rules.confirmInbound(arrivalId)
check('重复确认入库幂等（仍是 1080）', conf2.ok && rules.pendingInboundPieces() === 0 && spareStock('TEST-M-600') - beforeStock === 1080)

// 14) 箱数不符但批次都已合格 → 仍要挡回（构造一张实收与单据不符的单）
const regMM = rules.registerArrival({
  arrivalNo: 'ASN-TEST-MM', supplier: 's2', moduleModel: 'm2',
  declaredBoxes: 20, receivedBoxes: 22, piecesPerBox: 36,
  arrivalDate: '2026-10-04', batchBoxes: [22],
})
const mmId = regMM.data
const mmBatch = rules.listBatchesByArrival(mmId)[0]
rules.appendInspectionPhotos(Number(mmBatch.id), [{ name: 'x.jpg', size: 1 }])
let mmRow = rules.listBatchesByArrival(mmId)[0]
rules.reportPhotoProgress(Number(mmRow.id), JSON.parse(mmRow['抽检照片'])[0].id, '已完成')
const mmSubmit = rules.submitInspection({ batchId: Number(mmRow.id), inspectedBoxes: 5, criticalBoxes: 0, generalBoxes: 0, note: '' })
check('箱数不符单的批次本身可出合格结论', mmSubmit.ok, mmSubmit.message)
const guardBox = rules.checkRelease(mmId)
check('箱数不符挡回放行', guardBox.allowed === false && guardBox.boxMismatch === true && guardBox.message.includes('对不上'))
check('箱数不符时 release 也被挡', rules.releaseArrival(mmId).ok === false)

// 15) 结论没出齐强行放行 → 挡回并指出批次（种子单 id=3 同时是箱数不符，但未出结论优先报批次）
const reg2 = rules.registerArrival({
  arrivalNo: 'ASN-TEST-03', supplier: 's', moduleModel: 'm',
  declaredBoxes: 12, receivedBoxes: 12, piecesPerBox: 36,
  arrivalDate: '2026-10-04', batchBoxes: [6, 6],
})
const id2 = reg2.data
const guardOpen = rules.checkRelease(id2)
check('未出结论挡回并写明批次', guardOpen.allowed === false && guardOpen.blockedBatches.length === 2 && guardOpen.message.includes('B1'))
check('直接 release 同样被挡', rules.releaseArrival(id2).ok === false)
check('挡住时不产生待入库', !rules.listPendingInbound().some((item) => item.arrivalId === id2))

// 16) 种子单 id=2：一批合格一批隐裂退，放行后只有 25 箱（900 片）入待入库
const relSeed2 = rules.releaseArrival(2)
check('混合结论单放行', relSeed2.ok, relSeed2.message)
const seed2 = rules.listArrivals().find((r) => r.id === 2)
check('隐裂批不计入：待入库 25×36=900', Number(seed2['待入库片数']) === 900)

console.log(`\n全部 ${passed} 项校验通过`)
rmSync(bundlePath, { force: true })

function planMatch(got, letter, sample, ac) {
  return got.codeLetter === letter &&
    got.sampleSize === sample &&
    got.acceptNumber === ac &&
    got.rejectNumber === ac + 1 &&
    got.aql === 2.5 &&
    got.fullInspection === (sample >= got.lotSize)
}
function spareStock(model) {
  const raw = JSON.parse(store.get('pv-plant-ops:entries'))
  const row = raw.spare.find((item) => item['规格型号'] === model)
  return row ? Number(row['现有数量']) : 0
}
