import { evaluateBatch, planForLot, requiredPhotos, type Verdict } from './receiving-policy'

/**
 * 到货验收记录的数据层。
 *
 * 一条到货验收记录分两层：
 * - 到货单（notice）：按到货单登记供应商、组件型号、箱数，是一次提交的对账单元。
 * - 批次（batch）：到货单内按批次开箱抽检，每个批次独立出结论、独立退换。
 *
 * 入库结论只有一个出口：批次被判「合格放行」后写入本存储的待入库清单，
 * 备品备件页直接读同一份（pendingInbound），不再各自记数，避免两块数量对不上。
 */

export type ReceivingPhoto = {
  id: string
  batchId: string
  name: string
  /** 缩略数据；失败重传时同批次已成功的照片不重传 */
  dataUrl?: string
  uploaded: boolean
}

export type InspectRecord = {
  /** 实际开箱数 */
  openedBoxes: number
  /** A 类（含隐裂）不合格箱数 */
  classABadBoxes: number
  /** B 类（轻微）不合格箱数 */
  classBBadBoxes: number
  inspectedAt: string
  inspector: string
}

export type ReceivingBatch = {
  id: string
  noticeId: string
  batchNo: string
  boxCount: number
  verdict: Verdict
  inspect: InspectRecord | null
  /** 放行/退换结论说明：合格写方案，退换写命中的判定规则 */
  verdictNote: string
  photos: ReceivingPhoto[]
}

export type RejectAttempt = {
  at: string
  message: string
}

export type ReceivingNotice = {
  id: string
  noticeNo: string
  supplier: string
  moduleModel: string
  boxCount: number
  arrivedAt: string
  receivedAt: string
  operator: string
  /** 老到货单（存量、无到货日期）回填标记 */
  backfilled: boolean
  batches: ReceivingBatch[]
  /** 强行放行被挡回的记录：写明时间、动作和是哪一批 */
  blockedAttempts: RejectAttempt[]
}

const STORAGE_KEY = 'pv-plant-ops:receiving'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function nowText(): string {
  return new Date().toLocaleString('zh-CN', { hour12: false })
}

let seedCache: ReceivingNotice[] | null = null

function seed(): ReceivingNotice[] {
  if (seedCache) {
    return seedCache
  }
  seedCache = buildSeed()
  return seedCache
}

function read(): ReceivingNotice[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return clone(seed())
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const data = backfillLegacy(clone(seed()))
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
    return data
  }
  try {
    const parsed = JSON.parse(raw) as ReceivingNotice[]
    return backfillLegacy(parsed)
  } catch {
    const data = clone(seed())
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
    return data
  }
}

let cache: ReceivingNotice[] | null = null

function store(): ReceivingNotice[] {
  if (cache === null) {
    cache = read()
  }
  return cache
}

function persist(): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store()))
  }
}

/** 存量到货单按到货日期回填：没有到货日期的，用登记时间回填并标记。 */
export function backfillLegacy(notices: ReceivingNotice[]): ReceivingNotice[] {
  let changed = false
  for (const notice of notices) {
    if (!notice.arrivedAt) {
      notice.arrivedAt = (notice.receivedAt || '').slice(0, 10) || today()
      notice.backfilled = true
      changed = true
    }
    if (notice.backfilled === undefined) {
      notice.backfilled = false
    }
  }
  if (changed && typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(notices))
  }
  return notices
}

export function listNotices(): ReceivingNotice[] {
  return clone(store()).sort((a, b) => (a.arrivedAt < b.arrivedAt ? 1 : -1))
}

export function findNotice(id: string): ReceivingNotice | null {
  const target = store().find((item) => item.id === id)
  return target ? clone(target) : null
}

export type RegisterInput = {
  noticeNo: string
  supplier: string
  moduleModel: string
  boxCount: number
  arrivedAt: string
  operator: string
  batches: { batchNo: string; boxCount: number }[]
}

export type Result<T = void> = { ok: boolean; message: string; data?: T }

let idSeq = 1
function nextId(prefix: string): string {
  idSeq += 1
  return `${prefix}-${Date.now().toString(36)}-${idSeq}`
}

/**
 * 登记到货单。同一张到货单（同到货单号）重复提交只认第一次：
 * 已经登记过就直接挡回，不会重复生成入库数量。
 */
