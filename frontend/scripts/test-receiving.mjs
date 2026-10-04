import assert from 'node:assert'
import {
  listNotices,
  registerNotice,
  submitInspection,
  forceRelease,
  pendingInbound,
  findResumableBatch,
  addPhotoDrafts,
  runPhotoUploads,
  findNotice,
} from '../src/data/receiving-store'
import { evaluateBatch, planForLot } from '../src/data/receiving-policy'

let passed = 0
const ok = (name, cond) => {
  assert.ok(cond, name)
  passed++
  console.log('PASS', name)
}

// 1. 抽样方案查表
ok('60箱→字码F开箱13/Ac1Re2', planForLot(60).sampleSize === 13 && planForLot(60).accept === 1)
ok('120箱→字码G开箱20', planForLot(120).sampleSize === 20)
ok('3箱全检Ac0', planForLot(3).sampleSize === 2)

// 2. 隐裂抽中 1 箱 → 整批退换（AQL=0）
const crack = evaluateBatch({ boxCount: 60, openedBoxes: 13, classABadBoxes: 1, classBBadBoxes: 0 })
ok('隐裂1箱判整批退换', crack.verdict === 'rejected' && crack.reasons[0].includes('整批退换'))

// 3. B类在 Ac 内 → 合格
const good = evaluateBatch({ boxCount: 60, openedBoxes: 13, classABadBoxes: 0, classBBadBoxes: 1 })
ok('B类1箱合格放行', good.verdict === 'accepted')

// 4. B类 ≥ Re → 退换
const bad = evaluateBatch({ boxCount: 60, openedBoxes: 13, classABadBoxes: 0, classBBadBoxes: 2 })
ok('B类2箱整批退换', bad.verdict === 'rejected')

// 5. 开箱不足 → 结论未出
const short = evaluateBatch({ boxCount: 60, openedBoxes: 5, classABadBoxes: 0, classBBadBoxes: 0 })
ok('开箱不足结论未出', short.verdict === 'pending' && short.reasons.join().includes('开箱数不足'))

// 6. 存量老到货单按到货日期回填
const notices = listNotices()
const legacy = notices.find((n) => n.noticeNo === 'DN-OLD-0812-03')
ok('老单到货日期回填为登记日', legacy.arrivedAt === '2026-08-12' && legacy.backfilled === true)

// 7. 初始待入库清单：两张合格放行批，退换批/未出结论批不出现
const pending = pendingInbound()
ok('待入库仅含合格批', pending.length === 2)
ok('退换批不在待入库', !pending.some((p) => p.batchNo === 'B20260920-05'))
ok('待入库箱数=220', pending.reduce((s, i) => s + i.boxCount, 0) === 220)

// 8. 强行放行退换批被挡回并写明批次
const rejectNotice = listNotices().find((n) => n.noticeNo === 'DN-20260924-02')
const rejectBatch = rejectNotice.batches[0]
const forced = forceRelease(rejectNotice.id, rejectBatch.id)
ok('强行放行被挡', forced.ok === false && forced.message.includes(rejectBatch.batchNo))
const after = findNotice(rejectNotice.id)
ok('挡回留痕且写明批次', after.blockedAttempts.length >= 2 && after.blockedAttempts.at(-1).message.includes(rejectBatch.batchNo))

// 9. 同一张到货单重复提交只入库一次
const base = {
  noticeNo: 'DN-DUP-001',
  supplier: '供应商甲',
  moduleModel: 'M-550',
  boxCount: 100,
  arrivedAt: '2026-10-04',
  operator: '测试',
  batches: [{ batchNo: 'B1', boxCount: 60 }, { batchNo: 'B2', boxCount: 40 }],
}
const r1 = registerNotice(base)
const r2 = registerNotice({ ...base, supplier: '供应商乙' })
ok('首次登记成功', r1.ok === true)
ok('重复提交被挡', r2.ok === false && r2.message.includes('重复提交'))
const dupNotices = listNotices().filter((n) => n.noticeNo === 'DN-DUP-001')
ok('只生成一张到货单', dupNotices.length === 1)

// 10. 箱数对不上 → 拒收登记
const mismatch = registerNotice({ ...base, noticeNo: 'DN-MIS', boxCount: 101 })
ok('批次箱数与到货单不符被挡', mismatch.ok === false && mismatch.message.includes('对不上'))

// 11. 结论未出 → 批次不入库；照片未齐也不能出合格结论
const dup = dupNotices[0]
const b1 = dup.batches.find((b) => b.batchNo === 'B1')
const noPhoto = submitInspection({
  noticeId: dup.id, batchId: b1.id, openedBoxes: 13, classABadBoxes: 0, classBBadBoxes: 0, inspector: '测试',
})
ok('照片未齐不能出结论', noPhoto.ok === false && noPhoto.message.includes('照片未齐'))
ok('结论未出批不进待入库', !pendingInbound().some((p) => p.batchId === b1.id))

// 12. 照片断点续传：加到 B1 一批，中断后 findResumableBatch 仍是 B1
addPhotoDrafts(dup.id, b1.id, [
  { id: 'p1', name: 'a.jpg', dataUrl: 'x' },
  { id: 'p2', name: 'b.jpg', dataUrl: 'x' },
])
const resume = findResumableBatch(dup.id)
ok('断点定位到未传完的批次', resume.batchNo === 'B1')
const handle = runPhotoUploads(dup.id, b1.id, () => {})
handle.cancel()
const res = await handle.promise
ok('中断返回续传提示', res.ok === false && res.message.includes('续传'))
const partial = findNotice(dup.id).batches.find((b) => b.id === b1.id)
ok('中断后已传照片保留', partial.photos.some((p) => p.uploaded))
const resumeAgain = findResumableBatch(dup.id)
ok('续传仍从断掉的批次', resumeAgain.batchNo === 'B1')

console.log(`\n全部通过：${passed} 项`)
