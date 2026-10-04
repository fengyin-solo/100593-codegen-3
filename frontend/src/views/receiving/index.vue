<template>
  <section class="page" data-module="receiving">
    <header class="page-head">
      <div>
        <h2>组件到货验收</h2>
        <p class="page-desc">
          按到货单登记供应商、组件型号与箱数，按批次开箱抽检；结论未出禁止入库，合格批同步备品备件待入库清单。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="showRegister = !showRegister">
          {{ showRegister ? '收起登记' : '登记到货单' }}
        </button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p v-if="flash" class="flash" :class="flashOk ? 'flash-ok' : 'flash-error'">{{ flash }}</p>

    <!-- 放行标准：抽样口径统一引用 receiving-policy，页面不另写 -->
    <article class="policy-card">
      <strong>放行标准（沿用既有抽样口径）</strong>
      <p>
        按 <strong>GB/T 2828.1 一般检查水平 II、正常一次抽样</strong>，抽样单位为箱，按批次开箱抽检。
        A 类（隐裂/碎片/EL异常/断栅）AQL=0，Ac 0 / Re 1，抽中 1 箱即<strong>整批退换</strong>；
        B 类（轻微外观）AQL=2.5，开箱数与 Ac/Re 按批量查表，≥Re 整批退换。
        每只开箱至少 1 张照片，照片未齐或开箱不足时<strong>结论未出，禁止入库</strong>。
      </p>
      <table class="data-table plan-table">
        <thead>
          <tr>
            <th>批量(箱)</th><th>字码</th><th>开箱数</th><th>B类 Ac</th><th>B类 Re</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="plan in plans" :key="plan.code + String(plan.min)">
            <td>{{ plan.max === Infinity ? `${plan.min} 以上` : `${plan.min}-${plan.max}` }}</td>
            <td>{{ plan.code }}</td>
            <td>{{ plan.sampleSize }}</td>
            <td>{{ plan.accept }}</td>
            <td>{{ plan.reject }}</td>
          </tr>
        </tbody>
      </table>
    </article>

    <!-- 登记到货单 -->
    <form v-if="showRegister" class="register-card" @submit.prevent="submitRegister">
      <div class="register-grid">
        <label class="inspect-item">
          <span>到货单号</span>
          <input v-model="regForm.noticeNo" placeholder="如 DN-20261004-01" />
        </label>
        <label class="inspect-item">
          <span>供应商</span>
          <input v-model="regForm.supplier" placeholder="供应商名称" />
        </label>
        <label class="inspect-item">
          <span>组件型号</span>
          <input v-model="regForm.moduleModel" placeholder="如 JKM550M-72HL4" />
        </label>
        <label class="inspect-item">
          <span>到货日期</span>
          <input v-model="regForm.arrivedAt" type="date" />
        </label>
        <label class="inspect-item">
          <span>到货箱数（到货单）</span>
          <input v-model.number="regForm.boxCount" type="number" min="1" />
        </label>
      </div>

      <div class="batch-edit">
        <div class="batch-edit-head">
          <strong>按批次拆箱登记（批次箱数合计须等于到货箱数）</strong>
          <button class="btn" type="button" @click="addBatchRow">增加批次</button>
        </div>
        <div v-for="(row, index) in regForm.batches" :key="index" class="batch-edit-row">
          <input v-model="row.batchNo" placeholder="批次号" />
          <input v-model.number="row.boxCount" type="number" min="1" placeholder="本批箱数" />
          <button class="link" type="button" @click="removeBatchRow(index)">删除</button>
        </div>
        <p class="batch-text">批次箱数合计：<strong>{{ batchSum }}</strong> / 到货单 {{ regForm.boxCount || 0 }}</p>
      </div>

      <div class="register-actions">
        <button class="btn primary" type="submit">提交到货登记</button>
        <button class="btn ghost" type="button" @click="showRegister = false">取消</button>
      </div>
    </form>

    <!-- 待入库清单：与备品备件页同一份数据源 -->
    <article class="inbound-card">
      <header class="batch-edit-head">
        <strong>待入库清单（备品备件页同步读取此清单）</strong>
        <span class="batch-text">共 {{ pendingItems.length }} 批 / {{ pendingBoxes }} 箱</span>
      </header>
      <table v-if="pendingItems.length" class="data-table">
        <thead>
          <tr>
            <th>到货单号</th><th>供应商</th><th>组件型号</th><th>批次号</th>
            <th>放行箱数</th><th>到货日期</th><th>放行时间</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in pendingItems" :key="item.batchId">
            <td>{{ item.noticeNo }}</td>
            <td>{{ item.supplier }}</td>
            <td>{{ item.moduleModel }}</td>
            <td>{{ item.batchNo }}</td>
            <td><strong>{{ item.boxCount }}</strong></td>
            <td>{{ item.arrivedAt }}</td>
            <td>{{ item.acceptedAt }}</td>
            <td><button class="link" type="button" @click="confirmOne(item.batchId)">确认入库</button></td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty-state">暂无合格放行待入库批次（退换批、结论未出批不会进入此清单）</p>
    </article>

    <!-- 到货记录 -->
    <div class="notice-list">
      <article v-for="notice in notices" :key="notice.id" class="notice-card">
        <header class="notice-head" @click="toggle(notice.id)">
          <div>
            <strong>{{ notice.noticeNo }}</strong>
            <span v-if="notice.backfilled" class="backfill-tag">到货日期已按登记时间回填</span>
            <span class="batch-meta">
              {{ notice.supplier }} · {{ notice.moduleModel }} · 到货 {{ notice.boxCount }} 箱 ·
              到货日期 {{ notice.arrivedAt }}
            </span>
          </div>
          <div class="notice-head-right">
            <span class="notice-status" :class="`status-${noticeStatus(notice).key}`">
              {{ noticeStatus(notice).text }}
            </span>
            <span class="toggle-mark">{{ expanded === notice.id ? '收起▲' : '展开▼' }}</span>
          </div>
        </header>

        <div v-if="expanded === notice.id" class="notice-body">
          <p v-for="attempt in notice.blockedAttempts" :key="attempt.at + attempt.message" class="blocked-line">
            {{ attempt.at }}｜{{ attempt.message }}
          </p>
          <BatchPanel
            v-for="batch in notice.batches"
            :key="batch.id"
            :notice-id="notice.id"
            :batch="batch"
            :operator="operator"
            @changed="onBatchChanged"
          />
        </div>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import BatchPanel from './BatchPanel.vue'
