<template>
  <section class="page" data-module="arrival">
    <header class="page-head">
      <div>
        <h2>组件到货验收</h2>
        <p class="page-desc">按到货单登记供应商、组件型号与箱数，再按批次开箱抽检；结论没出齐不许入库，合格片数同步备品备件待入库清单。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openRegister">登记到货单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <div class="rule-box">
      <strong>放行标准（抽样口径沿用既有来料检验一套）：</strong>
      {{ ACCEPTANCE_STANDARD_TEXT }}。
      合格判定数 Ac / 不合格判定数 Re 按批箱数对应的字码方案执行；结论出齐前整单不得入库，单据箱数与实收箱数不符同样挡回。
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in arrivals" :key="String(row.id)">
          <td v-for="column in columns" :key="column">
            <span v-if="column === '实收箱数' && !row['箱数一致']" class="warn-text">
              {{ row[column] }}（差 {{ Number(row['箱数差异']) > 0 ? '+' : '' }}{{ row['箱数差异'] }}）
            </span>
            <span v-else-if="column === '待入库片数'">{{ inboundPieces(row) }}</span>
            <span v-else>{{ row[column] ?? '—' }}</span>
          </td>
          <td>
            <span :class="['status-badge', badgeClass(String(row.status))]">{{ row.status }}</span>
            <span v-if="row['入库状态'] === '待入库'" class="tag tag-pending">待入库 {{ row['待入库片数'] }} 片</span>
            <span v-else-if="row['入库状态'] === '已入库'" class="tag tag-done">已入库 {{ row['入库片数'] }} 片</span>
          </td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(row)">开箱抽检</button>
            <button
              v-if="canRelease(String(row.status))"
              class="link"
              type="button"
              @click="release(row)"
            >放行入库</button>
          </td>
        </tr>
        <tr v-if="!arrivals.length">
          <td :colspan="columns.length + 2" class="empty-state">暂未登记到货单，点「登记到货单」开始验收</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ arrivals.length }} 张到货单</span>
      <span v-if="message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</span>
    </footer>

    <!-- 登记到货单 -->
    <div v-if="registerOpen" class="modal-mask" @click.self="closeRegister">
      <div class="modal wide">
        <h3>登记组件到货单</h3>
        <div class="form-grid">
          <label class="form-item">
            <span>到货单号 *</span>
            <input v-model.trim="regForm.arrivalNo" placeholder="如 ASN-20261004-01" />
          </label>
          <label class="form-item">
            <span>到货日期 *</span>
            <input v-model="regForm.arrivalDate" type="date" />
          </label>
          <label class="form-item">
            <span>供应商 *</span>
            <input v-model.trim="regForm.supplier" placeholder="如 隆基绿能" />
          </label>
          <label class="form-item">
            <span>组件型号 *</span>
            <input v-model.trim="regForm.moduleModel" placeholder="如 LR5-72HTH-580M" />
          </label>
          <label class="form-item">
            <span>到货单箱数 *</span>
            <input v-model.number="regForm.declaredBoxes" type="number" min="1" />
          </label>
          <label class="form-item">
            <span>实收箱数 *</span>
            <input v-model.number="regForm.receivedBoxes" type="number" min="1" />
          </label>
          <label class="form-item">
            <span>每箱片数 *</span>
            <input v-model.number="regForm.piecesPerBox" type="number" min="1" />
          </label>
          <label class="form-item">
            <span>批次数</span>
            <input v-model.number="batchCount" type="number" min="1" max="20" @change="resizeBatches" />
          </label>
        </div>
        <p v-if="boxMismatch" class="warn-text">
          实收箱数与到货单相差 {{ regForm.receivedBoxes - regForm.declaredBoxes }} 箱，可以先登记，但放行前必须核实，箱数不符整单会被挡回。
        </p>
        <div class="batch-edit">
          <span>按批次拆分箱数（合计须等于实收 {{ regForm.receivedBoxes || 0 }} 箱，当前合计 {{ batchTotal }} 箱）：</span>
          <div class="batch-inputs">
            <label v-for="(_, index) in regForm.batchBoxes" :key="index" class="mini-item">
              <span>批次 {{ index + 1 }}</span>
              <input v-model.number="regForm.batchBoxes[index]" type="number" min="1" />
            </label>
          </div>
          <p v-if="batchTotalReady && batchTotal !== regForm.receivedBoxes" class="error-text">批次箱数合计与实收箱数不一致，提交会被拒绝。</p>
        </div>
        <div class="modal-foot">
          <button class="btn ghost" type="button" @click="closeRegister">取消</button>
          <button class="btn primary" type="button" @click="submitRegister">提交登记</button>
        </div>
      </div>
    </div>

    <!-- 到货单详情：按批次开箱抽检 -->
    <div v-if="detailOpen && currentArrival" class="drawer-mask" @click.self="closeDetail">
      <aside class="drawer">
        <header class="drawer-head">
          <div>
            <h3>{{ currentArrival['到货单号'] }} · 批次开箱抽检</h3>
            <p class="page-desc">
              {{ currentArrival['供应商'] }} ｜ {{ currentArrival['组件型号'] }} ｜
              实收 {{ currentArrival['实收箱数'] }} 箱 ｜ 每箱 {{ currentArrival['每箱片数'] }} 片 ｜
              到货 {{ currentArrival['到货日期'] }}
            </p>
          </div>
          <button class="btn ghost" type="button" @click="closeDetail">关闭</button>
        </header>

        <p v-if="!currentArrival['箱数一致']" class="warn-box">
          单据箱数 {{ currentArrival['单据箱数'] }} ≠ 实收 {{ currentArrival['实收箱数'] }}，差异 {{ currentArrival['箱数差异'] }} 箱；
          结论出齐也放不了行，请先核实箱数差异。
        </p>
        <p v-if="resumeHint" class="resume-box">{{ resumeHint }}</p>

        <div v-for="batch in detailBatches" :key="String(batch.id)" class="batch-card">
          <div class="batch-head">
            <div>
              <strong>{{ batch['批次编号'] }}</strong>
              <span :class="['status-badge', badgeClass(String(batch.status))]">{{ batch.status }}</span>
            </div>
            <div class="batch-meta">
              <span>批箱数 {{ batch['箱数'] }}</span>
              <span>字码 {{ batch['样本字码'] }}</span>
              <span>应抽 {{ batch['应抽箱数'] }} 箱（{{ batch['抽检比例'] }}{{ batch['全检'] ? '，全检' : '' }}）</span>
            </div>
          </div>

          <p v-if="batch['抽检结论']" :class="['verdict', String(batch.status) === '整批退换' ? 'verdict-bad' : 'verdict-ok']">
            结论：{{ batch['抽检结论'] }}（实抽 {{ batch['实抽箱数'] }} 箱，致命 {{ batch['致命不合格箱数'] }} 箱 / 一般 {{ batch['一般不合格箱数'] }} 箱）
            <span class="verdict-reason">{{ batch['判定依据'] }}</span>
          </p>

          <template v-else>
            <p class="plan-line">{{ planPreview(Number(batch['箱数'])) }}</p>

            <div class="photo-line">
              <span class="photo-label">抽检照片（{{ photoSummaryText(batch) }}）：</span>
              <input
                :ref="(el) => setFileInput(el, Number(batch.id))"
                class="photo-file"
                type="file"
                accept="image/*"
                multiple
                @change="(event) => onPickPhotos(batch, event)"
              />
              <button class="btn" type="button" :disabled="!canResume(batch)" @click="resumeBatch(batch)">从断点续传</button>
              <button class="btn" type="button" :disabled="!uploading(Number(batch.id))" @click="interruptBatch(batch)">中断上传</button>
            </div>
            <ul v-if="photosOf(batch).length" class="photo-list">
              <li v-for="photo in photosOf(batch)" :key="photo.id">
                <span class="photo-name">{{ photo.name }}</span>
                <span :class="['photo-state', `photo-${photo.status}`]">{{ photo.status }}</span>
              </li>
            </ul>

            <div class="batch-actions">
              <button class="btn primary" type="button" @click="openInspection(batch)">录入抽检结果并出结论</button>
            </div>
          </template>
        </div>

        <footer class="drawer-foot">
          <span v-if="detailMessage" :class="detailMessageOk ? 'ok-text' : 'error-text'">{{ detailMessage }}</span>
          <button
            v-if="canRelease(String(currentArrival.status))"
            class="btn primary"
            type="button"
            @click="release(currentArrival)"
          >放行并同步待入库</button>
        </footer>
      </aside>
    </div>

    <!-- 录入抽检结果 -->
    <div v-if="inspectionOpen && inspectionBatch" class="modal-mask" @click.self="closeInspection">
      <div class="modal">
        <h3>抽检结果 · {{ inspectionBatch['批次编号'] }}</h3>
        <p class="plan-line">{{ planPreview(Number(inspectionBatch['箱数'])) }}</p>
        <div class="form-grid">
          <label class="form-item">
            <span>实抽箱数（须等于应抽 {{ inspectionBatch['应抽箱数'] }} 箱）</span>
            <input v-model.number="inspForm.inspectedBoxes" type="number" min="0" />
          </label>
          <label class="form-item">
            <span>致命不合格箱数（隐裂/破片/背板穿透，≥1 即整批退换）</span>
            <input v-model.number="inspForm.criticalBoxes" type="number" min="0" />
          </label>
          <label class="form-item">
            <span>一般不合格箱数（外观/接线盒/包装，对照 Ac/Re）</span>
            <input v-model.number="inspForm.generalBoxes" type="number" min="0" />
          </label>
          <label class="form-item full">
            <span>抽检备注（EL 图像、隐裂位置等）</span>
            <input v-model.trim="inspForm.note" placeholder="如 EL 图像显示第 3 抽箱 2 块组件隐裂" />
          </label>
        </div>
        <p :class="['verdict-preview', verdictPreviewClass]">系统预判：{{ verdictPreviewText }}</p>
        <div class="modal-foot">
          <button class="btn ghost" type="button" @click="closeInspection">取消</button>
          <button class="btn primary" type="button" @click="submitInspectionForm">提交结论</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref } from 'vue'