export function registerNotice(input: RegisterInput): Result<ReceivingNotice> {
  const noticeNo = input.noticeNo.trim()
  if (!noticeNo) {
    return { ok: false, message: '到货单号不能为空' }
  }
  if (!input.supplier.trim() || !input.moduleModel.trim()) {
    return { ok: false, message: '供应商与组件型号必须填写' }
  }
  if (!Number.isFinite(input.boxCount) || input.boxCount <= 0) {
    return { ok: false, message: '到货箱数必须是大于 0 的整数' }
  }
  if (input.batches.length === 0) {
    return { ok: false, message: '至少登记一个到货批次' }
  }

  const rows = store()
  if (rows.some((item) => item.noticeNo === noticeNo)) {
    return {
      ok: false,
      message: `到货单 ${noticeNo} 已登记过，重复提交不重复入库`,
    }
  }

  const seenBatch = new Set<string>()
  let batchTotal = 0
  for (const batch of input.batches) {
    const batchNo = batch.batchNo.trim()
    if (!batchNo) {
      return { ok: false, message: '每个批次都要有批次号' }
    }
    if (seenBatch.has(batchNo)) {
      return { ok: false, message: `批次号 ${batchNo} 重复` }
    }
    seenBatch.add(batchNo)
    if (!Number.isFinite(batch.boxCount) || batch.boxCount <= 0) {
      return { ok: false, message: `批次 ${batchNo} 箱数必须大于 0` }
    }
    batchTotal += batch.boxCount
  }
  if (batchTotal !== input.boxCount) {
    return {
      ok: false,
      message: `批次箱数合计 ${batchTotal} 与到货单箱数 ${input.boxCount} 对不上`,
    }
  }

  const notice: ReceivingNotice = {
    id: nextId('NOTICE'),
    noticeNo,
    supplier: input.supplier.trim(),
    moduleModel: input.moduleModel.trim(),
    boxCount: input.boxCount,
    arrivedAt: input.arrivedAt || today(),
    receivedAt: nowText(),
    operator: input.operator.trim(),
    backfilled: false,
    blockedAttempts: [],
    batches: input.batches.map((batch) => ({
      id: nextId('BATCH'),
      noticeId: '',
      batchNo: batch.batchNo.trim(),
      boxCount: batch.boxCount,
      verdict: 'pending',
      inspect: null,
      verdictNote: '尚未开箱抽检，结论未出，禁止入库',
      photos: [],
    })),
  }
  notice.batches.forEach((batch) => {
    batch.noticeId = notice.id
  })

  rows.push(notice)
  persist()
  return { ok: true, message: `到货单 ${noticeNo} 已登记，等待按批次开箱抽检`, data: clone(notice) }
}

export type InspectInput = {
  noticeId: string
  batchId: string
  openedBoxes: number
  classABadBoxes: number
  classBBadBoxes: number
  inspector: string
}

/**
 * 按批次提交开箱抽检记录并出结论。照片未齐 / 开箱不足都只能保持「结论未出」，
 * 合格、退换两种结论由抽样口径统一判定。
 */
export function submitInspection(input: InspectInput): Result {
  const rows = store()
  const notice = rows.find((item) => item.id === input.noticeId)
  if (!notice) {
    return { ok: false, message: '没有找到这张到货单' }
  }
  const batch = notice.batches.find((item) => item.id === input.batchId)
  if (!batch) {
    return { ok: false, message: '没有找到这个批次' }
  }

  for (const value of [input.openedBoxes, input.classABadBoxes, input.classBBadBoxes] as number[]) {
    if (!Number.isInteger(value) || value < 0) {
      return { ok: false, message: '开箱数、不合格箱数必须是非负整数' }
    }
  }

  const result = evaluateBatch({
    boxCount: batch.boxCount,
    openedBoxes: input.openedBoxes,
    classABadBoxes: input.classABadBoxes,
    classBBadBoxes: input.classBBadBoxes,
  })

  const uploadedPhotos = batch.photos.filter((photo) => photo.uploaded).length
  const needPhotos = requiredPhotos(batch.boxCount)
  if (uploadedPhotos < needPhotos) {
    result.verdict = 'pending'
    result.reasons = [
      ...result.reasons.filter((reason) => !reason.startsWith('开箱数不足')),
      `抽检照片未齐：每只开箱至少 1 张，需 ${needPhotos} 张，已传 ${uploadedPhotos} 张，中断后可从本批续传`,
    ]
  }

  if (result.verdict === 'pending') {
    batch.inspect = {
      openedBoxes: input.openedBoxes,
      classABadBoxes: input.classABadBoxes,
      classBBadBoxes: input.classBBadBoxes,
      inspectedAt: nowText(),
      inspector: input.inspector.trim(),
    }
    batch.verdict = 'pending'
    batch.verdictNote = result.reasons.join('；') || '结论未出，禁止入库'
    persist()
    return { ok: false, message: `${batch.batchNo} 结论未出：${batch.verdictNote}` }
  }

  batch.inspect = {
    openedBoxes: input.openedBoxes,
    classABadBoxes: input.classABadBoxes,
    classBBadBoxes: input.classBBadBoxes,
    inspectedAt: nowText(),
    inspector: input.inspector.trim(),
  }
  batch.verdict = result.verdict
  const plan = result.plan
  const planText = `字码 ${plan.code}，开箱 ${result.requiredBoxes}（B类 Ac=${plan.accept}/Re=${plan.reject}，A类 0/1）`
  batch.verdictNote =
    result.verdict === 'accepted'
      ? `合格放行：${planText}；A类 ${input.classABadBoxes} 箱、B类 ${input.classBBadBoxes} 箱，已同步待入库清单`
      : `整批退换：${planText}；${result.reasons.join('；')}`
  persist()
  return {
    ok: true,
    message:
      result.verdict === 'accepted'
        ? `批次 ${batch.batchNo} 抽检合格，${batch.boxCount} 箱已放行并同步待入库清单`
        : `批次 ${batch.batchNo} 判整批退换，禁止入库`,
  }
}

