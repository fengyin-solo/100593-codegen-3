<template>
  <article class="batch-card" :class="`batch-${batch.verdict}`">
    <header class="batch-head">
      <div>
        <strong>批次 {{ batch.batchNo }}</strong>
        <span class="batch-meta">{{ batch.boxCount }} 箱 · 应开 {{ requiredBoxes }} 箱（{{ plan.code }}）</span>
      </div>
      <span class="batch-tag" :class="`tag-${batch.verdict}`">{{ verdictText }}</span>
    </header>

    <p class="batch-note">{{ batch.verdictNote }}</p>

    <div class="batch-grid">
      <div>
        <span class="batch-label">抽样口径</span>
        <p class="batch-text">
          GB/T 2828.1 一般水平 II 一次抽样：B类 Ac={{ plan.accept }}/Re={{ plan.reject }}（AQL=2.5）；
          A类（隐裂/碎片/EL异常）Ac=0/Re=1，抽中即整批退换。
        </p>
      </div>
      <div>
        <span class="batch-label">抽检照片（每只开箱≥1张）</span>
        <div class="photo-row">
          <input ref="fileInput" type="file" accept="image/*" multiple hidden @change="onPickFiles" />
          <button class="btn" type="button" @click="pickFiles">选择照片</button>
          <button class="btn" type="button" :disabled="!hasPending || uploading" @click="startUpload">
            {{ resumeLabel }}
          </button>
          <button v-if="uploading" class="btn ghost" type="button" @click="cancelUpload">中断</button>
          <span class="batch-text">
            已传 {{ photoDone }}/{{ photoTotal }}，需 {{ requiredBoxes }} 张
          </span>
        </div>
        <div v-if="photoTotal" class="progress-track">
          <div class="progress-bar" :style="{ width: `${(photoDone / photoTotal) * 100}%` }" />
        </div>
        <p v-if="uploadMessage" class="batch-text">{{ uploadMessage }}</p>
      </div>
    </div>

    <form v-if="batch.verdict !== 'rejected'" class="inspect-form" @submit.prevent="submitInspect">
      <label class="inspect-item">
        <span>实际开箱数</span>
        <input v-model.number="form.openedBoxes" type="number" min="0" :max="batch.boxCount" />
      </label>
      <label class="inspect-item">
        <span>A类不合格箱（隐裂/碎片/EL）</span>
        <input v-model.number="form.classABadBoxes" type="number" min="0" />
      </label>
      <label class="inspect-item">
        <span>B类不合格箱（轻微外观）</span>
        <input v-model.number="form.classBBadBoxes" type="number" min="0" />
      </label>
      <label class="inspect-item">
        <span>抽检人</span>
        <input v-model="form.inspector" placeholder="抽检人姓名" />
      </label>
      <button class="btn primary" type="submit">出抽检结论</button>
    </form>
    <p v-else class="batch-text warn">本批已判整批退换，不得复检放行，请联系供应商退换后重新到货登记。</p>

    <div class="batch-foot">
      <button
        class="link"
        type="button"
        :disabled="batch.verdict === 'accepted'"
        @click="forceRelease"
      >
        强行放行入库
      </button>
      <span v-if="batch.verdict === 'accepted'" class="batch-text ok">已入待入库清单，无需强行放行</span>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue'

import {
  addPhotoDrafts,
  forceRelease as forceReleaseApi,
  photoProgress,
  runPhotoUploads,
  submitInspection as submitInspectionApi,
} from '@/data/receiving-store'
import { planForLot } from '@/data/receiving-policy'
import type { ReceivingBatch } from '@/data/receiving-store'

const props = defineProps<{
  noticeId: string
  batch: ReceivingBatch
  operator: string
}>()

const emit = defineEmits<{
  (event: 'changed', message: string, ok: boolean): void
}>()

const plan = computed(() => planForLot(props.batch.boxCount))
const requiredBoxes = computed(() => Math.min(plan.value.sampleSize, props.batch.boxCount))

const verdictText = computed(() => {
  return { pending: '结论未出·禁入库', accepted: '合格放行', rejected: '整批退换' }[props.batch.verdict]
})

const storedInspect = props.batch.inspect
const form = reactive({
  openedBoxes: storedInspect?.openedBoxes ?? requiredBoxes.value,
  classABadBoxes: storedInspect?.classABadBoxes ?? 0,
  classBBadBoxes: storedInspect?.classBBadBoxes ?? 0,
  inspector: storedInspect?.inspector ?? props.operator,
})

function submitInspect() {
  const result = submitInspectionApi({
    noticeId: props.noticeId,
    batchId: props.batch.id,
    openedBoxes: Number(form.openedBoxes),
    classABadBoxes: Number(form.classABadBoxes),
    classBBadBoxes: Number(form.classBBadBoxes),
    inspector: form.inspector,
  })
  emit('changed', result.message, result.ok)
}

function forceRelease() {
  const result = forceReleaseApi(props.noticeId, props.batch.id)
  emit('changed', result.message, false)
}

// ── 照片：选择 → 排队上传 → 中断可从本批续传 ──
const fileInput = ref<HTMLInputElement | null>(null)
const uploading = ref(false)
const uploadMessage = ref('')
let cancelFn: (() => void) | null = null

const progress = computed(() => photoProgress(props.batch))
const photoDone = computed(() => progress.value.done)
const photoTotal = computed(() => props.batch.photos.length)
const hasPending = computed(() => props.batch.photos.some((photo) => !photo.uploaded))
const resumeLabel = computed(() =>
  photoDone.value > 0 && hasPending.value ? `从本批续传（${photoDone.value}/${photoTotal.value}）` : '上传本批照片',
)

function pickFiles() {
  fileInput.value?.click()
}

async function onPickFiles(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  if (!files.length) {
    return
  }
  const drafts = await Promise.all(
    files.map(
      (file) =>
        new Promise<{ id: string; name: string; dataUrl: string }>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () =>
            resolve({
              id: `PHOTO-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
              name: file.name,
              dataUrl: String(reader.result),
            })
          reader.onerror = reject
          reader.readAsDataURL(file)
        }),
    ),
  )
  const result = addPhotoDrafts(props.noticeId, props.batch.id, drafts)
  uploadMessage.value = result.message
  emit('changed', result.message, result.ok)
  input.value = ''
}

async function startUpload() {
  if (uploading.value) {
    return
  }
  uploading.value = true
  uploadMessage.value = `正在上传批次 ${props.batch.batchNo} 的照片……`
  const handle = runPhotoUploads(props.noticeId, props.batch.id, (done, total, batchNo) => {
    uploadMessage.value = `批次 ${batchNo}：${done}/${total} 张`
  })
  cancelFn = handle.cancel
  const result = await handle.promise
  cancelFn = null
  uploading.value = false
  uploadMessage.value = result.message
  emit('changed', result.message, result.ok)
}

function cancelUpload() {
  cancelFn?.()
}
</script>