import {
  ACCEPTANCE_STANDARD_TEXT,
  samplingPlan,
  evaluateBatch,
} from '@/api/acceptance-rules'
import {
  appendInspectionPhotos,
  arrivalStats,
  batchPhotoSummary,
  checkRelease,
  listArrivals,
  listBatchesByArrival,
  registerArrival,
  releaseArrival,
  reportPhotoProgress,
  resumePoint,
  submitInspection,
  type InspectionPhoto,
} from '@/api/arrival-service'
import type { EntryRow } from '@/data/types'

const columns = ['到货单号', '供应商', '组件型号', '单据箱数', '实收箱数', '每箱片数', '到货日期', '待入库片数']
const filterFields = ['到货单号', '供应商', '组件型号']
const statuses = ['已登记', '抽检中', '待放行', '已放行', '整批退换', '已入库']

const arrivals = ref<EntryRow[]>([])
const filters = ref<Record<string, string>>({})
const message = ref('')
const messageOk = ref(false)

const stats = ref([
  { label: '到货单数', value: 0 },
  { label: '未出结论批次', value: 0 },
  { label: '待入库组件片数', value: 0 },
  { label: '整批退换批次', value: 0 },
])

const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: arrivals.value.filter((row) => String(row.status) === status).length,
  })),
)

