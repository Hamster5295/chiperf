# chiperf

这是 `chiperf` 文件格式规范与部分工具链的共同仓库

`chiperf` 是一个新制定的文件规范。该规范旨在让微架构仿真器，或 RTL 仿真器，以简单的格式输出内部状态信息到特定文件，从而在另一侧复用解析器与可视化器，进行定制化的微架构调试与性能分析。

在文档中，一般采用首字母大写 `Chiperf` 称呼本项目, 用首字母小写 `chiperf` 指代符合规范的 **文件 / 文件类型**


## 文件地图

- `.agent`: LLM Agent 在开发中需要遵循的各个规则，包括 Git 提交规范等
- `.github`: ci, 用于自动部署 Github Pages
- `docs`: `chiperf` `Chiperf` 定义与 Spec 文档，以 `vitepress` 组织为网页
- `src/parser`: `Typescript` 编写的 `chiperf` 解析器
- `src/frontend`: 一个调用解析器，对 `chiperf` 进行可视化的网页实现
