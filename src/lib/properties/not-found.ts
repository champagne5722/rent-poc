import { jsonError } from '../http';

/** 格式錯誤的 ID、別的組織的 ID、不存在的 ID，三者的回應必須逐位元相同（P0-02 AC1），統一從這裡出。 */
export const propertyNotFound = () => jsonError(404, '物件不存在');