function inboundPieces(row: EntryRow): string {
  if (row['入库状态'] === '已入库') {
    return String(row['入库片数'])
  }
  return row['入库状态'] === '待入库' ? String(row['待入库片数']) : '—'
}

function canRelease(status: string): boolean {
  return status === '待放行'
}

function badgeClass(status: string): string {
  if (status === '整批退换') return 'badge-bad'
  if (status === '已放行' || status === '合格放行') return 'badge-ok'
  if (status === '已入库') return 'badge-done'
  if (status === '抽检中') return 'badge-warn'
  return 'badge-muted'
}

function reload() {
  arrivals.value = listArrivals(filters.value)
  const summary = arrivalStats()
  stats.value = [
    { label: '到货单数', value: summary.arrivalCount },
    { label: '未出结论批次', value: summary.openBatchCount },
    { label: '待入库组件片数', value: summary.pendingPieces },
    { label: '整批退换批次', value: summary.returnedBatchCount },
  ]
}

function resetFilters() {
  filters.value = {}
  reload()
}

function flash(text: string, ok: boolean) {
  message.value = text
  messageOk.value = ok
}

// ---------- 登记到货单 ----------
const registerOpen = ref(false)
const batchCount = ref(1)
const regForm = reactive({
  arrivalNo: '',
  supplier: '',
  moduleModel: '',
  declaredBoxes: 10,
  receivedBoxes: 10,
  piecesPerBox: 36,
  arrivalDate: '2026-10-04',
  batchBoxes: [10] as number[],
})

