import { saveContractFilesOnCompleted } from '../contract-files';
import { dsClientSecret, dsFetch, isMockMode } from '../dottedsign';
import { createDottedSignProvider } from './dottedsign-adapter';
import { createMockProvider } from './mock-adapter';
import { createSigningModule } from './module';
import type { SigningSubject } from './provider';

// route handler 的入口。依環境變數選 adapter。
// contract-files.ts 仍有自己的 mock 特例，留給文件保存那張票。
export const signing = createSigningModule({
  provider: isMockMode()
    ? createMockProvider()
    : createDottedSignProvider({ request: dsFetch, clientSecret: dsClientSecret() }),
  onCompleted: saveContractFilesOnCompleted,
});

export function contractSubject(id: number): SigningSubject {
  return { type: 'contract', id };
}

export { signingErrorResponse } from './module';
