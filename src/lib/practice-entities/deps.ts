import { getFileStore } from '../file-store';
import { getMailer } from '../mailer';
import type { FlowDeps } from './flows';

/** production 的相依：general 用途的 FileStore 與目前的寄信 adapter。 */
export function defaultFlowDeps(): FlowDeps {
  return { store: getFileStore('general'), mailer: getMailer(), now: () => new Date() };
}
