# 前端採用 React ＋ 官方 Ant Design，而非 Vue

原始需求寫「框架可以先用 Vue」，但指定的 UI 套件 [ant-design/ant-design](https://github.com/ant-design/ant-design) 是 React 專用。經與使用者確認（2026-07-23 grilling），決定改用 **React ＋ 官方 antd**，捨棄 Vue ＋ ant-design-vue 的組合，以直接使用官方套件、並讓 PoC 更容易交接給 React 技術棧的開發團隊。

## Considered Options

- Vue 3 ＋ ant-design-vue（社群版）：保住原前提，但非官方維護。
- React ＋ 官方 antd（採用）。
