/**
 * 组件到货验收的放行标准（抽样口径）。
 *
 * 沿用现场既有的那一套：GB/T 2828.1《计数抽样检验程序》一般检查水平 II、
 * 正常检验一次抽样方案，抽样单位为「箱」，按批次独立开箱抽检。
 *
 * 缺陷分两类，分别判定：
 * - A 类（致命）：隐裂、碎片、EL 异常、断栅、电性能失效等。AQL = 0，
 *   即 Ac = 0 / Re = 1：抽箱中只要出现 1 箱（1 片）即整批拒收退换。
 * - B 类（轻微）：外观划伤、标牌缺失、包装轻微破损等。AQL = 2.5，
 *   按批量查下表的 Ac / Re：不合格箱数 ≤ Ac 合格放行，≥ Re 整批退换。
 *
 * 下表为按字码表与箭头规则落地后的一次抽样方案（开箱数 ≥ 批量时整批全检，
 * Ac/Re 不变）。页面与服务只允许引用这里的结果，不得另写一套。
 */

export type SamplingPlan = {
  /** 批量（箱）下限，含 */
  min: number
  /** 批量（箱）上限，含；Infinity 表示无上限 */
  max: number
  /** 样本量字码 */
  code: string
  /** 应开箱抽检数量 */
  sampleSize: number
  /** B 类合格判定数 */
  accept: number
  /** B 类不合格判定数 */
  reject: number
}

// A 类（致命缺陷，含隐裂）：AQL 0，抽中即退，全表通用。
export const CLASS_A_AQL = 0
export const CLASS_A_ACCEPT = 0
export const CLASS_A_REJECT = 1
export const CLASS_B_AQL = 2.5

export const SAMPLING_PLANS: SamplingPlan[] = [
  { min: 2, max: 8, code: 'B', sampleSize: 2, accept: 0, reject: 1 },
  { min: 9, max: 15, code: 'C', sampleSize: 3, accept: 0, reject: 1 },
  { min: 16, max: 25, code: 'D', sampleSize: 5, accept: 0, reject: 1 },
  { min: 26, max: 50, code: 'E', sampleSize: 8, accept: 0, reject: 1 },
  { min: 51, max: 90, code: 'F', sampleSize: 13, accept: 1, reject: 2 },
  { min: 91, max: 150, code: 'G', sampleSize: 20, accept: 1, reject: 2 },
  { min: 151, max: 280, code: 'H', sampleSize: 32, accept: 2, reject: 3 },
  { min: 281, max: 500, code: 'J', sampleSize: 50, accept: 3, reject: 4 },
  { min: 501, max: 1200, code: 'K', sampleSize: 80, accept: 5, reject: 6 },
  { min: 1201, max: 3200, code: 'L', sampleSize: 125, accept: 7, reject: 8 },
  { min: 3201, max: 10000, code: 'M', sampleSize: 200, accept: 10, reject: 11 },
  { min: 10001, max: 35000, code: 'N', sampleSize: 315, accept: 14, reject: 15 },
  { min: 35001, max: Infinity, code: 'P', sampleSize: 500, accept: 21, reject: 22 },
]

export type Verdict = 'pending' | 'accepted' | 'rejected'

export type BatchVerdictInput = {
  /** 批次总箱数 */
  boxCount: number
  /** 实际开箱数 */
  openedBoxes: number
  /** A 类（含隐裂）不合格箱数 */
  classABadBoxes: number
  /** B 类（轻微）不合格箱数 */
  classBBadBoxes: number
}

export type BatchVerdictResult = {
  plan: SamplingPlan
  /** 实际应检箱数（全检时等于批量） */
  requiredBoxes: number
  verdict: Verdict
  /** 未放行原因（空表示具备放行条件 / 已合格） */
  reasons: string[]
}

/** 按批量查抽样方案；批量 1 箱没有抽样意义，按全检处理。 */
export function planForLot(boxCount: number): SamplingPlan {
  const plan = SAMPLING_PLANS.find((item) => boxCount >= item.min && boxCount <= item.max)
  if (plan) {
    return plan
  }
  // 1 箱及以下：全检，致命缺陷零容忍，轻微不合格也整批退。
  return { min: 0, max: 1, code: '全检', sampleSize: 1, accept: 0, reject: 1 }
}

/**
 * 判定一个批次是否放行。开箱不足、抽检数对不上等情况一律按「结论未出」挡住，
 * 不允许出合格结论。
 */
export function evaluateBatch(input: BatchVerdictInput): BatchVerdictResult {
  const plan = planForLot(input.boxCount)
  const requiredBoxes = Math.min(plan.sampleSize, input.boxCount)
  const reasons: string[] = []

  if (input.openedBoxes < requiredBoxes) {
    reasons.push(`开箱数不足：本批 ${input.boxCount} 箱应开 ${requiredBoxes} 箱，实开 ${input.openedBoxes} 箱`)
  }
  if (input.openedBoxes > input.boxCount) {
    reasons.push(`开箱数 ${input.openedBoxes} 超过批量 ${input.boxCount}，抽检记录有误`)
  }

  // 开箱/计数还不完整：结论未出，不入库。
  if (reasons.length > 0) {
    return { plan, requiredBoxes, verdict: 'pending', reasons }
  }

  const inspected = Math.min(input.openedBoxes, requiredBoxes)
  if (input.classABadBoxes + input.classBBadBoxes > inspected) {
    reasons.push(`不合格箱数合计 ${input.classABadBoxes + input.classBBadBoxes} 超过实际开箱数 ${inspected}`)
    return { plan, requiredBoxes, verdict: 'pending', reasons }
  }

  if (input.classABadBoxes > CLASS_A_ACCEPT) {
    reasons.push(
      `A 类（隐裂/碎片/EL 异常等致命缺陷）抽中 ${input.classABadBoxes} 箱，AQL=${CLASS_A_AQL} 零容忍，整批退换`,
    )
    return { plan, requiredBoxes, verdict: 'rejected', reasons }
  }

  if (input.classBBadBoxes >= plan.reject) {
    reasons.push(
      `B 类（轻微缺陷）不合格 ${input.classBBadBoxes} 箱 ≥ Re=${plan.reject}（Ac=${plan.accept}），整批退换`,
    )
    return { plan, requiredBoxes, verdict: 'rejected', reasons }
  }

  return { plan, requiredBoxes, verdict: 'accepted', reasons: [] }
}

/** 每只开箱至少 1 张抽检照片（开箱、外观、EL），照片未齐不得出结论。 */
export function requiredPhotos(boxCount: number): number {
  return Math.min(planForLot(boxCount).sampleSize, boxCount)
}
