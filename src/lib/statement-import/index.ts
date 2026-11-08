// 對帳檔匯入純函式模組（MIL-157）。只匯出純函式與型別，不碰資料庫。

export { detectEncoding, decodeStatement } from './encoding';
export { parseStatementCsv, parseStatementDate, parseStatementAmount } from './parse';
export type { AmountParse } from './parse';
export { externalIdFor } from './external-id';
export { matchStatementRow, CROSS_SOURCE_DUPLICATE_WINDOW_DAYS } from './match';
export type { MatchOptions } from './match';
export { validateSplit } from './split';
export type {
  AmountMapping,
  CaseFacts,
  ColumnMapping,
  DepositFacts,
  HolderRuleAction,
  ManualReceiptFact,
  MatchFacts,
  MatchResult,
  ParseError,
  ParseErrorCode,
  ParseStatementResult,
  RemitterIdentifier,
  RentalPurpose,
  SplitFailureReason,
  SplitPart,
  SplitResult,
  StatementEncoding,
  StatementRow,
  UnmatchedReason,
} from './types';