/**
 * 挡回强行放行：结论不是「合格放行」的批次一律不许入库。
 * 每次尝试都留痕，明确写明是哪一批、为什么被挡。
 */
export function forceRelease(noticeId: string, batchId: string): Result {
  const rows = store()
  const notice = rows.find((item) => item.id === noticeId)
  if (!notice) {
    return { ok: false, message: '没有找到这张到货单' }
  }
  const batch = notice.batches.find((item) => item.id === batchId)
  if (!batch) {
    return { ok: false, message: '没有找到这个批次' }
  }
  if (batch.verdict === 'accepted') {
    return { ok: false, message: `批次 ${batch.batchNo} 已合格放行，无需强行操作` }
  }
  const reason =
    batch.verdict === 'rejected'
      ? `已判整批退换（${batch.verdictNote}）`
      : '抽检结论未出'
  const record: RejectAttempt = {
    at: nowText(),
    message: `强行放行批次 ${batch.batchNo} 被挡回：${reason}，该批不得入库`,
  }
  notice.blockedAttempts.push(record)
  persist()
  return { ok: false, message: record.message }
}

// ── 抽检照片：断点续传 ──────────────────────────────────────────────

export type PhotoDraft = {
  id: string
  name: string
  dataUrl: string
}

/**
 * 追加待传照片。只登记元数据，真正「上传」走 runPhotoUploads 模拟队列；
 * 中断后元数据和已成功的照片都在，从断掉的批次接着传。
 */
export function addPhotoDrafts(noticeId: string, batchId: string, drafts: PhotoDraft[]): Result {
  const rows = store()
  const notice = rows.find((item) => item.id === noticeId)
  if (!notice) {
    return { ok: false, message: '没有找到这张到货单' }
  }
  const batch = notice.batches.find((item) => item.id === batchId)
  if (!batch) {
    return { ok: false, message: '没有找到这个批次' }
  }
  if (drafts.length === 0) {
    return { ok: false, message: '请先选择抽检照片' }
  }
  for (const draft of drafts) {
    batch.photos.push({
      id: draft.id,
      batchId,
      name: draft.name,
      dataUrl: draft.dataUrl,
      uploaded: false,
    })
  }
  persist()
  return { ok: true, message: `批次 ${batch.batchNo} 已加入 ${drafts.length} 张待传照片` }
}

/** 找到第一个还有照片未传完的批次——上传中断后从这一批接着传。 */
export function findResumableBatch(noticeId: string): ReceivingBatch | null {
  const notice = findNotice(noticeId)
  if (!notice) {
    return null
  }
  return notice.batches.find((batch) => batch.photos.some((photo) => !photo.uploaded)) ?? null
}

/**
 * 把指定批次（不传 batchId 则从第一个未传完的批次开始）的待传照片逐张上传。
 * 每传完一张就落盘：中断后已完成的不重传，从断掉的那一张/那一批继续。
 */
