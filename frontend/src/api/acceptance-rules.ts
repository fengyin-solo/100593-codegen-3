/**
 * 组件到货验收放行标准。
 *
 * 抽样口径沿用既有的来料检验一套：GB/T 2828.1-2012（等同 ISO 2859-1）
 * 一般检查水平 II、正常检验、一次抽样方案，接收质量限 AQL=2.5。
 * 抽样单位为「箱」：批箱数查样本量字码表定字码，再按字码查 AQL=2.5 的一次抽样方案。
 * 表里的箭头按标准口径处理——沿箭头方向找到第一个抽样方案，样本量随被引用方案；
 * 若样本量不小于批量，则对该批全检。
 *
 * 致命缺陷（隐裂、破片、背板穿透等）按 AQL=0 单判：抽箱中只要出现 1 箱即整批退换，
 * 不允许与一般缺陷混判成合格。
 */

export type InspectionPlan = {
  /** 批量（本批箱数） */
  lotSize: number
  /** 样本量字码 */
  codeLetter: string
  /** 应抽箱数（全检时等于批量） */
  sampleSize: number
  /** 样本量不小于批量时全检 */
  fullInspection: boolean
  /** 一般不合格接收质量限 */
  aql: number
  /** 合格判定数 Ac */
  acceptNumber: number
  /** 不合格判定数 Re */
  rejectNumber: number
  /** 抽检比例（展示用） */
  ratioLabel: string
}

type CodeLetterRow = { letter: string; maxLot: number }

// 一般检查水平 II 的批量-字码对照（GB/T 2828.1 表1）
const CODE_LETTER_TABLE: CodeLetterRow[] = [
  { letter: 'A', maxLot: 1 },
  { letter: 'B', maxLot: 8 },
  { letter: 'C', maxLot: 15 },
  { letter: 'D', maxLot: 25 },
  { letter: 'E', maxLot: 50 },
  { letter: 'F', maxLot: 90 },
  { letter: 'G', maxLot: 150 },
  { letter: 'H', maxLot: 280 },
  { letter: 'J', maxLot: 500 },
  { letter: 'K', maxLot: 1200 },
  { letter: 'L', maxLot: 3200 },
  { letter: 'M', maxLot: 10000 },
  { letter: 'N', maxLot: 35000 },
  { letter: 'P', maxLot: 150000 },
  { letter: 'Q', maxLot: 500000 },
  { letter: 'R', maxLot: Number.POSITIVE_INFINITY },
]

// AQL=2.5 正常检验一次抽样方案（表2-A 的箭头已按标准指向被引用方案）
const PLAN_BY_LETTER: Record<string, { sample: number; ac: number }> = {
  A: { sample: 5, ac: 0 }, // ↓ 沿箭头落到 C
  B: { sample: 5, ac: 0 }, // ↓ 沿箭头落到 C
  C: { sample: 5, ac: 0 },
  D: { sample: 5, ac: 0 }, // ↑ 沿箭头引用 C
  E: { sample: 5, ac: 0 }, // ↑ 沿箭头引用 C
  F: { sample: 20, ac: 1 },
  G: { sample: 32, ac: 2 },
  H: { sample: 50, ac: 3 },
  J: { sample: 80, ac: 5 },
  K: { sample: 125, ac: 7 },
  L: { sample: 200, ac: 10 },
  M: { sample: 315, ac: 14 },
  N: { sample: 315, ac: 14 }, // ↑ 沿箭头引用 M
  P: { sample: 315, ac: 14 },
  Q: { sample: 315, ac: 14 },
  R: { sample: 315, ac: 14 },
}

export const ACCEPTANCE_AQL = 2.5

/** 致命缺陷名称：命中任意一类按 AQL=0 整批退换 */
export const CRITICAL_DEFECTS = ['组件隐裂', '组件破片碎裂', '背板穿透划伤'] as const

/** 一般缺陷名称：按 AQL=2.5 计数判定 */
export const GENERAL_DEFECTS = ['外观划伤变形', '接线盒/线缆缺陷', '铭牌包装缺陷'] as const

export const ACCEPTANCE_STANDARD_TEXT =
  'GB/T 2828.1-2012 一般检查水平 II · 正常检验一次抽样 · AQL=2.5（抽样单位：箱）；致命缺陷（隐裂/破片/背板穿透）AQL=0，出现 1 箱即整批退换'

export function codeLetterForLot(lotSize: number): string {
  const row = CODE_LETTER_TABLE.find((item) => lotSize <= item.maxLot)
  return row ? row.letter : 'R'
}

/** 按批箱数给出抽检方案 */
export function samplingPlan(lotSize: number): InspectionPlan {
  const safeLot = Math.max(1, Math.floor(lotSize))
  const codeLetter = codeLetterForLot(safeLot)
  const raw = PLAN_BY_LETTER[codeLetter] ?? { sample: 315, ac: 14 }
  const fullInspection = raw.sample >= safeLot
  const sampleSize = fullInspection ? safeLot : raw.sample
  const ratio = (sampleSize / safeLot) * 100
  return {
    lotSize: safeLot,
    codeLetter,
    sampleSize,
    fullInspection,
    aql: ACCEPTANCE_AQL,
    acceptNumber: raw.ac,
    rejectNumber: raw.ac + 1,
    ratioLabel: ratio >= 100 ? '全检' : `约 ${ratio.toFixed(1)}%`,
  }
}

export type BatchVerdict = {
  /** 合格放行 / 整批退换 */
  conclusion: '合格放行' | '整批退换'
  /** 判定依据说明 */
  reason: string
}

/**
 * 按致命/一般不合格箱数出整批结论。
 * @param plan 抽检方案
 * @param criticalBoxes 致命缺陷不合格箱数（AQL=0）
 * @param generalBoxes 一般不合格箱数（对照 Ac/Re）
 */
export function evaluateBatch(
  plan: InspectionPlan,
  criticalBoxes: number,
  generalBoxes: number,
): BatchVerdict {
  if (criticalBoxes > 0) {
    return {
      conclusion: '整批退换',
      reason: `抽检 ${plan.sampleSize} 箱发现 ${criticalBoxes} 箱存在致命缺陷（隐裂/破片/背板穿透），AQL=0 一票否决，整批退换`,
    }
  }
  if (generalBoxes > plan.acceptNumber) {
    return {
      conclusion: '整批退换',
      reason: `一般不合格 ${generalBoxes} 箱 ≥ Re ${plan.rejectNumber}（Ac=${plan.acceptNumber}），超出 AQL=2.5 允许范围，整批退换`,
    }
  }
  return {
    conclusion: '合格放行',
    reason: `无致命缺陷，一般不合格 ${generalBoxes} 箱 ≤ Ac ${plan.acceptNumber}，在 AQL=2.5 允许范围内，合格放行`,
  }
}