import {
  confirmInbound,
  listNotices,
  pendingInbound,
  registerNotice,
} from '@/data/receiving-store'
import { SAMPLING_PLANS } from '@/data/receiving-policy'
import { useSessionStore } from '@/stores/session'
import type { ReceivingNotice } from '@/data/receiving-store'

const session = useSessionStore()
const operator = session.operator

const plans = SAMPLING_PLANS
const notices = ref<ReceivingNotice[]>([])
const pendingItems = ref(pendingInbound())
const expanded = ref<string | null>(null)
const showRegister = ref(false)
const flash = ref('')
const flashOk = ref(false)

const regForm = reactive({
  noticeNo: '',
  supplier: '',
  moduleModel: '',
  boxCount: null as number | null,
  arrivedAt: new Date().toISOString().slice(0, 10),
  batches: [{ batchNo: '', boxCount: null as number | null }],
})

const batchSum = computed(() =>
  regForm.batches.reduce((sum, row) => sum + (Number(row.boxCount) || 0), 0),
)

const stats = computed(() => {
  const batches = notices.value.flatMap((notice) => notice.batches)
  const pendingBoxes = pendingItems.value.reduce((sum, item) => sum + item.boxCount, 0)
  return [
    { label: '到货单', value: notices.value.length },
    { label: '待抽检批次', value: batches.filter((batch) => batch.verdict === 'pending').length },
    { label: '合格放行批', value: batches.filter((batch) => batch.verdict === 'accepted').length },
    { label: '整批退换批', value: batches.filter((batch) => batch.verdict === 'rejected').length },
    { label: '待入库箱数', value: pendingBoxes },
  ]
})

const pendingBoxes = computed(() => pendingItems.value.reduce((sum, item) => sum + item.boxCount, 0))

function reload(message = '', ok = false) {
  notices.value = listNotices()
  pendingItems.value = pendingInbound()
  if (message) {
    flash.value = message
    flashOk.value = ok
  }
}

function onBatchChanged(message: string, ok: boolean) {
  reload(message, ok)
}

function toggle(id: string) {
  expanded.value = expanded.value === id ? null : id
}

function noticeStatus(notice: ReceivingNotice): { key: string; text: string } {
  const verdicts = notice.batches.map((batch) => batch.verdict)
  if (verdicts.some((verdict) => verdict === 'rejected')) {
    const rejected = notice.batches.filter((batch) => batch.verdict === 'rejected')
    return { key: 'rejected', text: `有 ${rejected.length} 批整批退换，不得入库` }
  }
  if (verdicts.some((verdict) => verdict === 'pending')) {
    return { key: 'pending', text: '抽检结论未出，禁止入库' }
  }
  const allInbound = notice.batches.every(
    (batch) => !pendingItems.value.some((item) => item.batchId === batch.id),
  )
  return allInbound
    ? { key: 'done', text: '全部合格并已入库' }
    : { key: 'accepted', text: '合格放行，待入库' }
}

function addBatchRow() {
  regForm.batches.push({ batchNo: '', boxCount: null })
}

function removeBatchRow(index: number) {
  if (regForm.batches.length === 1) {
    return
  }
  regForm.batches.splice(index, 1)
}

function submitRegister() {
  const result = registerNotice({
    noticeNo: regForm.noticeNo,
    supplier: regForm.supplier,
    moduleModel: regForm.moduleModel,
    boxCount: Number(regForm.boxCount),
    arrivedAt: regForm.arrivedAt,
    operator,
    batches: regForm.batches.map((row) => ({ batchNo: row.batchNo, boxCount: Number(row.boxCount) })),
  })
  if (!result.ok) {
    reload(result.message, false)
    return
  }
  Object.assign(regForm, {
    noticeNo: '',
    supplier: '',
    moduleModel: '',
    boxCount: null,
    batches: [{ batchNo: '', boxCount: null }],
  })
  showRegister.value = false
  if (result.data) {
    expanded.value = result.data.id
  }
  reload(result.message, true)
}

function confirmOne(batchId: string) {
  const result = confirmInbound([batchId], operator)
  reload(result.message, result.ok)
}

onMounted(() => reload())
</script>