export function runPhotoUploads(
  noticeId: string,
  batchId: string | null,
  onProgress: (done: number, total: number, batchNo: string) => void,
): { promise: Promise<Result>; cancel: () => void } {
  const targetBatchId = batchId ?? findResumableBatch(noticeId)?.id ?? null
  const rows = store()
  const notice = rows.find((item) => item.id === noticeId)
  if (!notice || !targetBatchId) {
    return {
      promise: Promise.resolve({ ok: false, message: '没有待上传的抽检照片' }),
      cancel: () => undefined,
    }
  }

  // 从断掉的批次开始：本批传完后，后续批次排队继续；已传完的批次跳过。
  const startIndex = notice.batches.findIndex((batch) => batch.id === targetBatchId)
  const queue = notice.batches
    .slice(startIndex)
    .filter((batch) => batch.photos.some((photo) => !photo.uploaded))

  const pending = queue.flatMap((batch) =>
    batch.photos
      .filter((photo) => !photo.uploaded)
      .map((photo) => ({ batch, photo })),
  )
  const total = countAllPhotos(notice)
  let done = total - pending.length
  let cancelled = false

  const step = (index: number, resolve: (value: Result) => void): void => {
    if (cancelled) {
      persist()
      resolve({
        ok: false,
        message: `上传中断：已传 ${done} 张，保留进度，下次从批次 ${pending[index]?.batch.batchNo ?? queue[queue.length - 1]?.batchNo ?? ''} 续传`,
      })
      return
    }
    if (index >= pending.length) {
      persist()
      resolve({ ok: true, message: `抽检照片全部上传完成，共 ${done} 张` })
      return
    }
    const { batch, photo } = pending[index]
    photo.uploaded = true
    done += 1
    persist()
    onProgress(done, total, batch.batchNo)
    window.setTimeout(() => step(index + 1, resolve), 180)
  }

  return {
    promise: new Promise<Result>((resolve) => step(0, resolve)),
    cancel: () => {
      cancelled = true
    },
  }
}

function countAllPhotos(notice: ReceivingNotice): number {
  return notice.batches.reduce((sum, batch) => sum + batch.photos.length, 0)
}

export type PendingInboundItem = {
  noticeId: string
  batchId: string
  noticeNo: string
  supplier: string
  moduleModel: string
  batchNo: string
  boxCount: number
  arrivedAt: string
  acceptedAt: string
}

export type ConfirmedInbound = PendingInboundItem & { confirmedAt: string; operator: string }

/**
 * 待入库清单：全站唯一数据源。到货验收页和备品备件页都读这一个函数，
 * 「合格放行且尚未确认入库」的批次才出现，数量不可能出现两套。
 */
export function pendingInbound(): PendingInboundItem[] {
  const confirmed = confirmedKeys()
  const items: PendingInboundItem[] = []
  for (const notice of store()) {
    for (const batch of notice.batches) {
      if (batch.verdict !== 'accepted') {
        continue
      }
      const key = `${notice.id}/${batch.id}`
      if (confirmed.has(key)) {
        continue
      }
      items.push({
        noticeId: notice.id,
        batchId: batch.id,
        noticeNo: notice.noticeNo,
        supplier: notice.supplier,
        moduleModel: notice.moduleModel,
        batchNo: batch.batchNo,
        boxCount: batch.boxCount,
        arrivedAt: notice.arrivedAt,
        acceptedAt: batch.inspect?.inspectedAt ?? '',
      })
    }
  }
  return items
}

const CONFIRMED_KEY = 'pv-plant-ops:receiving:confirmed'