const batchTotal = computed(() =>
  regForm.batchBoxes.reduce((sum, value) => sum + (Number(value) || 0), 0),
)
const batchTotalReady = computed(() => regForm.batchBoxes.some((value) => Number(value) > 0))
const boxMismatch = computed(
  () => Number(regForm.declaredBoxes) > 0 && Number(regForm.declaredBoxes) !== Number(regForm.receivedBoxes),
)

function openRegister() {
  registerOpen.value = true
}
function closeRegister() {
  registerOpen.value = false
}
function resizeBatches() {
  const count = Math.min(20, Math.max(1, Number(batchCount.value) || 1))
  const next: number[] = []
  for (let index = 0; index < count; index += 1) {
    next.push(regForm.batchBoxes[index] ?? 0)
  }
  regForm.batchBoxes = next
}

function submitRegister() {
  const result = registerArrival({
    arrivalNo: regForm.arrivalNo,
    supplier: regForm.supplier,
    moduleModel: regForm.moduleModel,
    declaredBoxes: Number(regForm.declaredBoxes),
    receivedBoxes: Number(regForm.receivedBoxes),
    piecesPerBox: Number(regForm.piecesPerBox),
    arrivalDate: regForm.arrivalDate,
    batchBoxes: regForm.batchBoxes.map((value) => Number(value)),
  })
  if (!result.ok) {
    flash(result.message, false)
    return
  }
  flash(result.message, true)
  registerOpen.value = false
  reload()
}

// ---------- 到货单详情 / 批次 ----------
const detailOpen = ref(false)
const currentArrival = ref<EntryRow | null>(null)
const detailBatches = ref<EntryRow[]>([])
const detailMessage = ref('')
const detailMessageOk = ref(false)
const photoMap = reactive(new Map<number, InspectionPhoto[]>())
const resumeHint = ref('')
const fileInputs = new Map<number, HTMLInputElement | null>()
const uploadTimers = new Map<number, number>()
const cancelFlags = new Map<number, boolean>()

function setFileInput(el: unknown, batchId: number) {
  fileInputs.set(batchId, (el as HTMLInputElement | null) ?? null)
}

function openDetail(row: EntryRow) {
  currentArrival.value = row
  detailOpen.value = true
  detailMessage.value = ''
  loadDetail()
  const point = resumePoint(Number(row.id))
  resumeHint.value = point
    ? `检测到批次照片有 ${point.pending} 张未传完：从该批次点「从断点续传」即可接着传，不用重头来。`
    : ''
}

function loadDetail() {
  if (!currentArrival.value) return
  detailBatches.value = listBatchesByArrival(Number(currentArrival.value.id))
  const latest = listArrivals().find((row) => Number(row.id) === Number(currentArrival.value?.id))
  if (latest) currentArrival.value = latest
  photoMap.clear()
  for (const batch of detailBatches.value) {
    photoMap.set(Number(batch.id), readPhotos(batch))
  }
}

