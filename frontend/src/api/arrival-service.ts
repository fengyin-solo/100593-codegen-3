/**
 * 到货验收领域服务：到货单登记 → 按批次开箱抽检 → 放行判定 → 同步备品备件待入库。
 * 页面组件只渲染与收集输入，所有业务判断（抽样、放行拦截、入库数量）都在这一层。
 *
 * 两块读「入库数量」共用同一来源：
 *  - 备品备件「待入库清单」直接从到货验收已放行未入库的记录推导，不另存一份；
 *  - 仓库确认入库时才把片数累加进备品备件台账。
 */
import { samplingPlan, evaluateBatch, type InspectionPlan } from '@/api/acceptance-rules'
import { ARRIVAL_BATCH_KEY, ARRIVAL_KEY } from '@/data/keys'
import { listRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

const BATCH_KEY = ARRIVAL_BATCH_KEY

export const ARRIVAL_STATUSES = ['已登记', '抽检中', '待放行', '已放行', '整批退换', '已入库'] as const
export const BATCH_STATUSES = ['待开箱', '抽检中', '合格放行', '整批退换'] as const

export type ArrivalRegisterInput = {
  arrivalNo: string
  supplier: string
  moduleModel: string
  declaredBoxes: number
  receivedBoxes: number
  piecesPerBox: number
  arrivalDate: string
  batchBoxes: number[]
}

export type InspectionPhoto = {
  id: number
  name: string
  size: number
  status: '上传中' | '已完成' | '中断'
  uploadedAt?: string
}

export type ServiceResult<T = number> = ActionResult & { duplicated?: boolean; data?: T }

function todayISO(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function nowStamp(): string {
  return new Date().toLocaleString('zh-CN', { hour12: false })
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function readArrivals(): EntryRow[] {
  return listRows(ARRIVAL_KEY)
}

function readBatches(): EntryRow[] {
  return listRows(BATCH_KEY)
}

function writeBatches(rows: EntryRow[]): void {
  saveRows(BATCH_KEY, rows)
}

function findArrival(arrivals: EntryRow[], id: number): EntryRow | undefined {
  return arrivals.find((row) => Number(row.id) === id)
}

function parsePhotos(row: EntryRow): InspectionPhoto[] {
  const raw = row['抽检照片']
  if (typeof raw !== 'string' || raw.trim() === '') {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as InspectionPhoto[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writePhotos(row: EntryRow, photos: InspectionPhoto[]): void {
  row['抽检照片'] = JSON.stringify(photos)
  const completed = photos.filter((item) => item.status === '已完成').length
  const unfinished = photos.some((item) => item.status !== '已完成')
  row['已传照片数'] = completed
  row['照片完成'] = completed > 0 && !unfinished
}

/** 到货单列表，按到货日期从新到旧 */
export function listArrivals(filters: Record<string, string> = {}): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  return readArrivals()
    .filter((row) => pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())))
    .slice()
    .sort((a, b) => String(b['到货日期']).localeCompare(String(a['到货日期'])))
}

export function listBatchesByArrival(arrivalId: number): EntryRow[] {
  return readBatches()
    .filter((row) => Number(row['到货单ID']) === arrivalId)
    .slice()
    .sort((a, b) => Number(a['批次序号']) - Number(b['批次序号']))
}

export function batchPhotoSummary(row: EntryRow): {
  completed: number
  interrupted: number
  uploading: number
  finished: boolean
} {
  const photos = parsePhotos(row)
  return {
    completed: photos.filter((item) => item.status === '已完成').length,
    interrupted: photos.filter((item) => item.status === '中断').length,
    uploading: photos.filter((item) => item.status === '上传中').length,
    finished: Boolean(row['照片完成']),
  }
}

/**
 * 依据批次结论重算到货单状态（只自动推进到「待放行」，放行与入库必须走显式动作）。
 * 已放行/已入库的单据不回退。
 */
function recomputeArrival(arrival: EntryRow, batches: EntryRow[], allArrivals: EntryRow[]): void {
  const current = String(arrival.status)
  if (current === '已放行' || current === '已入库') {
    return
  }
  const own = batches.filter((row) => Number(row['到货单ID']) === Number(arrival.id))
  const openCount = own.filter((row) => !['合格放行', '整批退换'].includes(String(row.status))).length
  if (openCount === own.length && own.every((row) => String(row.status) === '待开箱')) {
    arrival.status = '已登记'
  } else if (openCount > 0) {
    arrival.status = '抽检中'
  } else if (own.every((row) => String(row.status) === '整批退换')) {
    arrival.status = '整批退换'
    arrival.pending = false
  } else {
    arrival.status = '待放行'
    arrival.pending = true
  }
  saveRows(ARRIVAL_KEY, allArrivals)
}

/** 登记到货单并按批拆分箱数；同到货单号重复提交不会生成第二张单 */
export function registerArrival(input: ArrivalRegisterInput): ServiceResult {
  const arrivalNo = input.arrivalNo.trim()
  const supplier = input.supplier.trim()
  const moduleModel = input.moduleModel.trim()
  const declaredBoxes = Math.floor(input.declaredBoxes)
  const receivedBoxes = Math.floor(input.receivedBoxes)
  const piecesPerBox = Math.floor(input.piecesPerBox)
  const arrivalDate = input.arrivalDate || todayISO()

  if (!arrivalNo || !supplier || !moduleModel) {
    return { ok: false, message: '到货单号、供应商、组件型号都不能为空' }
  }
  if (declaredBoxes <= 0 || receivedBoxes <= 0 || piecesPerBox <= 0) {
    return { ok: false, message: '箱数与每箱片数必须是正整数' }
  }
  const batchBoxes = input.batchBoxes.map((value) => Math.floor(value)).filter((value) => value > 0)
  if (batchBoxes.length === 0) {
    return { ok: false, message: '至少登记一个批次，并填写每批箱数' }
  }
  const batchTotal = batchBoxes.reduce((sum, value) => sum + value, 0)
  if (batchTotal !== receivedBoxes) {
    return { ok: false, message: `各批次箱数合计 ${batchTotal} 与实收箱数 ${receivedBoxes} 不一致，按实收箱数拆批后再登记` }
  }

  const arrivals = readArrivals()
  const existing = arrivals.find((row) => String(row['到货单号']) === arrivalNo)
  if (existing) {
    return {
      ok: false,
      duplicated: true,
      data: Number(existing.id),
      message: `到货单 ${arrivalNo} 已登记（编号 ${existing.id}），重复提交未再生成入库，请到原单继续验收`,
    }
  }

  const arrivalId = nextId(arrivals)
  const boxMatched = declaredBoxes === receivedBoxes
  const arrival: EntryRow = {
    id: arrivalId,
    status: '已登记',
    pending: true,
    abnormal: !boxMatched,
    到货单号: arrivalNo,
    供应商: supplier,
    组件型号: moduleModel,
    单据箱数: declaredBoxes,
    实收箱数: receivedBoxes,
    每箱片数: piecesPerBox,
    到货日期: arrivalDate,
    登记时间: nowStamp(),
    箱数一致: boxMatched,
    箱数差异: receivedBoxes - declaredBoxes,
    待入库片数: 0,
    入库片数: 0,
    入库状态: '无需入库',
  }
  saveRows(ARRIVAL_KEY, [...arrivals, arrival])

  const batches = readBatches()
  let batchId = nextId(batches)
  const created: EntryRow[] = batchBoxes.map((boxes, index) => {
    const plan = samplingPlan(boxes)
    const row: EntryRow = {
      id: batchId++,
      status: '待开箱',
      pending: true,
      abnormal: false,
      批次编号: `${arrivalNo}-B${index + 1}`,
      到货单号: arrivalNo,
      到货单ID: arrivalId,
      批次序号: index + 1,
      供应商: supplier,
      组件型号: moduleModel,
      箱数: boxes,
      样本字码: plan.codeLetter,
      应抽箱数: plan.sampleSize,
      抽检比例: plan.ratioLabel,
      全检: plan.fullInspection,
      实抽箱数: 0,
      致命不合格箱数: 0,
      一般不合格箱数: 0,
      抽检结论: '',
      判定依据: '',
      检验时间: '',
      已传照片数: 0,
      照片完成: false,
      抽检照片: '',
    }
    return row
  })
  writeBatches([...batches, ...created])
  return { ok: true, data: arrivalId, message: `到货单 ${arrivalNo} 已登记，拆出 ${created.length} 个批次待开箱抽检` }
}

/** 追加抽检照片（先建上传中记录，页面模拟逐张上传并回报结果） */
export function appendInspectionPhotos(
  batchId: number,
  files: { name: string; size: number }[],
): ServiceResult<InspectionPhoto[]> {
  const batches = readBatches()
  const index = batches.findIndex((row) => Number(row.id) === batchId)
  if (index < 0) {
    return { ok: false, message: '没有找到对应批次' }
  }
  const batch = batches[index]
  if (['合格放行', '整批退换'].includes(String(batch.status))) {
    return { ok: false, message: '该批次已有结论，不再接收照片' }
  }
  const photos = parsePhotos(batch)
  let photoId = photos.reduce((max, item) => Math.max(max, item.id), 0) + 1
  for (const file of files) {
    photos.push({ id: photoId++, name: file.name, size: file.size, status: '上传中' })
  }
  batch.status = '抽检中'
  batch.pending = true
  writePhotos(batch, photos)
  batches[index] = batch
  writeBatches(batches)
  const arrivals = readArrivals()
  const arrival = findArrival(arrivals, Number(batch['到货单ID']))
  if (arrival) {
    recomputeArrival(arrival, batches, arrivals)
  }
  return { ok: true, data: photos, message: `已加入 ${files.length} 张照片` }
}

/** 页面模拟上传后逐张回报：已完成 / 中断 */
export function reportPhotoProgress(batchId: number, photoId: number, status: '已完成' | '中断'): ActionResult {
  const batches = readBatches()
  const index = batches.findIndex((row) => Number(row.id) === batchId)
  if (index < 0) {
    return { ok: false, message: '没有找到对应批次' }
  }
  const photos = parsePhotos(batches[index])
  const photo = photos.find((item) => item.id === photoId)
  if (!photo) {
    return { ok: false, message: '没有找到该照片记录' }
  }
  photo.status = status
  if (status === '已完成') {
    photo.uploadedAt = nowStamp()
  }
  writePhotos(batches[index], photos)
  writeBatches(batches)
  return { ok: true, message: status === '已完成' ? '照片已上传完成' : '上传中断，进度已保留' }
}

/**
 * 断点续传：按批次顺序找到第一张未传完的批次（中断或上传中都算）。
 * 上传中断后刷新页面，从这里拿到断掉的批次接着传，不重头来。
 */
export function resumePoint(arrivalId: number): { batchId: number; pending: number } | null {
  const batches = listBatchesByArrival(arrivalId)
  for (const batch of batches) {
    if (['合格放行', '整批退换'].includes(String(batch.status))) {
      continue
    }
    const photos = parsePhotos(batch)
    const pending = photos.filter((item) => item.status !== '已完成').length
    if (pending > 0) {
      // 刷新后残留的「上传中」一律按中断处理，从这张继续
      let dirty = false
      for (const photo of photos) {
        if (photo.status === '上传中') {
          photo.status = '中断'
          dirty = true
        }
      }
      if (dirty) {
        const all = readBatches()
        const target = all.find((row) => Number(row.id) === Number(batch.id))
        if (target) {
          writePhotos(target, photos)
          writeBatches(all)
        }
      }
      return { batchId: Number(batch.id), pending }
    }
  }
  return null
}

export type InspectionInput = {
  batchId: number
  inspectedBoxes: number
  criticalBoxes: number
  generalBoxes: number
  note: string
}

/** 提交一个批次的开箱抽检结果并自动判定合格放行/整批退换 */
export function submitInspection(input: InspectionInput): ServiceResult {
  const inspectedBoxes = Math.floor(input.inspectedBoxes)
  const criticalBoxes = Math.floor(input.criticalBoxes)
  const generalBoxes = Math.floor(input.generalBoxes)
  if (inspectedBoxes < 0 || criticalBoxes < 0 || generalBoxes < 0) {
    return { ok: false, message: '抽检箱数不能为负' }
  }
  if (criticalBoxes + generalBoxes > inspectedBoxes) {
    return { ok: false, message: '不合格箱数合计不能大于实抽箱数' }
  }

  const batches = readBatches()
  const index = batches.findIndex((row) => Number(row.id) === input.batchId)
  if (index < 0) {
    return { ok: false, message: '没有找到对应批次' }
  }
  const batch = batches[index]
  if (['合格放行', '整批退换'].includes(String(batch.status))) {
    return { ok: false, message: `批次 ${batch['批次编号']} 已出结论「${batch.status}」，不能重复提交` }
  }

  const summary = batchPhotoSummary(batch)
  if (!summary.finished) {
    const which = summary.interrupted > 0 ? '存在中断的抽检照片' : summary.uploading > 0 ? '还有照片在上传中' : '至少完整上传 1 张抽检照片'
    return { ok: false, message: `${which}，请从断掉的批次把照片传完再出结论（批次 ${batch['批次编号']}）` }
  }

  const plan: InspectionPlan = samplingPlan(Number(batch['箱数']))
  if (inspectedBoxes !== plan.sampleSize) {
    return {
      ok: false,
      message: `按抽样标准该批应开 ${plan.sampleSize} 箱（字码 ${plan.codeLetter}${plan.fullInspection ? '，全检' : ''}），实开 ${inspectedBoxes} 箱，箱数不符不能出结论`,
    }
  }

  const verdict = evaluateBatch(plan, criticalBoxes, generalBoxes)
  const note = input.note.trim()
  batch.status = verdict.conclusion
  batch.pending = false
  batch.abnormal = verdict.conclusion === '整批退换'
  batch['实抽箱数'] = inspectedBoxes
  batch['致命不合格箱数'] = criticalBoxes
  batch['一般不合格箱数'] = generalBoxes
  batch['抽检结论'] = verdict.conclusion
  batch['判定依据'] = note ? `${verdict.reason}；备注：${note}` : verdict.reason
  batch['检验时间'] = nowStamp()
  batches[index] = batch
  writeBatches(batches)

  const arrivals = readArrivals()
  const arrival = findArrival(arrivals, Number(batch['到货单ID']))
  if (arrival) {
    recomputeArrival(arrival, batches, arrivals)
  }
  return { ok: true, data: Number(batch.id), message: `批次 ${batch['批次编号']}：${verdict.reason}` }
}

export type ReleaseCheck = {
  allowed: boolean
  blockedBatches: { batchNo: string; status: string }[]
  boxMismatch: boolean
  message: string
}

/** 放行前校验：结论必须全部出齐，箱数必须对得上；不满足就挡回并指出批次 */
export function checkRelease(arrivalId: number): ReleaseCheck {
  const arrivals = readArrivals()
  const arrival = findArrival(arrivals, arrivalId)
  if (!arrival) {
    return { allowed: false, blockedBatches: [], boxMismatch: false, message: '没有找到这张到货单' }
  }
  const batches = listBatchesByArrival(arrivalId)
  const blockedBatches = batches
    .filter((row) => !['合格放行', '整批退换'].includes(String(row.status)))
    .map((row) => ({ batchNo: String(row['批次编号']), status: String(row.status) }))
  const boxMismatch = !arrival['箱数一致']
  if (blockedBatches.length > 0) {
    const detail = blockedBatches.map((item) => `${item.batchNo}（${item.status}）`).join('、')
    return {
      allowed: false,
      blockedBatches,
      boxMismatch,
      message: `强行放行被挡回：批次 ${detail} 尚未出抽检结论，结论出齐前整单不许入库`,
    }
  }
  if (boxMismatch) {
    return {
      allowed: false,
      blockedBatches,
      boxMismatch: true,
      message: `放行被挡回：到货单 ${arrival['到货单号']} 单据箱数 ${arrival['单据箱数']} 与实收 ${arrival['实收箱数']} 对不上，核实差异后再放行`,
    }
  }
  return { allowed: true, blockedBatches: [], boxMismatch: false, message: '全部批次已出结论且箱数相符，可以放行' }
}

/** 放行入库：合格批次的片数进入备品备件「待入库清单」，退换批次不计入 */
export function releaseArrival(arrivalId: number): ActionResult {
  const arrivals = readArrivals()
  const arrival = findArrival(arrivals, arrivalId)
  if (!arrival) {
    return { ok: false, message: '没有找到这张到货单' }
  }
  if (String(arrival.status) === '已放行' || String(arrival.status) === '已入库') {
    return { ok: true, message: `到货单 ${arrival['到货单号']} 已放行，未重复入库` }
  }
  const check = checkRelease(arrivalId)
  if (!check.allowed) {
    return { ok: false, message: check.message }
  }

  const batches = listBatchesByArrival(arrivalId)
  const acceptedBoxes = batches
    .filter((row) => String(row.status) === '合格放行')
    .reduce((sum, row) => sum + Number(row['箱数']), 0)
  const returnedBoxes = batches
    .filter((row) => String(row.status) === '整批退换')
    .reduce((sum, row) => sum + Number(row['箱数']), 0)
  const pieces = acceptedBoxes * Number(arrival['每箱片数'])

  arrival['待入库片数'] = pieces
  arrival['入库片数'] = 0
  arrival['入库状态'] = pieces > 0 ? '待入库' : '无需入库'
  arrival.abnormal = false
  if (pieces === 0) {
    arrival.status = '整批退换'
    arrival.pending = false
  } else {
    arrival.status = '已放行'
    arrival.pending = true
  }
  saveRows(ARRIVAL_KEY, arrivals)
  const tail = returnedBoxes > 0 ? `，另有 ${returnedBoxes} 箱整批退换不计入` : ''
  return {
    ok: true,
    message: `到货单 ${arrival['到货单号']} 已放行：${acceptedBoxes} 箱共 ${pieces} 片进入备品备件待入库清单${tail}`,
  }
}

export type PendingInboundItem = {
  arrivalId: number
  arrivalNo: string
  supplier: string
  moduleModel: string
  pieces: number
  releaseDate: string
}

/** 备品备件「待入库清单」：唯一来源是已放行但仓库未确认的到货单 */
export function listPendingInbound(): PendingInboundItem[] {
  return readArrivals()
    .filter((row) => row['入库状态'] === '待入库' && Number(row['待入库片数']) > 0)
    .map((row) => ({
      arrivalId: Number(row.id),
      arrivalNo: String(row['到货单号']),
      supplier: String(row['供应商']),
      moduleModel: String(row['组件型号']),
      pieces: Number(row['待入库片数']),
      releaseDate: String(row['到货日期']),
    }))
}

export function pendingInboundPieces(): number {
  return listPendingInbound().reduce((sum, item) => sum + item.pieces, 0)
}

function spareNameFor(model: string): string {
  return `光伏组件-${model}`
}

/** 入库片数累加进备品备件台账：同型号归并到同一备件品类，不重复造记录 */
function upsertSpare(model: string, pieces: number, supplier: string): EntryRow {
  const rows = listRows('spare')
  const name = spareNameFor(model)
  const index = rows.findIndex((row) => String(row['规格型号']) === model && String(row['备件名称']) === name)
  if (index >= 0) {
    const row = rows[index]
    row['现有数量'] = Number(row['现有数量'] || 0) + pieces
    row['备件状态'] = '数量充足'
    row.status = '数量充足'
    row.pending = false
    row['供应商'] = supplier
    saveRows('spare', rows)
    return row
  }
  const id = nextId(rows)
  const safety = 72
  const row: EntryRow = {
    id,
    status: '数量充足',
    pending: false,
    abnormal: false,
    备件编号: `SPAR-${String(id).padStart(4, '0')}`,
    备件名称: name,
    适用设备: '光伏组件',
    规格型号: model,
    现有数量: pieces,
    安全存量: safety,
    存放库位: '组件库区',
    备件状态: pieces >= safety ? '数量充足' : '待补充',
    供应商: supplier,
  }
  saveRows('spare', [...rows, row])
  return row
}

/** 仓库在备品备件侧确认入库：只扣这一个来源，重复确认不会第二次加库存 */
export function confirmInbound(arrivalId: number): ActionResult {
  const arrivals = readArrivals()
  const arrival = findArrival(arrivals, arrivalId)
  if (!arrival) {
    return { ok: false, message: '没有找到这张到货单' }
  }
  if (arrival['入库状态'] === '已入库') {
    return { ok: true, message: `到货单 ${arrival['到货单号']} 已确认入库，未重复登记` }
  }
  if (String(arrival.status) !== '已放行' || arrival['入库状态'] !== '待入库') {
    return { ok: false, message: `到货单 ${arrival['到货单号']} 尚未放行，不能确认入库` }
  }
  const pieces = Number(arrival['待入库片数'])
  if (pieces <= 0) {
    return { ok: false, message: '该单没有可入库的合格片数' }
  }
  const spare = upsertSpare(String(arrival['组件型号']), pieces, String(arrival['供应商']))
  arrival['入库片数'] = Number(arrival['入库片数'] || 0) + pieces
  arrival['待入库片数'] = 0
  arrival['入库状态'] = '已入库'
  arrival.status = '已入库'
  arrival.pending = false
  saveRows(ARRIVAL_KEY, arrivals)
  return { ok: true, message: `${pieces} 片 ${arrival['组件型号']} 已入库到「${spare['备件名称']}」（备件编号 ${spare['备件编号']}）` }
}

export type ArrivalStats = {
  arrivalCount: number
  openBatchCount: number
  pendingPieces: number
  returnedBatchCount: number
}

export function arrivalStats(): ArrivalStats {
  const batches = readBatches()
  return {
    arrivalCount: readArrivals().length,
    openBatchCount: batches.filter((row) => !['合格放行', '整批退换'].includes(String(row.status))).length,
    pendingPieces: pendingInboundPieces(),
    returnedBatchCount: batches.filter((row) => String(row.status) === '整批退换').length,
  }
}