function confirmedKeys(): Set<string> {
  if (typeof window === 'undefined' || !window.localStorage) {
    return new Set()
  }
  try {
    return new Set(JSON.parse(window.localStorage.getItem(CONFIRMED_KEY) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}

export function confirmInbound(batchIds: string[], operator: string): Result<number> {
  const keys = new Set(confirmedKeys())
  const items = pendingInbound().filter((item) => batchIds.includes(item.batchId))
  if (items.length === 0) {
    return { ok: false, message: '没有可确认入库的合格批次' }
  }
  const history = confirmedHistory()
  for (const item of items) {
    keys.add(`${item.noticeId}/${item.batchId}`)
    history.push({ ...item, confirmedAt: nowText(), operator: operator.trim() || '值班管理员' })
  }
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(CONFIRMED_KEY, JSON.stringify([...keys]))
    window.localStorage.setItem('pv-plant-ops:receiving:confirmed-history', JSON.stringify(history))
  }
  return { ok: true, message: `已确认 ${items.length} 个批次入库`, data: items.length }
}

export function confirmedHistory(): ConfirmedInbound[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return []
  }
  try {
    return JSON.parse(
      window.localStorage.getItem('pv-plant-ops:receiving:confirmed-history') ?? '[]',
    ) as ConfirmedInbound[]
  } catch {
    return []
  }
}

export function photoProgress(batch: ReceivingBatch): { done: number; required: number } {
  return {
    done: batch.photos.filter((photo) => photo.uploaded).length,
    required: requiredPhotos(batch.boxCount),
  }
}

export { planForLot, requiredPhotos }

// ── 存量到货单示例：含合格、隐裂退换、结论未出三种批次 ────────────────

function buildSeed(): ReceivingNotice[] {
  const mkBatch = (
    noticeId: string,
    batchNo: string,
    boxCount: number,
    verdict: Verdict,
    note: string,
    inspect: InspectRecord | null,
  ): ReceivingBatch => ({
    id: `SEED-BATCH-${noticeId}-${batchNo}`,
    noticeId,
    batchNo,
    boxCount,
    verdict,
    inspect,
    verdictNote: note,
    photos: inspect
      ? Array.from({ length: Math.min(planForLot(boxCount).sampleSize, boxCount) }, (_, index) => ({
          id: `SEED-PHOTO-${noticeId}-${batchNo}-${index}`,
          batchId: `SEED-BATCH-${noticeId}-${batchNo}`,
          name: `开箱照片${index + 1}.jpg`,
          uploaded: true,
        }))
      : [],
  })

  const n1: ReceivingNotice = {
    id: 'SEED-NOTICE-1',
    noticeNo: 'DN-20260918-01',
    supplier: '晶阳光电',
    moduleModel: 'JKM550M-72HL4',
    boxCount: 220,
    arrivedAt: '2026-09-18',
    receivedAt: '2026-09-18 09:20',
    operator: '值班管理员',
    backfilled: false,
    blockedAttempts: [],
    batches: [
      mkBatch(
        'SEED-NOTICE-1',
        'B20260915-01',
        120,
        'accepted',
        '合格放行：字码 G，开箱 20（B类 Ac=1/Re=2，A类 0/1）；A类 0 箱、B类 1 箱，已同步待入库清单',
        { openedBoxes: 20, classABadBoxes: 0, classBBadBoxes: 1, inspectedAt: '2026-09-18 10:05', inspector: '李工' },
      ),
      mkBatch(
        'SEED-NOTICE-1',
        'B20260916-02',
        100,
        'accepted',
        '合格放行：字码 F，开箱 13（B类 Ac=1/Re=2，A类 0/1）；A类 0 箱、B类 0 箱，已同步待入库清单',
        { openedBoxes: 13, classABadBoxes: 0, classBBadBoxes: 0, inspectedAt: '2026-09-18 10:40', inspector: '李工' },
      ),
    ],
  }

  const n2: ReceivingNotice = {
    id: 'SEED-NOTICE-2',
    noticeNo: 'DN-20260924-02',
    supplier: '恒泰新能源',
    moduleModel: 'LR5-72HTH-560M',
    boxCount: 60,
    arrivedAt: '2026-09-24',
    receivedAt: '2026-09-24 14:02',
    operator: '值班管理员',
    backfilled: false,
    blockedAttempts: [
      {
        at: '2026-09-24 16:10',
        message:
          '强行放行批次 B20260920-05 被挡回：已判整批退换（A 类隐裂抽中 1 箱，AQL=0 零容忍），该批不得入库',
      },
    ],
    batches: [
      mkBatch(
        'SEED-NOTICE-2',
        'B20260920-05',
        60,
        'rejected',
        '整批退换：字码 F，开箱 13（B类 Ac=1/Re=2，A类 0/1）；A 类（隐裂/碎片/EL 异常等致命缺陷）抽中 1 箱，AQL=0 零容忍，整批退换',
        { openedBoxes: 13, classABadBoxes: 1, classBBadBoxes: 0, inspectedAt: '2026-09-24 15:30', inspector: '王工' },
      ),
    ],
  }

  // 存量老到货单：没有到货日期，进入系统后按到货日期回填。
  const n3: ReceivingNotice = {
    id: 'SEED-NOTICE-3',
    noticeNo: 'DN-OLD-0812-03',
    supplier: '晶阳光电',
    moduleModel: 'JKM550M-72HL4',
    boxCount: 40,
    arrivedAt: '',
    receivedAt: '2026-08-12 11:00',
    operator: '值班管理员',
    backfilled: false,
    blockedAttempts: [],
    batches: [
      mkBatch('SEED-NOTICE-3', 'B20260808-09', 40, 'pending', '尚未开箱抽检，结论未出，禁止入库', null),
    ],
  }

  return [n1, n2, n3]
}
