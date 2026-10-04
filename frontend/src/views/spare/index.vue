<template>
  <section class="page" data-module="spare">
    <header class="page-head">
      <div>
        <h2>备品备件管理</h2>
        <p class="page-desc">维护备品备件，围绕备件编号、备件名称、适用设备、规格型号做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记备品备件</button>
        <button class="btn" type="button" @click="exportRows">导出备品备件清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <!-- 到货验收入库结论：直接读 receiving-store 的待入库清单，与到货验收页同一份数量 -->
    <article class="inbound-card">
      <header class="batch-edit-head">
        <strong>组件到货·待入库清单（来源：到货验收）</strong>
        <span class="batch-text">共 {{ inboundItems.length }} 批 / {{ inboundBoxes }} 箱</span>
      </header>
      <table v-if="inboundItems.length" class="data-table">
        <thead>
          <tr>
            <th>到货单号</th><th>供应商</th><th>组件型号</th><th>批次号</th>
            <th>入库数量(箱)</th><th>到货日期</th><th>放行时间</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in inboundItems" :key="item.batchId">
            <td>{{ item.noticeNo }}</td>
            <td>{{ item.supplier }}</td>
            <td>{{ item.moduleModel }}</td>
            <td>{{ item.batchNo }}</td>
            <td><strong>{{ item.boxCount }}</strong></td>
            <td>{{ item.arrivedAt }}</td>
            <td>{{ item.acceptedAt }}</td>
            <td>
              <RouterLink class="link" :to="`/receiving`">查看验收记录</RouterLink>
              <button class="link" type="button" @click="confirmInboundOne(item.batchId)">确认入库</button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty-state">暂无到货验收合格放行、等待入库的批次</p>
      <p v-if="inboundMessage" class="batch-text" :class="inboundOk ? 'ok' : 'warn'">{{ inboundMessage }}</p>
    </article>

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
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无备品备件数据，可先登记备品备件</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条备品备件记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  confirmInbound,
  pendingInbound,
} from '@/data/receiving-store'
import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('spare')
const columns = ["备件编号", "备件名称", "适用设备", "规格型号", "现有数量", "安全存量", "存放库位", "备件状态"]
const actions = ["申请补充", "提交检验", "办理领用"]
const statuses = ["数量充足", "待补充", "待检验", "已停用"]
const stats = [{"label": "备件品类", "value": 0}, {"label": "待补充品类", "value": 0}, {"label": "低于安全存量", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

// 待入库清单与到货验收页读同一个函数，入库数量只有这一套。
const inboundItems = ref(pendingInbound())
const inboundBoxes = computed(() =>
  inboundItems.value.reduce((sum, item) => sum + item.boxCount, 0),
)
const inboundMessage = ref('')
const inboundOk = ref(false)

function confirmInboundOne(batchId: string) {
  const result = confirmInbound([batchId], '值班管理员')
  inboundMessage.value = result.message
  inboundOk.value = result.ok
  inboundItems.value = pendingInbound()
}
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '备品备件登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  inboundItems.value = pendingInbound()
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '备品备件列表读取失败'
  }
}

onMounted(reload)
</script>