function closeDetail() {
  for (const timer of uploadTimers.values()) {
    window.clearTimeout(timer)
  }
  uploadTimers.clear()
  detailOpen.value = false
  currentArrival.value = null
  reload()
}

function readPhotos(batch: EntryRow): InspectionPhoto[] {
  const raw = batch['抽检照片']
  if (typeof raw !== 'string' || raw.trim() === '') return []
  try {
    const parsed = JSON.parse(raw) as InspectionPhoto[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}
function photosOf(batch: EntryRow): InspectionPhoto[] {
  return photoMap.get(Number(batch.id)) ?? []
}
function photoSummaryText(batch: EntryRow): string {
  const summary = batchPhotoSummary(batch)
  if (summary.uploading > 0) return `上传中 · 已完成 ${summary.completed} 张`
  if (summary.interrupted > 0) return `中断 · ${summary.interrupted} 张待续传`
  return summary.completed > 0 ? `已完成 ${summary.completed} 张` : '未上传'
}
function uploading(batchId: number): boolean {
  return uploadTimers.has(batchId)
}
function canResume(batch: EntryRow): boolean {
  if (['合格放行', '整批退换'].includes(String(batch.status))) return false
  return photosOf(batch).some((photo) => photo.status !== '已完成')
}

function planPreview(boxes: number): string {
  const plan = samplingPlan(boxes)
  return `按 GB/T 2828.1 水平 II / AQL=2.5：批量 ${plan.lotSize} 箱 → 字码 ${plan.codeLetter}，开 ${plan.sampleSize} 箱（${plan.ratioLabel}${plan.fullInspection ? '，全检' : ''}），Ac=${plan.acceptNumber}，Re=${plan.rejectNumber}；致命缺陷 Ac=0 一票退换。`
}

async function onPickPhotos(batch: EntryRow, event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? []).map((file) => ({ name: file.name, size: file.size }))
  if (!files.length) return
  const result = appendInspectionPhotos(Number(batch.id), files)
  if (!result.ok) {
    detailMessage.value = result.message
    detailMessageOk.value = false
    return
  }
  input.value = ''
  loadDetail()
  // 新加入的照片自动开始顺序上传
  runUploadChain(Number(batch.id))
}

function refreshBatchPhotos(batchId: number, photos: InspectionPhoto[]) {
  photoMap.set(batchId, photos)
  const row = detailBatches.value.find((item) => Number(item.id) === batchId)
  if (row) {
    row['抽检照片'] = JSON.stringify(photos)
    row['已传照片数'] = photos.filter((item) => item.status === '已完成').length
    row['照片完成'] = photos.length > 0 && photos.every((item) => item.status === '已完成')
  }
}

function runUploadChain(batchId: number) {
  if (uploadTimers.has(batchId)) return
  cancelFlags.set(batchId, false)
  const step = () => {
    if (cancelFlags.get(batchId)) {
      uploadTimers.delete(batchId)
      return
    }
    const photos = photoMap.get(batchId) ?? []
    const target = photos.find((item) => item.status === '中断' || item.status === '上传中')
    if (!target) {
      uploadTimers.delete(batchId)
      return
    }
    target.status = '上传中'
    refreshBatchPhotos(batchId, photos)
    const timer = window.setTimeout(() => {
      const current = photoMap.get(batchId) ?? []
      const photo = current.find((item) => item.id === target.id)
      if (!photo) {
        uploadTimers.delete(batchId)
        return
      }
      if (cancelFlags.get(batchId)) {
        reportPhotoProgress(batchId, photo.id, '中断')
        photo.status = '中断'
        uploadTimers.delete(batchId)
        return
      }
      reportPhotoProgress(batchId, photo.id, '已完成')
      photo.status = '已完成'
      photo.uploadedAt = new Date().toLocaleString('zh-CN', { hour12: false })
      refreshBatchPhotos(batchId, current)
      step()
    }, 700)
    uploadTimers.set(batchId, timer)
  }
  step()
}

function resumeBatch(batch: EntryRow) {
  detailMessage.value = ''
  const pending = photosOf(batch).filter((photo) => photo.status !== '已完成')
  if (!pending.length) {
    detailMessage.value = '该批次没有需要续传的照片'
    detailMessageOk.value = false
    return
  }
  detailMessage.value = `从批次 ${batch['批次编号']} 的断点继续，剩余 ${pending.length} 张`
  detailMessageOk.value = true
  runUploadChain(Number(batch.id))
}

function interruptBatch(batch: EntryRow) {
  cancelFlags.set(Number(batch.id), true)
  const timer = uploadTimers.get(Number(batch.id))
  if (timer) {
    window.clearTimeout(timer)
    uploadTimers.delete(Number(batch.id))
  }
  const photos = photoMap.get(Number(batch.id)) ?? []
  const target = photos.find((item) => item.status === '上传中')
  if (target) {
    target.status = '中断'
    reportPhotoProgress(Number(batch.id), target.id, '中断')
    refreshBatchPhotos(Number(batch.id), photos)
  }
  detailMessage.value = `批次 ${batch['批次编号']} 上传已中断，进度保留，可从断点续传`
  detailMessageOk.value = false
}

// ---------- 抽检结论 ----------
const inspectionOpen = ref(false)
const inspectionBatch = ref<EntryRow | null>(null)
const inspForm = reactive({ inspectedBoxes: 0, criticalBoxes: 0, generalBoxes: 0, note: '' })

function openInspection(batch: EntryRow) {
  inspectionBatch.value = batch
  inspForm.inspectedBoxes = Number(batch['应抽箱数'])
  inspForm.criticalBoxes = 0
  inspForm.generalBoxes = 0
  inspForm.note = ''
  inspectionOpen.value = true
}
function closeInspection() {
  inspectionOpen.value = false
  inspectionBatch.value = null
}

const verdictPreviewText = computed(() => {
  if (!inspectionBatch.value) return ''
  const plan = samplingPlan(Number(inspectionBatch.value['箱数']))
  return evaluateBatch(plan, Number(inspForm.criticalBoxes) || 0, Number(inspForm.generalBoxes) || 0).reason
})
const verdictPreviewClass = computed(() => {
  if (!inspectionBatch.value) return ''
  const plan = samplingPlan(Number(inspectionBatch.value['箱数']))
  return evaluateBatch(plan, Number(inspForm.criticalBoxes) || 0, Number(inspForm.generalBoxes) || 0).conclusion === '整批退换'
    ? 'verdict-bad'
    : 'verdict-ok'
})

function submitInspectionForm() {
  if (!inspectionBatch.value) return
  const result = submitInspection({
    batchId: Number(inspectionBatch.value.id),
    inspectedBoxes: Number(inspForm.inspectedBoxes),
    criticalBoxes: Number(inspForm.criticalBoxes),
    generalBoxes: Number(inspForm.generalBoxes),
    note: inspForm.note,
  })
  detailMessage.value = result.message
  detailMessageOk.value = result.ok
  if (!result.ok) return
  inspectionOpen.value = false
  inspectionBatch.value = null
  loadDetail()
}

// ---------- 放行 ----------
function release(row: EntryRow) {
  const guard = checkRelease(Number(row.id))
  if (!guard.allowed) {
    if (currentArrival.value && Number(currentArrival.value.id) === Number(row.id)) {
      detailMessage.value = guard.message
      detailMessageOk.value = false
    } else {
      flash(guard.message, false)
    }
    return
  }
  const result = releaseArrival(Number(row.id))
  if (currentArrival.value && Number(currentArrival.value.id) === Number(row.id)) {
    detailMessage.value = result.message
    detailMessageOk.value = result.ok
    loadDetail()
  } else {
    flash(result.message, result.ok)
  }
  reload()
}

onBeforeUnmount(() => {
  for (const timer of uploadTimers.values()) {
    window.clearTimeout(timer)
  }
})

reload()
</script>

<style scoped>
.rule-box {
  background: #eef4ff;
  border: 1px solid #c5d8fb;
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 13px;
  line-height: 1.7;
  margin-bottom: 12px;
}
.warn-text { color: #b54708; font-weight: 600; }
.ok-text { color: #067647; }
.status-badge {
  display: inline-block;
  border-radius: 999px;
  padding: 1px 10px;
  font-size: 12px;
  margin-right: 6px;
}
.badge-muted { background: #eef2f7; color: #475467; }
.badge-warn { background: #fef0c7; color: #b54708; }
.badge-ok { background: #d1fadf; color: #067647; }
.badge-bad { background: #fee4e2; color: #b42318; }
.badge-done { background: #e0eaff; color: #1849a9; }
.tag { font-size: 12px; border-radius: 4px; padding: 1px 6px; }
.tag-pending { background: #fef0c7; color: #b54708; }
.tag-done { background: #d1fadf; color: #067647; }

.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(16, 24, 40, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}
.modal {
  background: #fff;
  border-radius: 10px;
  width: 520px;
  max-width: calc(100vw - 40px);
  padding: 18px 20px;
  max-height: 86vh;
  overflow: auto;
}
.modal.wide { width: 720px; }
.modal h3 { margin: 0 0 12px; }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 14px; }
.form-item span { display: block; font-size: 12px; color: var(--muted); margin-bottom: 4px; }
.form-item input { width: 100%; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; }
.form-item.full { grid-column: 1 / -1; }
.modal-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.batch-edit { margin-top: 12px; font-size: 13px; }
.batch-inputs { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 8px; }
.mini-item span { display: block; font-size: 12px; color: var(--muted); }
.mini-item input { width: 88px; padding: 5px 8px; border: 1px solid var(--border); border-radius: 6px; }

.drawer-mask { position: fixed; inset: 0; background: rgba(16, 24, 40, 0.4); z-index: 40; }
.drawer {
  position: absolute;
  top: 0;
  right: 0;
  height: 100%;
  width: 680px;
  max-width: 96vw;
  background: #f6f8fb;
  padding: 16px 18px;
  overflow: auto;
}
.drawer-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
.drawer-foot {
  position: sticky;
  bottom: 0;
  background: #f6f8fb;
  padding: 10px 0;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
}
.warn-box, .resume-box {
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 13px;
  margin: 8px 0;
}
.warn-box { background: #fef0c7; border: 1px solid #fedf89; color: #b54708; }
.resume-box { background: #e0eaff; border: 1px solid #b2ccff; color: #1849a9; }
.batch-card {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 12px;
}
.batch-head { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 6px; }
.batch-meta { display: flex; gap: 12px; font-size: 12px; color: var(--muted); flex-wrap: wrap; }
.plan-line { font-size: 12.5px; color: #344054; background: #f9fafb; border-radius: 6px; padding: 6px 8px; margin: 8px 0; }
.photo-line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; }
.photo-label { color: var(--muted); }
.photo-file { font-size: 12px; max-width: 240px; }
.photo-list { list-style: none; padding: 0; margin: 8px 0 0; display: flex; flex-direction: column; gap: 4px; }
.photo-list li { display: flex; justify-content: space-between; font-size: 12.5px; background: #f9fafb; border-radius: 6px; padding: 4px 8px; }
.photo-state { border-radius: 999px; padding: 0 8px; }
.photo-已完成 { background: #d1fadf; color: #067647; }
.photo-中断 { background: #fee4e2; color: #b42318; }
.photo-上传中 { background: #fef0c7; color: #b54708; }
.batch-actions { margin-top: 10px; }
.verdict { border-radius: 6px; padding: 8px 10px; font-size: 13px; margin: 8px 0 0; }
.verdict-ok, .verdict-preview.verdict-ok { background: #ecfdf3; border: 1px solid #abefc6; color: #067647; }
.verdict-bad, .verdict-preview.verdict-bad { background: #fef3f2; border: 1px solid #fda29b; color: #b42318; }
.verdict-reason { display: block; color: var(--muted); margin-top: 4px; }
.verdict-preview { border-radius: 6px; padding: 8px 10px; font-size: 13px; margin-top: 10px; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
