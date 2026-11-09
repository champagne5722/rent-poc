// 通知模組的公開介面（MIL-120）。其他模組只從這裡匯入。
export { notify, NotifyInputError, type NotifyInput, type NotifyReceipt } from './notify';
export { countUnread, listNotifications, markAllRead, markRead, type NotificationView } from './store';
export { dispatchNotificationEmail, drainNotificationEmails, type DispatchDeps, type DispatchResult } from './dispatch';
