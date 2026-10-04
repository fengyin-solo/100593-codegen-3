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

    <section class="inbound-box">
      <h3>待入库清单（到货验收放行件）</h3>
      <p class="inbound-hint">
        清单直接来自到货验收已放行、仓库尚未确认的批次，与验收页读到的待入库数量是同一份；确认后片数累加进下方备件台账。
      </p>
      <table class="data-table">
        <thead>
          <tr><th>到货单号</th><th>供应商</th><th>组件型号</th><th>待入库片数</th><th>放行日期</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in pendingItems" :key="item.arrivalId">
            <td>{{ item.arrivalNo }}</td>
            <td>{{ item.supplier }}</td>
            <td>{{ item.moduleModel }}</td>
            <td><strong>{{ item.pieces }}</strong> 片</td>
            <td>{{ item.releaseDate }}</td>
            <td><button class="btn primary" type="button" @click="confirmStock(item.arrivalId)">确认入库</button></td>
          </tr>
          <tr v-if="!pendingItems.length">
            <td colspan="6" class="empty-state">暂无放行待入库的组件，到货验收放行后会出现在这里</td>
          </tr>
        </tbody>
      </table>
      <p class="inbound-total">待入库合计：<strong>{{ pendingTotal }}</strong> 片</p>
    </section>

    <h3 class="section-title">备件台账</h3>

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
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { confirmInbound, listPendingInbound, type PendingInboundItem } from '@/api/arrival-service'
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

const pendingItems = ref<PendingInboundItem[]>([])
const pendingTotal = computed(() => pendingItems.value.reduce((sum, item) => sum + item.pieces, 0))

function loadPending() {
  pendingItems.value = listPendingInbound()
}

function confirmStock(arrivalId: number) {
  errorMessage.value = ''
  const result = confirmInbound(arrivalId)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  errorMessage.value = result.message
  loadPending()
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    loadPending()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '备品备件列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.inbound-box {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 16px;
}
.inbound-box h3 { margin: 0 0 6px; font-size: 15px; }
.inbound-hint { color: var(--muted); font-size: 12.5px; margin: 0 0 10px; }
.inbound-total { margin: 8px 0 0; font-size: 13px; text-align: right; }
.section-title { font-size: 15px; margin: 14px 0 8px; }
</style>
