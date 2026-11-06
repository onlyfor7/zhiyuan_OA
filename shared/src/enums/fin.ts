/** 迭代 9d 财务核算域枚举（arch/12 §7.2，冻结） */

/** 应收状态：open/partial/settled（逾期为查询口径计算列，不落库） */
export const RECEIVABLE_STATUS = ["open", "partial", "settled"] as const;
export type ReceivableStatus = (typeof RECEIVABLE_STATUS)[number];

/** 发票状态机：draft → issued → sent / voided（红冲=voided+冲正行） */
export const INVOICE_STATUS = ["draft", "issued", "sent", "voided"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUS)[number];
